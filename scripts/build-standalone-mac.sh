#!/bin/bash
# Builds the standalone macOS .app installer/uninstaller (no Node.js needed by end users):
#   1. vite build -> lib/index.js
#   2. bun build --compile the CLI logic for both arm64 and x64, embedding lib/index.js
#   3. lipo -create them into one universal binary (runs on Apple Silicon AND Intel)
#   4. wrap each in a real .app bundle (icon, no visible Terminal window — see build-app-bundle.sh)
#   5. zip with ditto (preserves the executable bit and app bundle structure)
#
# Needs Bun (https://bun.com) — maintainer-only tooling, end users never need it. Icon comes from
# the committed assets/icons/AppIcon.icns (regenerate via scripts/draw-app-icon.py if needed).
#
# Usage: scripts/build-standalone-mac.sh [outdir]  (defaults to ./dist)
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${1:-dist}"
mkdir -p "$OUT_DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> vite build"
# NIVRIS_UPDATE_TOKEN is a placeholder, not a real secret — this build is embedded into every copy
# of the installer, so it can't carry any one user's real per-machine token (see TOKEN_PLACEHOLDER's
# doc comment in scripts/lib/apply-update.mjs; standalone-installer.ts substitutes the real one in
# at install time). NIVRIS_UPDATE_PORT isn't machine-specific, so it's fine to bake in directly.
NIVRIS_BUILD_SHA=$(git rev-parse HEAD) \
NIVRIS_UPDATE_TOKEN=__NIVRIS_TOKEN_PLACEHOLDER__ \
NIVRIS_UPDATE_PORT=47291 \
npm run build >/dev/null

NIVRIS_BUILD_SHA_VALUE=$(git rev-parse HEAD)

for MODE in install uninstall; do
    DEFINE_ARGS=()
    if [ "$MODE" = "install" ]; then
        SRC="scripts/standalone-installer.ts"
        # Only standalone-installer.ts references this global — see its own doc comment.
        DEFINE_ARGS=(--define "NIVRIS_BUILD_SHA=\"$NIVRIS_BUILD_SHA_VALUE\"")
    else
        SRC="scripts/standalone-uninstaller.ts"
    fi
    echo "==> compiling $MODE (arm64)"
    bun build --compile "${DEFINE_ARGS[@]+"${DEFINE_ARGS[@]}"}" "$SRC" --outfile "$WORK/$MODE-arm64" >/dev/null
    echo "==> compiling $MODE (x64, cross-compiled)"
    bun build --compile --target=bun-darwin-x64-baseline "${DEFINE_ARGS[@]+"${DEFINE_ARGS[@]}"}" "$SRC" --outfile "$WORK/$MODE-x64" >/dev/null
    echo "==> lipo universal binary"
    lipo -create "$WORK/$MODE-arm64" "$WORK/$MODE-x64" -output "$WORK/$MODE-universal"
    chmod +x "$WORK/$MODE-universal"
    # lipo invalidates each slice's ad-hoc signature (offsets shift once merged) without
    # re-signing the result — Apple Silicon's AMFI refuses to execute a binary with an invalid
    # signature and SIGKILLs it silently (no output at all), which is exactly what end users hit.
    # Re-sign ad-hoc (no Developer ID needed, just makes the signature valid again) so it launches.
    echo "==> re-signing universal binary (ad-hoc)"
    codesign -s - --force "$WORK/$MODE-universal"

    echo "==> wrapping in .app"
    bash scripts/build-app-bundle.sh "$MODE" universal "$WORK/$MODE-universal" "$WORK"

    APP_NAME="NivrisInstaller"
    ZIP_NAME="NivrisInstaller-macOS.zip"
    if [ "$MODE" = "uninstall" ]; then
        APP_NAME="NivrisUninstaller"
        ZIP_NAME="NivrisUninstaller-macOS.zip"
    fi

    echo "==> zipping ($ZIP_NAME)"
    ditto -c -k --sequesterRsrc --keepParent "$WORK/$APP_NAME.app" "$OUT_DIR/$ZIP_NAME"
done

echo
echo "Done. Attach these to a GitHub Release:"
ls -la "$OUT_DIR"/NivrisInstaller-macOS.zip "$OUT_DIR"/NivrisUninstaller-macOS.zip
