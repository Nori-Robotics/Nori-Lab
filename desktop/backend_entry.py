"""Frozen entry point for the LeLab desktop bundle (PyInstaller).

Two responsibilities:

1. Child-module dispatch. Inside a bundle `sys.executable` is THIS binary, so
   `lelab.rollout` / anything using `lelab.utils.child_process.module_cmd` spawns
   `<this-exe> _child lerobot.scripts.lerobot_rollout <args...>`. We intercept
   that here and run the requested module via runpy, exactly as `python -m` would.

2. Server boot. With no `_child` sentinel we start uvicorn on 127.0.0.1:8000,
   serving the API + the bundled frontend/dist. The Tauri shell owns the window
   and the browser; this process is headless (no webbrowser.open, no Vite).
"""

from __future__ import annotations

import multiprocessing
import os
import runpy
import sys
import threading
import time

# Must match lelab.utils.child_process.CHILD_DISPATCH_FLAG.
CHILD_DISPATCH_FLAG = "_child"
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000


def _install_parent_death_watchdog() -> None:
    """Exit this backend if the parent (the Tauri shell) goes away.

    The Rust side kills us on a *clean* window close, but a Ctrl+C on `tauri dev`,
    a crash, or a force-quit never fires that handler — which orphans this process
    still listening on :8000 and blocks the next launch. Polling getppid() catches
    every one of those cases: when the parent dies we are reparented (to launchd /
    init), so our parent PID changes from what it was at startup. At that point we
    hard-exit so the OS reclaims the socket immediately.

    Server path only — `_child` subprocesses are short-lived and owned by the running
    backend's own subprocess management, so they don't get this.

    Set NORI_DISABLE_PARENT_WATCHDOG=1 to opt out (needed when running the backend as a
    bare background job for tests, where the launcher reparents us and the watchdog would
    otherwise exit immediately). The Tauri shell never sets it, so the app stays protected.
    """
    if os.environ.get("NORI_DISABLE_PARENT_WATCHDOG"):
        return
    initial_ppid = os.getppid()

    def _watch() -> None:
        while True:
            time.sleep(1.0)
            # Reparented (parent died) — includes the ppid==1 case. Free the port now.
            if os.getppid() != initial_ppid:
                os._exit(0)

    threading.Thread(target=_watch, name="parent-death-watchdog", daemon=True).start()


def _load_adjacent_env() -> None:
    """Load a `.env` sitting next to the frozen executable, if present.

    A shipped desktop app has no repo-root `.env`, and the frozen backend's working
    directory is `resources/backend/` (set by the Tauri shell), not the repo — so
    lelab's own `load_dotenv()` finds nothing and cloud config is empty. Dropping a
    small PUBLIC-config `.env` next to the binary (SUPABASE_URL, SUPABASE_ANON_KEY,
    NORI_BACKEND_URL — all browser-safe, NEVER service-role/Anthropic keys) is how the
    bundle self-configures. `override=False`: a real exported env var still wins, so
    `export SUPABASE_URL=… ; tauri dev` keeps working for local testing.

    Must run before `lelab` is imported, since `lelab.utils.config` reads these at
    import time. The `_child` path skips this — it's spawned by the already-running
    backend, which has the env in-process.
    """
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    env_path = os.path.join(exe_dir, ".env")
    if not os.path.exists(env_path):
        return
    try:
        from dotenv import load_dotenv

        load_dotenv(env_path, override=False)
    except ImportError:  # dotenv is bundled (config.py needs it), but fail soft anyway.
        pass


def _run_child_module() -> None:
    """Emulate `python -m <module> <args>` for a bundled subprocess call."""
    module = sys.argv[2]
    # Present argv to the target as if it were invoked directly, so draccus /
    # argparse inside the lerobot script parse the flags that follow.
    sys.argv = [module, *sys.argv[3:]]
    runpy.run_module(module, run_name="__main__", alter_sys=True)


def main() -> None:
    # Required first: PyInstaller + multiprocessing (lerobot dataloaders, torch)
    # would otherwise re-bootstrap the whole app in each worker.
    multiprocessing.freeze_support()

    if len(sys.argv) >= 3 and sys.argv[1] == CHILD_DISPATCH_FLAG:
        _run_child_module()
        return

    # HF cache etc. resolve from $HOME; nothing else to set up — config.py owns paths.
    os.environ.setdefault("PYTHONUNBUFFERED", "1")

    # Don't outlive the Tauri shell that spawned us (prevents an orphan on :8000).
    _install_parent_death_watchdog()

    import uvicorn

    uvicorn.run(
        "lelab.server:app",
        host=BACKEND_HOST,
        port=BACKEND_PORT,
        log_level="info",
        reload=False,
        timeout_graceful_shutdown=2,
    )


if __name__ == "__main__":
    main()
