#!/usr/bin/env bash
# release-sdk.sh — sync frontend/packages/nori-sdk into the standalone nori-sdk
# distribution repo and cut a release there.
#
# Source of truth stays HERE (NoriLeLab). The nori-sdk repo is distribution-only:
# external devs get repo access, install via the release tarball or
# `npm i github:<org>/nori-sdk#v<version>`. dist/ is COMMITTED in that repo
# (npm's git-install does not build for consumers), which is why it must be
# regenerated and re-synced on every release — never hand-edited there.
#
# Usage:
#   frontend/scripts/release-sdk.sh <version> <path-to-nori-sdk-checkout> [--push]
#   e.g.  frontend/scripts/release-sdk.sh 0.1.0 ~/Documents/Nori/nori-sdk --push
#
# What it does:
#   1. bumps the version in the SOURCE package.json (commit that here yourself)
#   2. builds dist/ (tsc) — fails on type errors
#   3. runs the SDK-related frontend tests (vitest)
#   4. rsyncs src/ dist/ examples/ README.md package.json tsconfig.json + LICENSE
#      into the target repo (deletes stale files there; leaves .git alone)
#   5. npm-packs the tarball IN the target repo
#   6. commits + tags v<version> in the target repo
#   7. --push: pushes main + tag and creates a GitHub release with the tarball
#      attached (needs `gh` authenticated for the target repo)
set -euo pipefail

VERSION="${1:?usage: release-sdk.sh <version> <path-to-nori-sdk-repo> [--push]}"
TARGET="${2:?usage: release-sdk.sh <version> <path-to-nori-sdk-repo> [--push]}"
PUSH="${3:-}"

FRONTEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$FRONTEND_DIR/packages/nori-sdk"
TARGET="$(cd "$TARGET" && pwd)"

[[ -f "$PKG_DIR/package.json" ]] || { echo "not found: $PKG_DIR/package.json" >&2; exit 1; }
[[ -d "$TARGET/.git" ]] || { echo "target is not a git checkout: $TARGET" >&2; exit 1; }

# Refuse to release from a dirty target repo — a half-synced tree would end up in the tag.
if [[ -n "$(git -C "$TARGET" status --porcelain)" ]]; then
  echo "target repo has uncommitted changes — commit or stash them first:" >&2
  git -C "$TARGET" status --short >&2
  exit 1
fi

echo "==> 1/7 version -> $VERSION (source package.json)"
(cd "$PKG_DIR" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)

echo "==> 2/7 build dist/ (tsc)"
(cd "$PKG_DIR" && npm run build)

echo "==> 3/7 frontend tests"
(cd "$FRONTEND_DIR" && npx vitest run --silent)

echo "==> 4/7 sync -> $TARGET"
for d in src dist examples; do
  rsync -a --delete "$PKG_DIR/$d/" "$TARGET/$d/"
done
cp "$PKG_DIR/README.md" "$PKG_DIR/package.json" "$PKG_DIR/tsconfig.json" "$TARGET/"
cp "$FRONTEND_DIR/LICENSE" "$TARGET/LICENSE"   # Apache-2.0, inherited from LeLab
# Distribution repo ignores node_modules + packed tarballs only — dist/ IS committed here.
printf 'node_modules/\n*.tgz\n' > "$TARGET/.gitignore"

echo "==> 5/7 pack tarball"
TGZ="$(cd "$TARGET" && npm pack --quiet | tail -1)"
echo "    $TARGET/$TGZ"

echo "==> 6/7 commit + tag v$VERSION"
git -C "$TARGET" add -A
if git -C "$TARGET" diff --cached --quiet; then
  echo "    nothing changed since last release — aborting before tag" >&2
  exit 1
fi
git -C "$TARGET" commit -m "release v$VERSION (synced from NoriLeLab frontend/packages/nori-sdk)"
git -C "$TARGET" tag -a "v$VERSION" -m "nori-sdk v$VERSION"

if [[ "$PUSH" == "--push" ]]; then
  echo "==> 7/7 push + GitHub release"
  git -C "$TARGET" push origin HEAD "v$VERSION"
  (cd "$TARGET" && gh release create "v$VERSION" "$TGZ" \
     --title "nori-sdk v$VERSION" \
     --notes "Synced from NoriLeLab \`frontend/packages/nori-sdk\`. Install: download the tarball and \`npm i ./$TGZ\`, or \`npm i github:<org>/nori-sdk#v$VERSION\`.")
else
  echo "==> 7/7 skipped push (pass --push to push + create the GitHub release)"
  echo "    manual: git -C '$TARGET' push origin HEAD v$VERSION"
  echo "            cd '$TARGET' && gh release create v$VERSION $TGZ"
fi

echo "done. remember: commit the version bump in NoriLeLab ($PKG_DIR/package.json)."
