# Agent Bridge

Browser access to the desktop AI agent sessions running on your Mac. The Mac side
dials out to a Cloudflare relay, so nothing listens on an open port.

## Download

macOS 13 or newer, Apple Silicon and Intel in one universal build:
[AgentBridge.dmg](https://github.com/gowinder/agent-bridge/releases/latest/download/AgentBridge.dmg)

Open the DMG, drag `AgentBridge.app` into Applications, then click the menu bar
icon and choose “Invite new device…”. The bundle already contains the bridge CLI
and its Node runtime; nothing else needs to be installed.

Release builds are signed and notarised only when the Apple secrets are
configured. Without them macOS blocks the first launch: right-click the app →
Open, or run

```sh
xattr -dr com.apple.quarantine /Applications/AgentBridge.app
```

Building from source: `npm ci && npm run build && bash apps/menubar/build.sh`.

## License

MIT
