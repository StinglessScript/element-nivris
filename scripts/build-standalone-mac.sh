#!/bin/bash
# Builds the standalone macOS .app installer/uninstaller (no Node.js needed by end users):
#   1. vite build -> lib/index.js
#   2. bun build --compile the CLI logic for both arm64 and x64, embedding lib/index.js
#   3. lipo -create them into one universal binary (runs on Apple Silicon AND Intel)
#   4. wrap each in a real .app bundle (icon, no visible Terminal window — see build-app-bundle.sh)
#   5. zip with ditto (preserves the executable bit and app bundle structure)
#
# Needs Bun (https://bun.com) and Python3+Pillow (only to draw the icon, first run only) —
# maintainer-only tooling, end users never need any of this.
#
# Usage: scripts/build-standalone-mac.sh [outdir]  (defaults to ./dist)
set -euo pipefail
cd "$(dirname "$0")/.."

OUT_DIR="${1:-dist}"
mkdir -p "$OUT_DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> vite build"
npm run build >/dev/null

if [ ! -f /tmp/AppIcon.icns ]; then
    echo "==> drawing AppIcon.icns (first run only)"
    mkdir -p /tmp/nivris-icon.iconset
    python3 scripts/draw-app-icon.py /tmp/nivris-icon.iconset
    iconutil -c icns /tmp/nivris-icon.iconset -o /tmp/AppIcon.icns
fi

for MODE in install uninstall; do
    if [ "$MODE" = "install" ]; then SRC="scripts/standalone-installer.ts"; else SRC="scripts/standalone-uninstaller.ts"; fi
    echo "==> compiling $MODE (arm64)"
    bun build --compile "$SRC" --outfile "$WORK/$MODE-arm64" >/dev/null
    echo "==> compiling $MODE (x64, cross-compiled)"
    bun build --compile --target=bun-darwin-x64-baseline "$SRC" --outfile "$WORK/$MODE-x64" >/dev/null
    echo "==> lipo universal binary"
    lipo -create "$WORK/$MODE-arm64" "$WORK/$MODE-x64" -output "$WORK/$MODE-universal"
    chmod +x "$WORK/$MODE-universal"

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
