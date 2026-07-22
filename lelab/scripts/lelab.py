# Copyright 2025 The HuggingFace Inc. team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
LeLab launcher.

Default mode: starts the FastAPI backend on :8000, which serves the
pre-built frontend at /. Opens the user's browser to the local app.

--dev mode: spawns the Vite dev server (frontend/, port 8080) for HMR
and starts uvicorn with --reload. Opens the browser to :8080.
"""

import argparse
import atexit
import contextlib
import logging
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from pathlib import Path

import psutil
import uvicorn

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent.parent
FRONTEND_PATH = PROJECT_ROOT / "frontend"
FRONTEND_DIST = FRONTEND_PATH / "dist"
BACKEND_PORT = 8000
FRONTEND_DEV_PORT = 8080

# Substrings that mark a listener as a leftover from a previous LeLab run, so
# _reclaim_port can reclaim it. Anything NOT matching one of these is treated as
# an unrelated program and left alone (we refuse to kill a stranger's process).
_OURS_MARKERS = ("uvicorn", "lelab", "vite", "esbuild")


def _looks_ours(proc: "psutil.Process") -> bool:
    """True if this process — or any ancestor — is a LeLab/Vite process. The
    ancestry walk matters because a uvicorn --reload WORKER has a generic
    `multiprocessing.spawn` cmdline; only its parent names uvicorn/lelab."""
    depth = 0
    cur: psutil.Process | None = proc
    while cur is not None and depth < 12:
        try:
            cmdline = " ".join(cur.cmdline()).lower()
            if any(m in cmdline for m in _OURS_MARKERS):
                return True
            cur = cur.parent()
        except psutil.Error:
            return False
        depth += 1
    return False


def _pids_listening_on(port: int) -> list[int]:
    """PIDs of processes with a LISTEN socket on `port`, among those this user
    can inspect. macOS blocks a system-wide net_connections() without root, so
    we scan per-process (our own children are always inspectable)."""
    pids: list[int] = []
    for proc in psutil.process_iter(["pid"]):
        try:
            for conn in proc.net_connections(kind="inet"):
                if (
                    conn.status == psutil.CONN_LISTEN
                    and conn.laddr
                    and conn.laddr.port == port
                ):
                    pids.append(proc.pid)
                    break
        except (psutil.AccessDenied, psutil.NoSuchProcess, psutil.ZombieProcess):
            continue
    return pids


def _reclaim_port(port: int, label: str) -> None:
    """Ensure `port` is free before we try to bind it.

    A previous run that was hard-killed (or a uvicorn --reload worker that
    outlived its parent) can keep the port bound and make the next launch fail
    with 'Address already in use'. We stop any leftover LeLab/Vite process
    holding it — including child workers — then confirm the port is actually
    free. An unrelated process on the port is reported, not killed."""
    my_pid = os.getpid()
    pids = [p for p in _pids_listening_on(port) if p != my_pid]
    if not pids:
        return

    for pid in pids:
        try:
            proc = psutil.Process(pid)
        except psutil.Error:
            continue  # already gone (e.g. killed as a child of an earlier pid)

        if not _looks_ours(proc):
            try:
                cmdline = " ".join(proc.cmdline()) or "<unknown>"
            except psutil.Error:
                cmdline = "<unknown>"
            logger.error(
                "❌ Port %d (%s) is held by PID %d, which does not look like a "
                "previous LeLab run:\n     %s\n"
                "   Refusing to kill it. Stop that process or free the port, then "
                "retry (to inspect: `lsof -nP -iTCP:%d -sTCP:LISTEN`).",
                port, label, pid, cmdline, port,
            )
            sys.exit(1)

        logger.warning(
            "♻️  Port %d (%s) still held by a previous run (PID %d) — stopping it...",
            port, label, pid,
        )
        # Kill the whole tree: a uvicorn --reload parent's worker child is the
        # one actually holding the socket, so terminating just the parent leaves
        # the port bound.
        try:
            victims = [proc, *proc.children(recursive=True)]
        except psutil.Error:
            victims = [proc]
        for v in victims:
            with contextlib.suppress(psutil.Error):
                v.terminate()
        _gone, alive = psutil.wait_procs(victims, timeout=5)
        for v in alive:
            with contextlib.suppress(psutil.Error):
                v.kill()

    # Sockets can linger a beat after the process dies; poll briefly for release.
    for _ in range(20):
        if not [p for p in _pids_listening_on(port) if p != my_pid]:
            return
        time.sleep(0.25)
    logger.error(
        "❌ Port %d (%s) is still in use after cleanup — a process may be "
        "respawning it. Inspect with `lsof -nP -iTCP:%d -sTCP:LISTEN`.",
        port, label, port,
    )
    sys.exit(1)


def _wait_for_port(port: int, timeout: int = 30) -> bool:
    for _ in range(timeout):
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(1)
        result = sock.connect_ex(("localhost", port))
        sock.close()
        if result == 0:
            return True
        time.sleep(1)
    return False


def _tokened_url(port: int) -> str:
    """Launch URL carrying the local API token (see lelab/local_auth.py): the
    server exchanges `?token=` for the auth cookie on first load. `main()`
    guarantees LELAB_TOKEN is set before any server starts."""
    token = os.environ.get("LELAB_TOKEN", "")
    return f"http://localhost:{port}/" + (f"?token={token}" if token else "")


def _open_browser_when_ready():
    """Background-thread helper: poll the port, open the browser when up."""
    for _ in range(60):
        try:
            with socket.create_connection(("127.0.0.1", BACKEND_PORT), timeout=0.5):
                pass
        except OSError:
            time.sleep(0.5)
            continue
        logger.info("🌐 Opening browser...")
        webbrowser.open(_tokened_url(BACKEND_PORT))
        return


def _run_prod():
    """Serve built frontend from backend on a single port."""
    if not FRONTEND_DIST.exists():
        logger.error(f"❌ Built frontend not found at {FRONTEND_DIST}")
        logger.error("   Run `npm run build` in frontend/ first, or use `lelab --dev`.")
        sys.exit(1)

    # Reclaim :8000 from any leftover run so this launch never dies on bind.
    _reclaim_port(BACKEND_PORT, "backend")

    logger.info("🚀 Starting LeLab on http://localhost:%d ...", BACKEND_PORT)
    # Printed for manual opens (other browser / another device): the token in the
    # URL is what authenticates the browser to the local API.
    logger.info("   Open in a browser: %s", _tokened_url(BACKEND_PORT))

    threading.Thread(target=_open_browser_when_ready, daemon=True).start()

    # Run uvicorn in the main thread so its native SIGINT handler works,
    # and bound graceful shutdown so a stuck WebSocket can't hang Ctrl+C.
    uvicorn.run(
        "lelab.server:app",
        host="127.0.0.1",
        port=BACKEND_PORT,
        log_level="info",
        reload=False,
        timeout_graceful_shutdown=2,
    )


def _run_dev():
    """Vite dev server (HMR) + uvicorn --reload."""
    if not FRONTEND_PATH.exists():
        logger.error(f"❌ Frontend not found at {FRONTEND_PATH}")
        sys.exit(1)

    # Reclaim both ports from any leftover run before we spawn anything.
    _reclaim_port(FRONTEND_DEV_PORT, "frontend")
    _reclaim_port(BACKEND_PORT, "backend")

    logger.info("📦 Installing frontend deps...")
    subprocess.run(["npm", "install"], check=True, cwd=FRONTEND_PATH)

    logger.info("🎨 Starting Vite dev server (port %d)...", FRONTEND_DEV_PORT)
    frontend_process = subprocess.Popen(
        ["npm", "run", "dev"],
        cwd=FRONTEND_PATH,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )

    if not _wait_for_port(FRONTEND_DEV_PORT):
        logger.error("❌ Frontend never came up")
        frontend_process.terminate()
        sys.exit(1)

    logger.info("🚀 Starting backend (port %d) with --reload...", BACKEND_PORT)
    backend_process = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "lelab.server:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(BACKEND_PORT),
            "--reload",
        ],
        cwd=PROJECT_ROOT,
        env=os.environ.copy(),
        start_new_session=True,
    )

    if not _wait_for_port(BACKEND_PORT, timeout=15):
        logger.error("❌ Backend never came up")
        for p in (backend_process, frontend_process):
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
            except Exception:
                p.terminate()
        sys.exit(1)

    logger.info("🌐 Opening browser...")
    # Dev pages live on the Vite origin; the SPA ignores the extra query param
    # today, but carrying it keeps the URL shape identical across modes for when
    # the frontend learns to forward it (merge 2 of the local-auth rollout).
    webbrowser.open(_tokened_url(FRONTEND_DEV_PORT))

    logger.info("✅ Dev mode running — Ctrl+C to stop")
    logger.info("   Frontend: http://localhost:%d", FRONTEND_DEV_PORT)
    logger.info("   Backend:  http://localhost:%d", BACKEND_PORT)

    # Both children run in their own sessions (start_new_session=True), so the
    # terminal's Ctrl+C never reaches them directly — this launcher is the only
    # thing that kills them. Guard cleanup so a rapid second Ctrl+C can't
    # interrupt killpg mid-flight and orphan the detached sessions.
    _shutting_down = threading.Event()

    def _kill_children():
        for p in (backend_process, frontend_process):
            try:
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                except Exception:
                    p.kill()
            except Exception:
                pass

    # Backstop: runs on any normal interpreter exit (including an unhandled
    # exception in the watchdog loop), even if `shutdown` never fires.
    atexit.register(_kill_children)

    def shutdown(signum, frame):
        if _shutting_down.is_set():
            return
        _shutting_down.set()
        # Ignore further Ctrl+C / SIGTERM while we tear down, so mashing ^C
        # can't interrupt cleanup and leave detached orphans behind.
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        logger.info("🛑 Shutting down...")
        _kill_children()
        logger.info("  ✅ backend + frontend stopped")
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while True:
        time.sleep(2)
        if backend_process.poll() is not None:
            logger.error("❌ Backend died")
            shutdown(None, None)
        if frontend_process.poll() is not None:
            logger.error("❌ Frontend died")
            shutdown(None, None)


def main():
    parser = argparse.ArgumentParser(prog="lelab", description="Run LeLab")
    parser.add_argument(
        "--dev",
        action="store_true",
        help="Dev mode: Vite HMR + uvicorn --reload (requires Node.js)",
    )
    args = parser.parse_args()

    # Resolve the local API token BEFORE any server starts: the in-process
    # uvicorn (prod) and the --reload subprocess (dev, env=os.environ.copy())
    # both read LELAB_TOKEN from the environment. setdefault keeps an
    # explicitly-exported LELAB_TOKEN authoritative.
    from lelab.local_auth import get_or_create_local_token

    os.environ.setdefault("LELAB_TOKEN", get_or_create_local_token())

    if args.dev:
        _run_dev()
    else:
        _run_prod()


if __name__ == "__main__":
    main()
