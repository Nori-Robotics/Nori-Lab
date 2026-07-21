#!/usr/bin/env bash
# Full clean rebuild of the Nori Lab desktop DMG from current HEAD.
# frontend build -> reinstall lelab -> freeze -> stage -> tauri build -> copy to ~/Downloads
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
HEAD_SHA="$(git rev-parse --short HEAD)"
echo "== building from HEAD $HEAD_SHA =="

source desktop/.build-venv/bin/activate

echo "== [1/6] reinstall current lelab into build venv =="
pip install "$ROOT" --quiet

echo "== [2/6] build frontend (fresh dist for this HEAD) =="
( cd frontend && npm run build >/dev/null )
FE_ASSET="$(grep -o 'index-[A-Za-z0-9_-]*\.js' frontend/dist/index.html | head -1)"
echo "   dist asset: $FE_ASSET"

echo "== [3/6] freeze backend (bundles the fresh dist) =="
( cd desktop && rm -rf build dist && pyinstaller lelab_desktop.spec --noconfirm \
    --distpath ./dist --workpath ./build >/tmp/rebuild_freeze.log 2>&1 )

echo "== [4/6] stage bundle + .env =="
rm -rf desktop/tauri/resources/backend
cp -R desktop/dist/lelab-backend desktop/tauri/resources/backend
cp desktop/env.public desktop/tauri/resources/backend/.env
BAKED="$(grep -o 'index-[A-Za-z0-9_-]*\.js' desktop/tauri/resources/backend/_internal/frontend/dist/index.html | head -1)"
echo "   staged backend serves: $BAKED"
[ "$BAKED" = "$FE_ASSET" ] || { echo "!! staged dist mismatch"; exit 1; }

echo "== [5/6] tauri build (.app + .dmg) =="
( cd desktop/tauri && cargo tauri build >/tmp/rebuild_tauri.log 2>&1 )

echo "== [6/6] copy DMG to ~/Downloads =="
SRC_DMG="$(find "${CARGO_TARGET_DIR:-desktop/tauri/target}/release/bundle/dmg" -name '*.dmg' | head -1)"
DEST="$HOME/Downloads/Nori-Lab-$HEAD_SHA.dmg"
cp "$SRC_DMG" "$DEST"
echo "== DONE =="
echo "HEAD:      $HEAD_SHA"
echo "UI asset:  $FE_ASSET"
echo "DMG:       $DEST"
ls -lh "$DEST"
