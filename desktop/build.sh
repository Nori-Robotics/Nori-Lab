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

# --- Shrink + sign: strips debug symbols (saves ~140MB, mostly libtorch) and then
#     re-signs every native lib. The re-sign is mandatory, not cosmetic: stripping
#     invalidates a Mach-O's signature, and dyld SIGKILLs the process at load if it
#     doesn't match (silent crash, empty logs). Set APPLE_SIGNING_IDENTITY to produce
#     a notarizable Developer ID build — see desktop/NOTARIZE.md.
#     The smoke test below runs AFTER this, so it validates the stripped+signed bundle.
echo "==> strip + sign native libs"
"$ROOT/desktop/sign_backend.sh" "$BUNDLE"

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

# --- Self-configure the bundle: drop a PUBLIC .env next to the frozen binary so
#     `backend_entry.py::_load_adjacent_env()` finds it and cloud features work in a
#     shipped app (SUPABASE_URL / SUPABASE_ANON_KEY / NORI_BACKEND_URL). PUBLIC VALUES
#     ONLY — never the Supabase service-role key or ANTHROPIC_API_KEY (see HANDOFF §5).
#     Source, in priority order:
#       1. $NORI_BUNDLE_ENV  -> path to a filled-in .env (use this in CI)
#       2. desktop/env.public -> a gitignored local copy you fill from env.public.example
#     If neither exists we warn but still build — the app runs, cloud features just stay
#     unconfigured until a .env is added (or the 3 vars are exported for `tauri dev`).
BUNDLE_ENV="${NORI_BUNDLE_ENV:-$ROOT/desktop/env.public}"
if [ -f "$BUNDLE_ENV" ]; then
  cp "$BUNDLE_ENV" "$DEST/.env"
  echo "    staged .env <- $BUNDLE_ENV"
else
  echo "    ⚠ no bundle .env found (looked at \$NORI_BUNDLE_ENV and desktop/env.public)."
  echo "      Cloud features won't self-configure. Copy desktop/env.public.example ->"
  echo "      desktop/env.public, fill in the PUBLIC values, and re-run — or export the"
  echo "      three vars for a local 'tauri dev'."
fi

echo "==> done. Bundle size:"
du -sh "$BUNDLE"
