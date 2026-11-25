"""Run this laptop's policy-agent checkout on demand for its signed-in operator."""

import hashlib
import os
import secrets
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from fastapi import HTTPException

from .nori_client import NoriClient


class LocalAspire:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None
        self.directory = None
        self.verified = None
        self.operator_email = None

    def close(self):
        with self.lock:
            self._stop()

    def _stop(self):
        if self.process is not None:
            self.process.stdin.close()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.process = None
        self.operator_email = None
        self.verified = None
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None

    def client(self, cloud: NoriClient) -> NoriClient:
        from dotenv import dotenv_values

        if not cloud.jwt:
            raise HTTPException(401, "Sign in to Nori to use the local agent.")
        with self.lock:
            starting = self.process is None or self.process.poll() is not None
            if starting:
                self._stop()
                settings = dotenv_values(Path.home() / ".config/nori/sdk.env")
                env = {**{k: v for k, v in settings.items() if v is not None}, **os.environ}
                email = env.get("NORI_EMAIL", "").strip().casefold()
            else:
                email = self.operator_email
            # Cache a successful account check across the page's one-second polls.
            identity = (hashlib.sha256(cloud.jwt.encode()).digest(), email)
            if not self.verified or self.verified[0] != identity or self.verified[1] <= time.monotonic():
                profile = cloud.get_customer()
                if not email or (profile.get("email") or "").strip().casefold() != email:
                    raise HTTPException(403, "Sign in with the Nori account configured in ~/.config/nori/sdk.env.")
                self.verified = (identity, time.monotonic() + 60)
            if starting:
                self._start(env)
                self.operator_email = email
            return NoriClient(jwt=self.token, base_url="http://localhost", aspire_tasks="/tasks",
                              socket_path=self.socket_path)

    def _start(self, env):
        root = Path(env["NORI_LOCAL_AGENT_ROOT"]).expanduser().resolve()
        python = Path(env.get("NORI_LOCAL_AGENT_PYTHON") or root / "sim/.venv-mujoco/bin/python").expanduser()
        if not (root / "synthesis/aspire_service/server.py").is_file() or not python.is_file():
            raise HTTPException(503, "Check NORI_LOCAL_AGENT_ROOT and NORI_LOCAL_AGENT_PYTHON in LeLab's .env.")
        self.directory = tempfile.TemporaryDirectory(prefix="lelab-agent-")
        self.socket_path = str(Path(self.directory.name) / "worker.sock")
        self.token = secrets.token_urlsafe(32)
        env.update(ASPIRE_LOCAL_TOKEN=self.token, NORI_BACKEND_URL=NoriClient().base_url)
        try:
            self.process = subprocess.Popen(
                [str(python), "-m", "synthesis.aspire_service.server", "--lelab-socket", self.socket_path],
                cwd=root, env=env, stdin=subprocess.PIPE,
            )
            deadline = time.monotonic() + 10
            while self.process.poll() is None and time.monotonic() < deadline:
                if Path(self.socket_path).is_socket():
                    return
                time.sleep(0.05)
        except OSError as exc:
            self._stop()
            raise HTTPException(503, f"Could not launch the local agent: {exc}") from exc
        self._stop()
        raise HTTPException(503, "The local agent did not start. See the LeLab terminal for the worker error.")


local_agent = LocalAspire()
