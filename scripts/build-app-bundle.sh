#!/bin/bash
# Builds NivrisInstaller.app / NivrisUninstaller.app — a real macOS .app bundle wrapping the
# standalone Bun-compiled CLI, so double-clicking shows a Finder icon and a native dialog (no
# visible Terminal window) instead of the raw CLI experience.
#
# Usage: scripts/build-app-bundle.sh <mode: install|uninstall> <arch: arm64|x64> <cli-binary-path> <out-dir>
set -euo pipefail

MODE="$1"        # install | uninstall
ARCH="$2"        # arm64 | x64
CLI_BIN="$3"     # path to the compiled standalone-installer / standalone-uninstaller binary
OUT_DIR="$4"     # where to place the .app
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "$MODE" = "install" ]; then
    APP_NAME="NivrisInstaller"
    TITLE_VI="Cài đặt N.I.V.R.I.S."
    DONE_MSG_VI="Đã cài đặt N.I.V.R.I.S. thành công!\\n\\nMở Element lên để bắt đầu dùng."
else
    APP_NAME="NivrisUninstaller"
    TITLE_VI="Gỡ N.I.V.R.I.S."
    DONE_MSG_VI="Đã gỡ N.I.V.R.I.S. thành công.\\n\\nMở lại Element để xác nhận."
fi

APP_DIR="$OUT_DIR/$APP_NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cp "$CLI_BIN" "$APP_DIR/Contents/Resources/nivris-cli"
chmod +x "$APP_DIR/Contents/Resources/nivris-cli"
cp "$REPO_ROOT/assets/icons/AppIcon.icns" "$APP_DIR/Contents/Resources/AppIcon.icns"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$TITLE_VI</string>
    <key>CFBundleIdentifier</key>
    <string>vn.nivris.$MODE.$ARCH</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleExecutable</key>
    <string>$APP_NAME</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>11.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSUIElement</key>
    <false/>
</dict>
</plist>
PLIST

cat > "$APP_DIR/Contents/MacOS/$APP_NAME" <<LAUNCHER
#!/bin/bash
# Runs the bundled CLI silently and reports the result via a native macOS dialog — no Terminal
# window, matches how a normal double-clicked app behaves.
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
CLI="\$DIR/../Resources/nivris-cli"
OUTPUT=\$("\$CLI" < /dev/null 2>&1)
STATUS=\$?

if [ \$STATUS -eq 0 ]; then
    /usr/bin/osascript -e "display dialog \"$DONE_MSG_VI\" with title \"$TITLE_VI\" buttons {\"OK\"} default button \"OK\" with icon note"
else
    ESCAPED=\$(echo "\$OUTPUT" | tail -c 1500 | sed 's/"/\\\\"/g' | sed 's/\$/\\\\n/' | tr -d '\n')
    /usr/bin/osascript -e "display dialog \"Có lỗi khi chạy:\\n\\n\$ESCAPED\" with title \"$TITLE_VI — Lỗi\" buttons {\"OK\"} default button \"OK\" with icon stop"
fi
LAUNCHER
chmod +x "$APP_DIR/Contents/MacOS/$APP_NAME"

echo "Built $APP_DIR"
