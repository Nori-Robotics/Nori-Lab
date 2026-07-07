# PyInstaller spec for the LeLab desktop backend sidecar.
#
# Build via desktop/build.sh (which first pins CPU-only torch). Produces a
# one-folder bundle at desktop/dist/lelab-backend/ whose entry binary is the
# self-dispatching backend (see desktop/backend_entry.py).
#
#   pyinstaller desktop/lelab_desktop.spec --noconfirm
#
# SIZE LEVERS (see desktop/README.md):
#   - CPU torch pin ....... build.sh, keeps torch ~400MB instead of ~2.5GB CUDA
#   - EXCLUDES below ...... drops rerun (~230MB) + wandb (~76MB) + cmake (~123MB)
#   The excludes are validated by the smoke test in build.sh; if a feature you
#   need pulls one in, move it out of EXCLUDES and re-measure.

from PyInstaller.utils.hooks import collect_all, collect_submodules

# --- lerobot + its dynamic-import friends: grab everything (py + data + dylibs).
datas, binaries, hiddenimports = [], [], []
for pkg in ("lerobot", "draccus", "feetech_servo_sdk"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# lerobot CLI entry points are launched as `_child` subprocesses (rollout now,
# and replay/record paths), so PyInstaller must include them even though nothing
# imports them statically.
hiddenimports += [
    "lerobot.scripts.lerobot_rollout",
    "lerobot.record",
    "lerobot.replay",
    "lerobot.teleoperate",
]
# uvicorn/websocket machinery is loaded by string name at runtime.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["websockets", "httptools", "watchfiles"]

# Ship the built React app so lelab.server can StaticFiles-mount it at /.
datas += [("../frontend/dist", "frontend/dist")]

# --- Excludes: not reachable from teleop / calibrate / record / local-inference.
#   rerun*  -> dataset visualization only (lerobot.utils.visualization_utils)
#   wandb   -> training experiment tracking; desktop training is cloud-dispatched
#   cmake   -> build tool that leaked into the venv; never imported at runtime
#   the rest are dev/notebook noise that torch/pandas optionally reference.
excludes = [
    "rerun", "rerun_sdk", "rerun_bindings",
    "wandb",
    "cmake",
    "IPython", "notebook", "jupyter", "jupyter_core",
    "matplotlib", "tkinter", "pytest",
]

block_cipher = None

a = Analysis(
    ["backend_entry.py"],
    pathex=[".."],  # so `import lelab` resolves from the repo root
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="lelab-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX + torch dylibs = frequent load failures; leave off.
    console=True,       # keep a console so backend logs surface during dev.
    disable_windowed_traceback=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="lelab-backend",
)
