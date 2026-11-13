# Agent Bridge

Browser access to the desktop AI coding-agent sessions running on your Mac.

Agent Bridge installs a small daemon and a menu bar app on the Mac. The daemon
enumerates the sessions of the agents you already use — Claude Desktop's Code
panel, Claude Code CLI, ChatGPT Desktop's Codex panel, Codex CLI, Antigravity,
DeepSeek Harness — and lets you read and reply to them from a phone or any other
browser. It can also host its own Claude Code processes so the browser can create
sessions that do not depend on a desktop app.

The Mac dials out to a Cloudflare relay. **Nothing listens on an inbound port**,
no tunnel is installed, and no firewall rule is needed. Every byte between the
browser and the Mac is end-to-end encrypted with Noise; the relay only sees
opaque ciphertext and routing metadata.

- Web client: <https://agent-bridge.craftstead.app>
- Download: [AgentBridge.dmg](https://github.com/gowinder/agent-bridge/releases/latest/download/AgentBridge.dmg)
- Detailed guide: [docs/GUIDE.md](docs/GUIDE.md)

## Contents

- [How it works](#how-it-works)
- [Supported agents](#supported-agents)
- [Install](#install)
- [First run](#first-run)
- [Everyday use](#everyday-use)
- [CLI reference](#cli-reference)
- [Configuration](#configuration)
- [Security model](#security-model)
- [Limitations](#limitations)
- [Development](#development)
- [Deployment](#deployment)
- [License](#license)

## How it works

```
   Phone / laptop browser                Cloudflare                    Your Mac
 ┌──────────────────────┐          ┌──────────────────┐          ┌──────────────────────┐
 │  web client (PWA)    │   WSS    │  relay Worker    │   WSS    │  bridge daemon       │
 │  Noise initiator     │◀────────▶│  Room DO / room  │◀────────▶│  Noise responder     │
 │  E2E: ciphertext     │          │  ciphertext only │          │  adapters + SQLite   │
 └──────────────────────┘          └──────────────────┘          └──────────┬───────────┘
                                                                            │ local files,
                                                                            │ sockets, CLI
                                                                  ┌─────────▼──────────┐
                                                                  │ Claude Desktop,    │
                                                                  │ claude, codex,     │
                                                                  │ agy, dsh, hosted   │
                                                                  └────────────────────┘
```

1. `bridge init` creates a room on the relay and stores the room id, a bridge
   token and a Noise static identity in a local state directory.
2. `bridge serve` (or the menu bar app) opens one outbound WebSocket to the
   relay and keeps it open, reconnecting with 1 s → 30 s backoff.
3. `bridge invite` mints a one-time invite token locally. Only its SHA-256 hash
   is uploaded to the relay. The invite link carries the token in the URL
   fragment, which browsers never send to a server.
4. The browser performs a Noise `xxpsk3` handshake with the Mac, with the PSK
   derived by HKDF-SHA256 from the invite token and the room id. Both sides
   display a 6-digit confirmation code derived from the two public keys; the
   user compares them and confirms.
5. The device's Noise public key is stored on the Mac. Future connections use
   the `ik` pattern — the Mac authenticates the device cryptographically, so no
   token is needed and a stolen relay cannot impersonate either side.
6. Requests and responses are Noise transport messages inside binary relay
   frames; the relay forwards 16-byte channel ids and never parses a payload.

The web client polls for new messages (5 s in a chat or list view, 10 s for the
background session watcher) rather than receiving server-pushed deltas. Push
notifications use Web Push/VAPID so the phone still gets an alert when the tab is
closed.

## Supported agents

Each adapter is a separate module in `apps/bridge/src/adapters/`. Capability
differs by agent because each one stores and accepts messages differently.

| Adapter key | Display name | List | Read | Send | Create | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `hosted` | Claude Code · Hosted by Bridge | ✅ | ✅ | ✅ | ✅ | Bridge owns the CLI process; approvals work end to end |
| `claude-code` | Claude Desktop · Code | ✅ | partial | ✅ | ❌ | Wakes the desktop app and injects a peer message |
| `claude-code-cli` | Claude Code · CLI | ✅ | partial | ✅ | ❌ | Running CLI via local socket, otherwise `claude --resume -p` |
| `codex` | ChatGPT Desktop · Codex | ✅ | ✅ | ✅ | ❌ | Only threads that are open in the app; native compact |
| `codex-cli` | Codex · CLI | ✅ | partial | ✅ | ❌ | `codex queue` when running, otherwise `codex exec resume` |
| `antigravity` | Antigravity CLI | ✅ | partial | ✅ | ❌ | Cannot send while the session is running |
| `antigravity-desktop` | Antigravity Desktop | ✅ | ✅ | ❌ | ❌ | Read-only |
| `dsh` | DeepSeek Harness | ✅ | ✅ | ✅ | ❌ | Headless profile |

"Partial" read means the adapter recovers the visible conversation but may not
expose tool output, attachments or every historical turn. See
[docs/GUIDE.md](docs/GUIDE.md#7-adapters) for the data source and send mechanism of
each adapter.

## Install

### DMG (recommended)

macOS 13 or newer, Apple Silicon and Intel in one universal build.

1. Open [AgentBridge.dmg](https://github.com/gowinder/agent-bridge/releases/latest/download/AgentBridge.dmg).
2. Drag `AgentBridge.app` into `/Applications`.
3. Launch it. The app lives in the menu bar and has no Dock icon.

The bundle contains the bridge CLI, its compiled output and a Node runtime, so
nothing else needs to be installed.

Release builds are signed and notarised only when the Apple secrets are
configured. Otherwise macOS blocks the first launch. On macOS 15 or newer the
right-click → Open shortcut is gone: dismiss the dialog, open System Settings →
Privacy & Security and click "Open Anyway" at the bottom. On macOS 14 and
earlier, right-click the app → Open. Either way this also works:

```sh
xattr -dr com.apple.quarantine /Applications/AgentBridge.app
```

### From source

```sh
git clone https://github.com/gowinder/agent-bridge.git
cd agent-bridge
npm ci
npm run build:wasm -w @craftstead/crypto   # Rust Noise module → packages/crypto/wasm/noise.wasm
npm run build           # tsc -b across all workspaces
npm run check           # type check, including the web client
npm test                # build + node:test suite
```

`build:wasm` needs a Rust toolchain with the `wasm32-unknown-unknown` target:

```sh
rustup target add wasm32-unknown-unknown
```

Then either run the daemon directly (`npm run bridge -- <command>`) or build the
menu bar app with `npm run menubar` (add
`AGENT_BRIDGE_ARCHS="arm64 x86_64"` for a universal binary).

## First run

The menu bar app does all of this for you; the CLI equivalents are shown for
headless machines.

```sh
# 1. Create a room on the relay and write local state
npm run bridge -- init --relay https://agent-bridge.craftstead.app \
                        --web   https://agent-bridge.craftstead.app \
                        --name  "My Mac"

# 2. Run the daemon (the menu bar app does this itself)
npm run bridge -- serve

# 3. Mint a one-time invite, valid for 10 minutes
npm run bridge -- invite --ttl 600
```

`init` refuses a non-HTTPS relay unless it is a loopback address, and it health
checks `/v1/health` before writing anything.

`invite` prints a link of the form:

```
https://agent-bridge.craftstead.app/#/pair?relay=…&room=…&invite=…
```

Open it on the phone. The pairing screen shows a 6-digit code; the same code is
printed in the terminal (and shown in the menu bar app). Confirm it on both
sides and name the device. The invite is single-use, and the room can hold any
number of devices.

If a room was already claimed by a different Mac, the relay refuses the new
bridge: the first bridge to claim a room id owns it (trust on first use), and
replacing it requires clearing the room on the relay side.

## Everyday use

The web client has three levels:

- **Clients** (`#/clients`) — one card per installed agent, with live session
  counts.
- **Projects** (`#/clients/:appId/projects/:projectId`) — sessions grouped by
  working directory.
- **Session** (`…/sessions/:sessionId`) — the conversation, a context gauge, a
  message composer, attachments, and an optional task rail.

In a session you can read the transcript, send a message, answer an approval
prompt, rename the session, request a native compact (or copy `/compact` when
the agent has no native compact), and — if the Mac owner enabled remote
devtools — browse project files and run a single shell command.

The rail shows the environment, the context window usage, MCP servers and
background tasks where the adapter exposes them.

### Hosted sessions

Hosted sessions are the only kind the browser can *create*. The bridge spawns
`claude` itself:

```
claude -p --input-format stream-json --output-format stream-json --verbose \
       --permission-mode <mode> --permission-prompts host \
       --permission-prompt-tool stdio [--session-id|--resume] [--model]
```

Because the bridge owns the process's stdin, tool-permission questions arrive as
real prompts in the chat with **Allow** / **Deny** buttons, and the answer goes
back as a `control_response`. Transcripts are written to
`$AGENT_BRIDGE_HOME/hosted/`.

Create the allowlist first (`~/Library/Application Support/AgentBridge/hosted.json`,
or `$AGENT_BRIDGE_HOME/hosted.json`):

```json
{
  "dirs": ["/Users/you/code/scratch"],
  "idleTimeoutMs": 1800000,
  "allowBypassPermissions": false
}
```

- `dirs` — absolute paths, expanded and `realpath`ed before comparison. Only
  these directories can be used as a hosted project. Restart the bridge after
  editing.
- `idleTimeoutMs` — stop an idle process after this many milliseconds (default
  30 minutes, minimum 60 s). Sending another message resumes the same CLI
  session.
- `allowBypassPermissions` — default `false`. When `true`, hosted sessions may be
  started with `bypassPermissions`; when `false` that mode is rejected.
- `cliPath` — optional; defaults to `claude` on `PATH`, then a search of
  `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin`, `/usr/local/bin`.

### Remote devtools

File browsing and shell execution are **separate opt-in switches, both off by
default, both with a TTL**:

```sh
npm run bridge -- devtools                 # show status
npm run bridge -- devtools files on --ttl 3600
npm run bridge -- devtools terminal on --ttl 600
npm run bridge -- devtools all off
```

The file browser is read-only and confined to the session's project directory.
The terminal runs one command at a time (max 8 concurrent), in its own process
group, and the owning browser tab can cancel it.

## CLI reference

```
agent-bridge init --relay <url> [--web <url>] [--name <name>]
agent-bridge invite [--ttl 30..600]
agent-bridge serve
agent-bridge devices [ttl manual|1h|24h|7d|30d]
agent-bridge revoke <deviceId>
agent-bridge devtools [files|terminal|all] [on|off|status] [--ttl 60..86400]
agent-bridge port [<port>]
agent-bridge status
agent-bridge info
agent-bridge --version
```

| Command | Purpose |
| --- | --- |
| `init` | Create a room, generate the bridge token and Noise identity, write state. |
| `invite` | Mint a single-use pairing token (TTL 30–600 s, default 300) and print the link. |
| `serve` | Run the daemon: connect to the relay, dispatch sessions, serve the admin API. |
| `devices` | List paired devices, optionally change their expiry policy. |
| `revoke` | Revoke one device and close its live sockets. |
| `devtools` | Toggle the remote file browser and terminal, with a TTL. |
| `port` | Read or write the local admin port, then restart the daemon. |
| `status` / `info` | Human-readable state: relay, room, devices, uptime. |

Per-device management is also available from the web client, but only for the
device you are using; other devices are managed on the Mac.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `AGENT_BRIDGE_HOME` | `~/Library/Application Support/AgentBridge` | State directory (database, identity, hosted transcripts, port file). |
| `AGENT_BRIDGE_ADMIN_PORT` | port file, else 47825 / 47826 | Override the loopback admin port for one run. |
| `AGENT_BRIDGE_ENV` | inferred from relay host | `preview` or `production`; picks the default admin port. |
| `AGENT_BRIDGE_CLAUDE_PATH` | `claude` | Path to the Claude Code CLI used by hosted sessions. |

State directory contents:

```
bridge.db          SQLite: devices, invites, push subscriptions, titles, events
identity.json      Noise static key pair
hosted.json        hosted-session allowlist and policy
hosted/            hosted transcripts (*.jsonl) and sessions.json
admin-port         loopback admin port for this state directory
admin-token        bearer token for the admin API (mode 0600)
```

The database is opened in WAL mode with a 3 s busy timeout, and the directory is
created with mode 0700. Back up the state directory to keep devices paired;
deleting it unpairs everything.

## Security model

- **End-to-end encryption.** Noise `xxpsk3` for pairing, `ik` for reconnects.
  The relay forwards ciphertext and never holds a key.
- **Outbound only.** The Mac opens the WebSocket; there is no listener, tunnel
  or port forward.
- **One-time invites.** Only the SHA-256 hash of the token is stored on the
  relay; a used invite cannot be replayed. Invites expire in 30–600 s.
- **Human confirmation.** A 6-digit code derived from both public keys must
  match on the Mac and in the browser before the device is registered.
- **Device identity.** Each paired device is a Noise static key. Revocation is
  local and immediate — the relay closes the matching sockets.
- **Browser vault.** Device metadata lives in `localStorage` in plain text, but
  the secret keys are AES-GCM encrypted with a PBKDF2-SHA256 key (600,000
  iterations) derived from a user password, and stay unlocked for 30 minutes.
  The password never leaves the browser.
- **Loopback admin API.** `127.0.0.1` only, `Host` must be a loopback name, no
  `Origin` header accepted, bearer token compared in constant time, token file
  mode 0600.
- **Rate limits.** 40 WebSocket upgrades and 120 API requests per minute per IP
  on the relay.
- **Strict CSP** on the web client: `script-src 'self' 'wasm-unsafe-eval'`,
  `connect-src https: wss:`, `frame-ancestors 'none'`.

## Limitations

These are properties of the current design, not bugs to be worked around:

- **Remote approval of a desktop session is unreliable by nature.** Messages
  injected into a Claude Desktop or Claude Code session arrive as peer /
  cross-session input, so the agent may refuse to treat your "approve" as the
  user's own decision. Use a Bridge-hosted session when the workflow needs real
  approvals from the phone, or do the final step on the Mac. See
  `REMOTE_APPROVAL.zh-CN.md`.
- **Browsers can only create hosted sessions.** Every other adapter attaches to
  sessions that already exist on the Mac.
- **Antigravity Desktop is read-only.**
- **`session.subscribe`, `session.unsubscribe`, `sync.resume` and
  `operation.get` are declared in the protocol but not dispatched** by the
  bridge yet. The UI polls instead of subscribing to server-pushed events; only
  `shell.output` is emitted as a real event.
- **The web client UI is Chinese only** (`zh-CN`). There is no i18n layer.
- **The relay is a single Cloudflare Worker + Durable Object per room.** Room
  data lives in that object; idle rooms are cleaned after 30 days, keeping only
  the claim anchors.
- **The relay is trusted for availability, not confidentiality.** It can drop,
  delay or refuse traffic, and it learns room ids, timing and frame sizes.
- **Hosted sessions are Claude Code only.** The hosted adapter depends on
  `claude`'s stream-json control protocol.
- **Transcripts are not encrypted at rest.** `hosted/*.jsonl` and `bridge.db`
  rely on macOS file permissions (0700/0600), not on disk encryption.
- **One bridge per room.** A second Mac cannot take over a claimed room id.

Full detail, protocol reference and troubleshooting: [docs/GUIDE.md](docs/GUIDE.md).

## Development

```
apps/bridge      Node daemon: relay client, session adapters, admin API, push
apps/relay       Cloudflare Worker + Durable Object `Room`
apps/web         Vite SPA / PWA (TypeScript, no framework)
apps/menubar     Swift AppKit menu bar app (LSUIElement)
packages/protocol  Wire types, method names, limits
packages/crypto    Noise handshakes, PSK derivation, chunked secure channel
```

Everyday commands:

```sh
npm run build        # tsc -b
npm run check        # tsc -b + web type check
npm test             # build + node:test
npm run web          # vite dev server for the web client
npm run relay:dev    # wrangler dev for the relay
npm run bridge -- serve
```

Branching and release rules are in `AGENTS.md`: `develop` deploys the preview
relay, `main` deploys production, feature branches come from `develop`, and
production deploys are gated on a version bump in the root `package.json`.

## Deployment

`.github/workflows/deploy.yml` builds the wasm module, type checks, builds the
web client and deploys with `wrangler`:

- push to `develop` with a changed root version → `wrangler deploy --env preview`
- push to `main` with a changed root version, or a `vX.Y.Z` tag on `main`
  matching the package version → production
- prerelease tags are excluded from production

`.github/workflows/release.yml` builds the universal menu bar app, the DMG and
its SHA-256, and publishes a GitHub Release on `v*`. Signing and notarisation
run only when the Apple secrets are present.

- Preview: <https://agent-bridge-preview.craftstead.app>
- Production: <https://agent-bridge.craftstead.app>

## License

MIT
