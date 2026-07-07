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

# Must match lelab.utils.child_process.CHILD_DISPATCH_FLAG.
CHILD_DISPATCH_FLAG = "_child"
BACKEND_HOST = "127.0.0.1"
BACKEND_PORT = 8000


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
