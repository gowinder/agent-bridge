#!/usr/bin/env bash
# Builds the menu bar app (LSUIElement) from main.swift.
# 预发布版本产出 AgentBridge-preview.app（独立的 bundle id 与状态目录），
# 正式版产出 AgentBridge.app：两份可以直接装在同一台机器上。
#
# 设置了 AGENT_BRIDGE_NODE 时，还会把 bridge CLI、crypto/protocol 两个 workspace
# 包和这份 Node 运行时一起塞进 Contents/Resources：DMG 装到别人机器上不需要源码树，
# 也不要求本机装过 Node。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
# 版本号只有一个来源：根目录 package.json。预发布后缀（-rc.1）不进 CFBundleShortVersionString，
# Apple 只接受 x.y.z。
version="$(node -p "require('$repo/package.json').version" 2>/dev/null \
  || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$repo/package.json" | head -1)"
short_version="${version%%-*}"
# CFBundleVersion 与 CFBundleShortVersionString 同源，都是根 package.json 的 x.y.z。
build_number="$short_version"

# 预发布与正式版是两份独立安装：bundle id、状态目录、应用名都分开，
# 这样 TCC（文件与文件夹）授权、偏好、桥的状态互不覆盖，也能同时装在一台机器上。
if [[ "$version" == *-* ]]; then
  bundle_id="dev.agent-bridge.menubar.preview"
  app_name="AgentBridge-preview.app"
  state_dir_name="AgentBridge-preview"
else
  bundle_id="dev.agent-bridge.menubar"
  app_name="AgentBridge.app"
  state_dir_name="AgentBridge"
fi

out="$here/build"
app="$out/$app_name"
contents="$app/Contents"

# 上一次构建留下的另一个通道的 app 不要混在产物目录里。
rm -rf "$out"/AgentBridge*.app
mkdir -p "$contents/MacOS" "$contents/Resources"

# 默认只编本机架构；CI 传 AGENT_BRIDGE_ARCHS="arm64 x86_64" 出通用二进制。
archs="${AGENT_BRIDGE_ARCHS:-$(uname -m)}"
slices=()
for arch in $archs; do
  slice="$contents/MacOS/AgentBridge-$arch"
  swiftc -O -target "$arch-apple-macos13.0" "$here/main.swift" "$here/Update.swift" "$here/L10n.swift" "$here/L10nTables.swift" -o "$slice" -framework AppKit -framework UserNotifications
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

  # 第三方运行时依赖（web-push 及其传递依赖）也必须带上：bundle 装在仓库之外，
  # 从 dist 往上解析不到源码树的 node_modules，缺了 CLI 一启动就 ERR_MODULE_NOT_FOUND。
  # 只装 bridge 的第三方依赖：@craftstead/* 是源码树里的 workspace 包，按上面的布局
  # 手工拷进去，不能交给 npm 去解析（它们没有发布到 registry）。
  stage="$out/deps"
  rm -rf "$stage"
  mkdir -p "$stage/apps/bridge"
  printf '{"name":"agent-bridge-dmg-deps","private":true,"workspaces":["apps/bridge"]}' \
    > "$stage/package.json"
  node -e '
    const fs = require("fs");
    const p = require(process.argv[1]);
    const dependencies = Object.fromEntries(
      Object.entries(p.dependencies ?? {}).filter(([name]) => !name.startsWith("@craftstead/")),
    );
    fs.writeFileSync(process.argv[2], JSON.stringify({ name: p.name, version: p.version, private: true, type: "module", dependencies }, null, 2));
  ' "$repo/apps/bridge/package.json" "$stage/apps/bridge/package.json"
  (cd "$stage" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock >/dev/null)
  cp -R "$stage/node_modules/." "$contents/Resources/bridge/node_modules/"

  for pkg in crypto protocol; do
    target="$contents/Resources/bridge/node_modules/@craftstead/$pkg"
    mkdir -p "$target"
    cp -R "$repo/packages/$pkg/dist" "$target/dist"
    cp "$repo/packages/$pkg/package.json" "$target/package.json"
  done
  # dist/node.js 用 new URL("../wasm/noise.wasm", import.meta.url) 找 wasm，相对布局要保持。
  cp -R "$repo/packages/crypto/wasm" "$contents/Resources/bridge/node_modules/@craftstead/crypto/wasm"

  # 与源码树同布局：CLI 从 dist 往上三层读版本号，这里补上同一份根 package.json 的版本。
  printf '{"name":"agent-bridge-bundle","private":true,"type":"module","version":"%s"}' "$version" \
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
  <key>CFBundleIdentifier</key><string>$bundle_id</string>
  <key>AgentBridgeStateDir</key><string>$state_dir_name</string>
  <key>NSDesktopFolderUsageDescription</key><string>列出你放在「桌面」的工程目录里的会话与文件。</string>
  <key>NSDocumentsFolderUsageDescription</key><string>列出你放在「文档」的工程目录里的会话与文件。</string>
  <key>NSDownloadsFolderUsageDescription</key><string>列出你放在「下载」的工程目录里的会话与文件。</string>
  <key>NSRemovableVolumesUsageDescription</key><string>列出你放在外置磁盘上的工程目录里的会话与文件。</string>
  <key>CFBundleName</key><string>Agent Bridge</string>
  <key>CFBundleDisplayName</key><string>Agent Bridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$short_version</string>
  <key>CFBundleVersion</key><string>$build_number</string>
  <key>AgentBridgeVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  $repo_key
</dict>
</plist>
PLIST

# 稳定的签名身份：系统的「文件与文件夹」授权按签名身份记录，adhoc 签名的 cdhash 每次
# 构建都变，更新一次就要把桌面/文档/下载/外置磁盘重新授权一遍。有证书就用证书。
sign_id="${AGENT_BRIDGE_SIGN_ID:-}"
if [ -z "$sign_id" ]; then
  sign_id="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(AgentBridge[^"]*\)".*/\1/p' | head -1)"
fi
sign_one() {
  if [ -n "$sign_id" ]; then
    codesign --force --sign "$sign_id" "$1"
  else
    codesign --force --sign - "$1" 2>/dev/null
  fi
}

# 嵌套的 node 必须先签，否则外层签名之后校验会发现里面有一份未签名的可执行文件。
if [ -f "$contents/Resources/node/bin/node" ]; then
  sign_one "$contents/Resources/node/bin/node" >/dev/null 2>&1 || true
fi
if [ -n "$sign_id" ]; then
  sign_one "$app" >/dev/null 2>&1 || echo "警告：用 $sign_id 签名失败，回退临时签名" >&2
fi
if [ -z "$sign_id" ] || ! codesign --verify "$app" >/dev/null 2>&1; then
  codesign --force --sign - "$app" >/dev/null 2>&1 || echo "警告：临时签名失败，首次打开可能需要在系统设置里允许" >&2
fi

echo "$app"
