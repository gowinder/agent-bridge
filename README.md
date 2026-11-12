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
configured. Without them macOS blocks the first launch. On macOS 15 or newer the
right-click → Open shortcut is gone: dismiss the dialog, then open System
Settings → Privacy & Security and click “Open Anyway” at the bottom. On macOS 14
and earlier, right-click the app → Open. Either way this also works:

```sh
xattr -dr com.apple.quarantine /Applications/AgentBridge.app
```

Building from source: `npm ci && npm run build && bash apps/menubar/build.sh`.

## Hosted sessions (Bridge 托管会话)

Bridge can also start its own Claude Code process, so the web client can create a
session that does not depend on the desktop app. These sessions are labelled
"Hosted by Bridge" and never appear in the Claude desktop app.

Allowlist the directories that may be used in `~/Library/Application Support/AgentBridge/hosted.json`
(or `$AGENT_BRIDGE_HOME/hosted.json`):

```json
{
  "dirs": ["/Users/you/code/scratch"],
  "idleTimeoutMs": 1800000,
  "allowBypassPermissions": false
}
```

- `dirs`: absolute paths, matched after `~` expansion and `realpath`. Add or remove
  entries, then restart the bridge.
- `idleTimeoutMs`: stop an idle process after this many milliseconds (default 30
  minutes). Sending another message resumes the same CLI session.
- `allowBypassPermissions`: default `false`. When `true`, hosted sessions may be
  created with `bypassPermissions` (the web panel then offers it); when `false`
  that mode is rejected and existing bypass sessions can no longer start.
- `cliPath`: optional; defaults to `claude` on `PATH`.

In the web client open the hosted client, pick an allowlisted project, and choose
「新建托管会话」. The permission mode defaults to `manual`; every tool request is
shown in the chat with 允许 / 拒绝 buttons. Bridge owns the process stdin, and the
transcript is stored under `$AGENT_BRIDGE_HOME/hosted/`, never in the desktop
transcripts. Tests: `npm test`.

## Local admin port

The menu bar app controls Bridge through a loopback-only admin API. Its port is
stored per state directory in `admin-port` (`$AGENT_BRIDGE_HOME/admin-port`), so a
preview Bridge and a production Bridge can run at the same time:

- defaults: preview relay 47826, production 47825 (relay host contains
  `preview`/`staging`, or set `AGENT_BRIDGE_ENV=preview`/`production`)
- menu bar 「管理端口…」writes the file and restarts the Bridge it started;
  `agent-bridge port [<port>]` does the same from a terminal
- `AGENT_BRIDGE_ADMIN_PORT` overrides the file (useful for one-off runs)

## License

MIT
