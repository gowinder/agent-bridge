#!/usr/bin/env bash
# Builds AgentBridge.app (LSUIElement menu bar app) from main.swift.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/build"
app="$out/AgentBridge.app"
contents="$app/Contents"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"

swiftc -O "$here/main.swift" -o "$contents/MacOS/AgentBridge" -framework AppKit

cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgentBridge</string>
  <key>CFBundleIdentifier</key><string>dev.agent-bridge.menubar</string>
  <key>CFBundleName</key><string>Agent Bridge</string>
  <key>CFBundleDisplayName</key><string>Agent Bridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>AgentBridgeRepo</key><string>$repo</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$app" >/dev/null 2>&1 || echo "警告：临时签名失败，首次打开可能需要在系统设置里允许" >&2

echo "$app"
