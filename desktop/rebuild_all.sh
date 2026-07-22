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

# shrink + sign native libs (see desktop/sign_backend.sh for the why).
# Set APPLE_SIGNING_IDENTITY for a notarizable build — desktop/NOTARIZE.md.
echo "   strip + sign native libs"
desktop/sign_backend.sh desktop/dist/lelab-backend

echo "== [4/6] stage bundle + .env =="
rm -rf desktop/tauri/resources/backend
cp -R desktop/dist/lelab-backend desktop/tauri/resources/backend
cp desktop/env.public desktop/tauri/resources/backend/.env
BAKED="$(grep -o 'index-[A-Za-z0-9_-]*\.js' desktop/tauri/resources/backend/_internal/frontend/dist/index.html | head -1)"
echo "   staged backend serves: $BAKED"
[ "$BAKED" = "$FE_ASSET" ] || { echo "!! staged dist mismatch"; exit 1; }

# Build ONLY the .app. Tauri's bundle_dmg.sh is flaky (fails intermittently while
# mounting its scratch volume) and its DMG is larger than ours, so we skip it and
# package the disk image ourselves in the next step.
echo "== [5/7] tauri build (.app) =="
( cd desktop/tauri && cargo tauri build --bundles app >/tmp/rebuild_tauri.log 2>&1 )

APP="$(find "${CARGO_TARGET_DIR:-desktop/tauri/target}/release/bundle/macos" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || { echo "!! no .app produced"; tail -30 /tmp/rebuild_tauri.log; exit 1; }

# ULFO (LZFSE) compresses this payload noticeably better than the UDZO default:
# ~356MB vs ~404MB for the same app. Pure download-size win, no runtime cost.
echo "== [6/7] package DMG (ULFO) =="
DEST="$HOME/Downloads/Nori-Lab-$HEAD_SHA.dmg"
rm -f "$DEST"
hdiutil create -volname "Nori Lab" -srcfolder "$APP" -ov -format ULFO "$DEST" >/tmp/rebuild_dmg.log 2>&1 \
  || { echo "!! hdiutil failed"; tail -20 /tmp/rebuild_dmg.log; exit 1; }

# Notarization is opt-in: without a signing identity the build is ad-hoc signed,
# which is fine locally but cannot be distributed. See desktop/NOTARIZE.md.
echo "== [7/7] notarize =="
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
  echo "   submitting to Apple (this takes a few minutes)"
  xcrun notarytool submit "$DEST" --keychain-profile "$NOTARY_PROFILE" --wait
  # Staple so the app validates OFFLINE. Without this, a user with no network
  # on first launch still gets a Gatekeeper block.
  xcrun stapler staple "$DEST"
  xcrun stapler validate "$DEST" && echo "   notarized + stapled"
else
  echo "   skipped (set APPLE_SIGNING_IDENTITY and NOTARY_PROFILE to notarize)"
  echo "   this build is ad-hoc signed and NOT distributable"
fi

echo "== DONE =="
echo "HEAD:      $HEAD_SHA"
echo "UI asset:  $FE_ASSET"
echo "DMG:       $DEST"
ls -lh "$DEST"
shasum -a 256 "$DEST"
