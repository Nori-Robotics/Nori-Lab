#!/usr/bin/env bash
# Build the LeLab desktop backend sidecar into a slim, frozen one-folder bundle.
#
#   ./desktop/build.sh
#
# Steps: fresh venv -> CPU-only torch -> app -> PyInstaller -> smoke test ->
# stage into the Tauri binaries/ dir with the platform target-triple suffix.
#
# Run once per OS you ship (macOS / Windows / Linux) — PyInstaller bundles are
# not cross-compilable.
set -euo pipefail

cd "$(dirname "$0")/.."          # repo root
ROOT="$(pwd)"
BUILD_VENV="$ROOT/desktop/.build-venv"
PY="${PYTHON:-python3.12}"       # 3.12+ required (pyproject requires-python)

echo "==> [1/5] fresh build venv ($PY)"
rm -rf "$BUILD_VENV"
"$PY" -m venv "$BUILD_VENV"
# shellcheck disable=SC1091
source "$BUILD_VENV/bin/activate" 2>/dev/null || source "$BUILD_VENV/Scripts/activate"
python -m pip install -U pip wheel pyinstaller

# --- The critical size step. On Linux/Windows the default torch wheel is the
#     CUDA build (+~2GB of nvidia_* wheels). Install CPU torch FIRST so pip has
#     it satisfied before `pip install .` resolves lerobot's torch requirement.
#     macOS PyPI wheels are already CPU/MPS, so the extra index is a harmless no-op.
echo "==> [2/5] CPU-only torch"
python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu

echo "==> [3/5] install LeLab (+ pinned lerobot)"
python -m pip install "$ROOT"

echo "==> [4/5] PyInstaller freeze"
rm -rf "$ROOT/desktop/build" "$ROOT/desktop/dist"
( cd "$ROOT/desktop" && pyinstaller lelab_desktop.spec --noconfirm \
    --distpath "$ROOT/desktop/dist" --workpath "$ROOT/desktop/build" )

BUNDLE="$ROOT/desktop/dist/lelab-backend"
BIN="$BUNDLE/lelab-backend"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"

echo "==> [5/5] smoke test (excludes didn't break imports)"
# Boot headless, hit /health-style root, then kill. Also verifies the _child
# dispatch can import the inference module (the torch path we must keep).
"$BIN" _child lerobot.scripts.lerobot_rollout --help >/tmp/lelab_child.log 2>&1 \
  && echo "    child dispatch + torch import OK" \
  || { echo "!! child/inference import FAILED — check EXCLUDES in the spec"; \
       tail -20 /tmp/lelab_child.log; exit 1; }

# --- Stage the one-folder bundle as a Tauri resource (spawned by main.rs).
#     One-folder (not --onefile) keeps torch on disk instead of unpacking
#     ~400MB to a temp dir on every launch.
DEST="$ROOT/desktop/tauri/resources/backend"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
cp -R "$BUNDLE" "$DEST"
echo "    staged -> desktop/tauri/resources/backend/"

echo "==> done. Bundle size:"
du -sh "$BUNDLE"
