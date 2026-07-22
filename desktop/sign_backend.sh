#!/usr/bin/env bash
# Strip + code-sign the frozen backend bundle's native libraries (macOS only).
#
#   ./desktop/sign_backend.sh <path-to-lelab-backend-bundle>
#
# Called by both build.sh and rebuild_all.sh so the two can't drift apart.
# No-op on non-macOS.
#
# WHY THIS EXISTS AS A SEPARATE STEP:
# Signing the outer .app does NOT sign the Mach-O files nested inside its
# Resources/. Our PyInstaller bundle contributes several hundred .dylib/.so
# files plus its own executable, and notarization rejects the whole submission
# if even one of them lacks a Developer ID signature, a secure timestamp, or
# the hardened runtime flag. So we must sign them here, before Tauri wraps and
# signs the app.
#
# TWO MODES:
#   APPLE_SIGNING_IDENTITY unset -> ad-hoc signature ("-"). Local/dev builds.
#     Runs offline and fast, but the result can NEVER be notarized.
#   APPLE_SIGNING_IDENTITY set   -> real Developer ID signature, hardened
#     runtime, secure timestamp. Required for distribution.
#
# ORDERING IS LOAD-BEARING: nested libraries must be signed BEFORE the
# executable that loads them. Signing a parent embeds a hash of its children,
# so signing a child afterwards invalidates the parent.
set -euo pipefail

BUNDLE="${1:?usage: sign_backend.sh <bundle-dir>}"
[ "$(uname)" = "Darwin" ] || { echo "    (not macOS, skipping strip/sign)"; exit 0; }

HERE="$(cd "$(dirname "$0")" && pwd)"
ENTITLEMENTS="$HERE/tauri/entitlements.plist"

BIN="$BUNDLE/lelab-backend"
[ -f "$BIN" ] || { echo "!! no lelab-backend in $BUNDLE"; exit 1; }

# --- Strip debug/local symbols. Saves ~140MB, almost all of it libtorch.
#     This INVALIDATES any existing signature, which is why signing follows.
echo "    stripping native libs"
while IFS= read -r -d '' f; do
  strip -Sx "$f" 2>/dev/null || true
done < <(find "$BUNDLE" \( -name "*.dylib" -o -name "*.so" \) -print0)
strip -Sx "$BIN" 2>/dev/null || true

# --- Drop never-executed test suites and C headers that collect_all drags in.
rm -rf "$BUNDLE/_internal/pyarrow/include" "$BUNDLE/_internal/pyarrow/tests" 2>/dev/null || true
find "$BUNDLE/_internal/numpy" "$BUNDLE/_internal/pandas" -type d -name tests -prune -exec rm -rf {} + 2>/dev/null || true
find "$BUNDLE/_internal/torch" -type d -name include -prune -exec rm -rf {} + 2>/dev/null || true

# --- Sign.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "    signing with Developer ID: $APPLE_SIGNING_IDENTITY"
  [ -f "$ENTITLEMENTS" ] || { echo "!! missing $ENTITLEMENTS"; exit 1; }
  SIGN_ARGS=(--force --timestamp --options runtime --entitlements "$ENTITLEMENTS"
             --sign "$APPLE_SIGNING_IDENTITY")
  echo "    (--timestamp contacts Apple per file; several hundred files, expect minutes)"
else
  echo "    signing ad-hoc (set APPLE_SIGNING_IDENTITY for a notarizable build)"
  SIGN_ARGS=(--force --sign -)
fi

# Batch through xargs: codesign accepts many paths per call, so this amortizes
# process startup across hundreds of files instead of forking once each.
find "$BUNDLE" \( -name "*.dylib" -o -name "*.so" \) -print0 \
  | xargs -0 -n 40 codesign "${SIGN_ARGS[@]}" 2>/dev/null || true

# Executable last — see the ordering note at the top.
codesign "${SIGN_ARGS[@]}" "$BIN"

# --- Verify. An unsigned straggler here becomes an opaque notarization
#     rejection later, so it is much cheaper to catch it now.
if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  UNSIGNED=0
  while IFS= read -r -d '' f; do
    codesign --verify --strict "$f" 2>/dev/null || { echo "    UNSIGNED: $f"; UNSIGNED=$((UNSIGNED+1)); }
  done < <(find "$BUNDLE" \( -name "*.dylib" -o -name "*.so" \) -print0)
  if [ "$UNSIGNED" -gt 0 ]; then
    echo "!! $UNSIGNED file(s) failed signature verification — notarization would reject this"
    exit 1
  fi
  echo "    all native libs verified signed"
fi
