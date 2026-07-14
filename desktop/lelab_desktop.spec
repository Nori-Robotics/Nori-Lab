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
# lerobot gates optional deps behind require_package("<name>") calls that run at
# IMPORT time and find_spec() the top-level package — so any such dep on a path we
# exercise (teleop / calibrate / record / inference) must physically be in the
# bundle or the frozen `_child` aborts. The list below is every require_package
# target that is actually installed in the build venv (the rest are hardware/model
# backends we never touch and aren't installed). They load submodules by string
# and ship data/dylibs (av's ffmpeg, arrow files), so each needs a full collect_all,
# not a lone hiddenimport. NOTE: feetech's import name is `scservo_sdk`, NOT
# `feetech_servo_sdk` (which does not exist — the old spec silently collected nothing).
# `rerun` is intentionally NOT here: it's excluded below (dataset-viz only).
datas, binaries, hiddenimports = [], [], []
for pkg in (
    # `lelab` is our own app package. The serving path is `uvicorn.run("lelab.server:app")`
    # — a STRING import PyInstaller's static analysis can't see — so the package must be
    # collected explicitly or the frozen backend dies at boot with ModuleNotFoundError.
    # (The `_child` smoke test only imports lerobot, so this gap surfaced only at runtime.)
    "lelab",
    "lerobot", "draccus", "scservo_sdk",
    "datasets", "av", "accelerate", "deepdiff",
    "gymnasium", "jsonlines", "pandas", "pynput", "serial",
):
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

# Ship the generated robot tool schemas — server.py loads NORI_AGENT_TOOLS from this at import
# (frozen path: sys._MEIPASS/nori-sdk/robot-tools.json). Generated from @nori/sdk robot-ops.ts via
# `npm run gen:robot-tools`; the agent's tool list comes from here, so the bundle MUST include it.
datas += [("../frontend/packages/nori-sdk/robot-tools.json", "nori-sdk")]

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
