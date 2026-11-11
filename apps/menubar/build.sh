#!/usr/bin/env bash
# Builds AgentBridge.app (LSUIElement menu bar app) from main.swift.
#
# 设置了 AGENT_BRIDGE_NODE 时，还会把 bridge CLI、crypto/protocol 两个 workspace
# 包和这份 Node 运行时一起塞进 Contents/Resources：DMG 装到别人机器上不需要源码树，
# 也不要求本机装过 Node。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$here/build"
app="$out/AgentBridge.app"
contents="$app/Contents"

# 版本号只有一个来源：根目录 package.json。预发布后缀（-rc.1）不进 CFBundleShortVersionString，
# Apple 只接受 x.y.z。
version="$(node -p "require('$repo/package.json').version" 2>/dev/null \
  || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo/package.json" | head -1)"
short_version="${version%%-*}"
build_number="$(git -C "$repo" rev-list --count HEAD 2>/dev/null || echo 1)"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources"

# 默认只编本机架构；CI 传 AGENT_BRIDGE_ARCHS="arm64 x86_64" 出通用二进制。
archs="${AGENT_BRIDGE_ARCHS:-$(uname -m)}"
slices=()
for arch in $archs; do
  slice="$contents/MacOS/AgentBridge-$arch"
  swiftc -O -target "$arch-apple-macos13.0" "$here/main.swift" -o "$slice" -framework AppKit
  slices+=("$slice")
done
if [ "${#slices[@]}" -gt 1 ]; then
  lipo -create "${slices[@]}" -output "$contents/MacOS/AgentBridge"
  rm -f "${slices[@]}"
else
  mv "${slices[0]}" "$contents/MacOS/AgentBridge"
fi

if [ -n "${AGENT_BRIDGE_NODE:-}" ]; then
  if [ ! -x "$AGENT_BRIDGE_NODE" ]; then
    echo "AGENT_BRIDGE_NODE 不可执行：$AGENT_BRIDGE_NODE" >&2
    exit 1
  fi
  mkdir -p "$contents/Resources/node/bin" \
    "$contents/Resources/bridge/apps/bridge" \
    "$contents/Resources/bridge/node_modules/@craftstead"

  cp "$AGENT_BRIDGE_NODE" "$contents/Resources/node/bin/node"
  chmod +x "$contents/Resources/node/bin/node"

  mkdir -p "$contents/Resources/bridge/apps/bridge/dist"
  cp -R "$repo/apps/bridge/dist/." "$contents/Resources/bridge/apps/bridge/dist/"
  cp "$repo/apps/bridge/package.json" "$contents/Resources/bridge/apps/bridge/package.json"

  for pkg in crypto protocol; do
    target="$contents/Resources/bridge/node_modules/@craftstead/$pkg"
    mkdir -p "$target"
    cp -R "$repo/packages/$pkg/dist" "$target/dist"
    cp "$repo/packages/$pkg/package.json" "$target/package.json"
  done
  # dist/node.js 用 new URL("../wasm/noise.wasm", import.meta.url) 找 wasm，相对布局要保持。
  cp -R "$repo/packages/crypto/wasm" "$contents/Resources/bridge/node_modules/@craftstead/crypto/wasm"

  printf '{"name":"agent-bridge-bundle","private":true,"type":"module"}' \
    > "$contents/Resources/bridge/package.json"

  repo_key=""
  echo "已打包 bridge CLI 与 Node 运行时（${AGENT_BRIDGE_NODE}）"
else
  # 开发构建：用源码树里的 apps/bridge/dist，需要本机 Node。
  repo_key="<key>AgentBridgeRepo</key><string>$repo</string>"
fi

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
  <key>CFBundleShortVersionString</key><string>$short_version</string>
  <key>CFBundleVersion</key><string>$build_number</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  $repo_key
</dict>
</plist>
PLIST

# 嵌套的 node 必须先签，否则外层签名之后校验会发现里面有一份未签名的可执行文件。
if [ -f "$contents/Resources/node/bin/node" ]; then
  codesign --force --sign - "$contents/Resources/node/bin/node" >/dev/null 2>&1 || true
fi
codesign --force --sign - "$app" >/dev/null 2>&1 || echo "警告：临时签名失败，首次打开可能需要在系统设置里允许" >&2

echo "$app"
