# NORI: desktop-bundle support. Build the argv for spawning a lerobot CLI child.
#
# In a normal (source / pip) install `sys.executable` is a real Python, so the
# child is `python -m lerobot.scripts.<mod> ...` exactly as before.
#
# In a PyInstaller/Tauri bundle `sys.executable` is the frozen *desktop* binary,
# which has no `-m` module runner. The frozen entry point (desktop/backend_entry.py)
# instead recognises a leading `_child <module>` argv and re-execs itself via
# runpy. So when frozen we emit `<frozen-exe> _child lerobot.scripts.<mod> ...`.
#
# Keep this the single chokepoint: any code that used to do
#   [sys.executable, "-m", "lerobot.scripts.foo", *args]
# should call module_cmd("lerobot.scripts.foo", *args) instead.

from __future__ import annotations

import sys

# Sentinel argv[1] the frozen entry looks for. Must match desktop/backend_entry.py.
CHILD_DISPATCH_FLAG = "_child"


def is_frozen() -> bool:
    """True when running inside a PyInstaller bundle."""
    return getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS")


def module_cmd(module: str, *args: str) -> list[str]:
    """argv to run a Python module as a child of the current interpreter/bundle."""
    if is_frozen():
        return [sys.executable, CHILD_DISPATCH_FLAG, module, *args]
    return [sys.executable, "-m", module, *args]
