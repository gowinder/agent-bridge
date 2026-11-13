# Agent Bridge — Technical Guide

This document explains how Agent Bridge works, how to operate it, and what it
cannot do. It is the detailed companion to the [README](../README.md).

- [1. Design goals](#1-design-goals)
- [2. Topology](#2-topology)
- [3. Cryptography](#3-cryptography)
- [4. Pairing and device lifecycle](#4-pairing-and-device-lifecycle)
- [5. Relay protocol](#5-relay-protocol)
- [6. Bridge protocol](#6-bridge-protocol)
- [7. Adapters](#7-adapters)
- [8. Hosted sessions](#8-hosted-sessions)
- [9. Remote devtools](#9-remote-devtools)
- [10. Web client](#10-web-client)
- [11. Notifications](#11-notifications)
- [12. State, backup and recovery](#12-state-backup-and-recovery)
- [13. Admin API](#13-admin-api)
- [14. Deployment](#14-deployment)
- [15. Security hardening](#15-security-hardening)
- [16. Limitations and known issues](#16-limitations-and-known-issues)
- [17. Troubleshooting](#17-troubleshooting)

---

## 1. Design goals

1. **No inbound attack surface.** The Mac must never accept a connection from
   the internet. Everything is one outbound WebSocket.
2. **The relay is untrusted for content.** Cloudflare can route, count and drop
   frames; it must not be able to read or forge a message or impersonate either
   end.
3. **Attach to what already exists.** The agents people use — Claude Desktop,
   Claude Code, Codex, Antigravity, DeepSeek Harness — already own their
   sessions on disk. Agent Bridge reads those stores rather than replacing them.
4. **One escape hatch for real approvals.** Because injected peer messages
   cannot always answer a permission prompt, the bridge can also own a Claude
   Code process end to end.
5. **Multi-device by default.** Many browsers, independent keys, independent
   revocation, no shared secret stored on the relay.

Non-goals: multi-user sharing, a hosted SaaS control plane, an agent runtime of
its own, and a general remote-shell product.

## 2. Topology

```
Browser ──WSS──▶ Cloudflare Worker ──WSS──▶ Bridge daemon ──▶ Agent (files, sockets, CLI)
                     │
                     └─ Durable Object `Room` per room id
```

Three processes are involved.

**Web client** (`apps/web`) — a framework-free TypeScript SPA plus service
worker. It holds one Noise session per paired device, one relay WebSocket, and
a local encrypted credential vault. It is served as static assets from the same
Worker (`assets` binding with SPA fallback, `run_worker_first = ["/v1/*"]`), so
the app and the relay share an origin.

**Relay** (`apps/relay`) — a Cloudflare Worker with one Durable Object class,
`Room`, and SQLite-backed storage. The Worker terminates TLS, applies CORS and
rate limits, and forwards WebSocket traffic to the room object. It does not
parse binary payloads.

**Bridge daemon** (`apps/bridge`) — a Node process (Node 24, ESM) that keeps the
outbound WebSocket, terminates Noise, dispatches RPC methods against adapters,
stores devices and invites in SQLite, serves a loopback admin API, and delivers
Web Push.

The mac menu bar app (`apps/menubar`, Swift/AppKit, `LSUIElement`) is a thin
supervisor: it starts and stops the daemon, stores the admin port, and exposes
"Invite new device…", "Manage port…" and status.

## 3. Cryptography

All primitives live in `packages/crypto`. Noise is implemented by Rust
[`snow`](https://github.com/mcginty/snow) `0.9.6`, compiled to
`wasm32-unknown-unknown` (`packages/crypto/wasm/noise.wasm`, build with
`npm run build:wasm -w @craftstead/crypto`). The WASM module is gitignored, so
a developer must build it before the daemon or the web client can pair.

### 3.1 Handshake patterns

| Purpose | Pattern | Initiator | Responder |
| --- | --- | --- | --- |
| First pairing | `Noise_xxpsk3_25519_ChaChaPoly_BLAKE2s` | browser | bridge |
| Reconnect | `Noise_ik_25519_ChaChaPoly_BLAKE2s` | browser | bridge |

`xxpsk3` is used for pairing because neither side knows the other's static key
yet, and the PSK binds the handshake to the invite. `ik` is used afterwards
because the browser already knows the bridge's static key and the bridge already
knows the device's — the device is authenticated by its static key alone, with
no token in play.

### 3.2 PSK and confirmation code

```ts
// packages/crypto/src/psk.ts
derivePairPsk(inviteToken, roomId)
  = HKDF-SHA256(ikm = inviteToken, salt = "agent-bridge/pair/v1",
                info = roomId, length = 32 bytes)

confirmCode(browserPub, bridgePub)
  = SHA-256("agent-bridge/confirm/v1" || browserPub || bridgePub)
    → first uint32 big-endian mod 1_000_000 → zero-padded to 6 digits
```

Prologues bind the handshake to its context and prevent cross-room or
cross-channel replay:

| Handshake | Prologue |
| --- | --- |
| pairing | `agent-bridge/pair/v1|room|channel` |
| reconnect | `agent-bridge/device/v1|room|channel|deviceId` |

The confirmation code is the only manual step. It proves that the party on the
other end of the relay holds the same invite token, i.e. that the relay did not
substitute its own key.

### 3.3 Transport

`SecureChannel` (`packages/crypto/src/channel.ts`) wraps Noise transport
messages in the RPC envelope:

- Noise has a 65,535-byte message limit, so payloads over 32 KiB are split into
  base64 chunk messages of 20,000 bytes each.
- Reassembly enforces a 4 MiB total, at most 8 concurrent pending messages, and
  a 60 s chunk TTL.
- Chunked messages are only valid inside one channel; a chunk from another
  channel id is dropped.

### 3.4 Browser key storage

The web client keeps device records in `localStorage` under
`agent-bridge:devices:v2`. Device metadata (name, room, relay URL, bridge public
key) is plaintext; the device's Noise private key and the reconnect token are
encrypted as one AES-GCM blob.

- Key derivation: PBKDF2-SHA256, 600,000 iterations, per-vault random salt.
- Unlock window: 30 minutes, then the vault re-locks and asks for the password.
- A legacy `v1` format stored secrets in plaintext; the client migrates it on
  first unlock and removes the old entry.
- "Reset vault" deletes all device records in that browser. Pairs are not
  affected on the Mac — revoke the device there.

The password is never sent anywhere. Losing it means re-pairing; there is no
recovery path by design.

## 4. Pairing and device lifecycle

### 4.1 Room creation (`init`)

```
bridge init --relay <url> [--web <url>] [--name <name>]
```

- Rejects a non-HTTPS relay unless it is loopback.
- Calls `GET /v1/health` and aborts on failure.
- Generates a room id (UUID), a bridge token (32 random bytes, base64url), and a
  Noise static key pair.
- Writes `identity.json`, `bridge.db` meta rows, and the default device TTL.
- The room is *claimed* by the first bridge that connects with a given room id
  and token. The relay stores `SHA-256(token)` as `bridge_hash` (trust on first
  use). A different bridge presenting the same room id is rejected.

### 4.2 Invites

```
bridge invite [--ttl 30..600]
```

The token is minted locally; only its hash goes to the relay, with a TTL
(default 300 s, maximum 600 s). The relay stores it in its `invites` table and
deletes it when used. The link is:

```
${webUrl}/#/pair?relay=<relay>&room=<room>&invite=<token>
```

The fragment is never transmitted in an HTTP request, so the token does not
appear in relay logs. The web client clears the fragment after reading it.

### 4.3 Pairing flow

1. Browser opens the relay WebSocket, sends `hello` with the room id and a hash
   of the invite token (never the token itself).
2. Relay answers `ready`; the bridge is already connected as `bridge`.
3. Browser sends `channel.open` for a fresh channel; relay tells the bridge.
4. Browser and bridge run `xxpsk3` with the derived PSK and context prologue.
5. Each side computes the 6-digit confirmation code; the Mac shows it in the
   terminal and the menu bar app, the browser shows it on screen. The user
   confirms on both sides.
6. Browser calls `pair.request` with a device name and its static public key.
   The bridge verifies the code in constant time, registers the device, marks
   the invite used, returns `PairResult` (device id, room, bridge display name,
   capabilities) and closes the channel.
7. The browser stores the device record in the encrypted vault.

### 4.4 Reconnect

The browser opens a channel and runs `ik` using the stored bridge static key;
the bridge verifies that the initiator's static key equals a registered,
non-revoked, non-expired device key. No token is used, so a leaked relay cannot
replay a pairing.

Request dispatch per device is serialized: the bridge processes one request per
device at a time, so a slow adapter call cannot interleave with another.

### 4.5 Expiry and revocation

- Default device TTL is 30 days (`bridge devices ttl …`; allowed values
  `manual|1h|24h|7d|30d`; maximum 30 days).
- Expiry and revocation are re-checked every 60 s.
- `revoke` deletes the device locally and tells the relay to close matching
  browser sockets (close code 4003, "device revoked"); the browser drops the
  record after the failed reconnect.
- A browser can revoke or rename **only itself** via `device.revoke` /
  `device.rename`. Other devices are managed on the Mac.
- Replacing a bridge closes the previous bridge socket (4001). A bridge going
  offline closes all browser sockets (4002).

## 5. Relay protocol

`RELAY_PROTOCOL_VERSION = 2`, path `/v1/ws`.

### 5.1 Frames

- **Binary** — `channelId (16 bytes) || Noise ciphertext`. The relay forwards
  to the other peer of that channel and never inspects the ciphertext.
- **Text** — control JSON:

| Message | Direction | Meaning |
| --- | --- | --- |
| `hello` | both | Role (`bridge` or browser), room id, credential (bridge token hash or invite hash) |
| `ready` | relay | Accepted; bridge marked online |
| `channel.open` | both | Open a channel with a given 16-byte id |
| `channel.close` | both | Close a channel |
| `peer.state` | relay | Peer online/offline changes |
| `ping` / `pong` | both | Keepalive |

Limits: relay frame max 64 KiB, control message max 8 KiB, `hello` timeout 5 s.

### 5.2 Room state

The `Room` Durable Object holds two tables (`invites`, `devices`) and meta keys
(`room_id`, `bridge_hash`, `created_at`, `last_seen`). It enforces:

- Invite TTL 30–600 s, single use, token hash only.
- Device reconnect tokens stored as `SHA-256(token)`; device record TTL up to
  30 days.
- A browser cannot connect to an unclaimed room.
- Idle rooms are cleaned after 30 days: invites, devices and sockets are
  deleted, but the claim anchors (`room_id`, `bridge_hash`, `created_at`) are
  preserved so the room id stays owned.
- Room touch (`last_seen`) is throttled to once per 60 s.

### 5.3 Rate limits and CORS

- `WS_LIMIT_PER_MIN = 40`, `API_LIMIT_PER_MIN = 120`, per IP.
- In-memory sliding window in `apps/relay/src/rate-limit.ts`, max 10,000 keys,
  evicting empty and then oldest 10%.
- Client IP is taken only from `cf-connecting-ip`; IPv6 addresses are
  aggregated to a /64.
- Browser `Origin` must be the configured `WEB_ORIGIN`, the same origin, or
  loopback. A browser WebSocket with a disallowed origin is refused.
- Room id format: `^[a-z0-9-]{8,64}$`.

## 6. Bridge protocol

`PROTOCOL_VERSION = 1`. Types, method names and constants are in
`packages/protocol/src/index.ts`.

### 6.1 Envelope

Requests are `{ id, method, params }`; responses are `{ id, result }` or
`{ id, error: { code, message } }`; events are `{ event, data }`. The web client
allows 20 s per request by default.

### 6.2 Methods

| Group | Methods |
| --- | --- |
| Host | `host.info`, `host.capabilities`, `app.list`, `project.list` |
| Sessions | `session.list`, `session.get`, `session.rail`, `session.models`, `session.compact`, `session.rename` |
| Messages | `message.list`, `message.send`, `turn.cancel`, `approval.respond`, `task.messages` |
| Hosted | `hosted.dirs.create`, `hosted.stop`, `hosted.resume` |
| Files | `file.upload.begin`, `file.upload.chunk`, `file.upload.finish`, `transfer.prepare`, `transfer.commit`, `fs.roots.list`, `fs.roots.read` |
| Shell | `shell.exec`, `shell.cancel` |
| Devices | `device.list`, `device.revoke`, `device.rename` |
| Push | `push.info`, `push.subscribe`, `push.unsubscribe` |
| Declared, not dispatched | `pair.request` (handled by the pairing session), `session.subscribe`, `session.unsubscribe`, `sync.resume`, `operation.get` |

### 6.3 Events

`EVENT_NAMES` declares `session.updated`, `message.delta`, `message.completed`,
`approval.required`, `capabilities.changed`, `host.status`, `shell.output`.
**Only `shell.output` is actually emitted today.** The chat and list views poll
`message.list` / `session.list` every 5 s, and a background watcher refreshes
the session rail every 10 s, instead of subscribing. This is a deliberate
simplification, not a finished push pipeline.

### 6.4 Limits

| Constant | Value | Applies to |
| --- | --- | --- |
| `MAX_FRAME_BYTES` | 32 KiB | one Noise frame before chunking |
| `MAX_MESSAGE_BYTES` | 4 MiB | reassembled message |
| `MAX_PENDING_MESSAGES` | 8 | concurrent chunked messages |
| `CHUNK_TTL_MS` | 60 s | incomplete chunk sets |
| `RELAY_CHANNEL_BYTES` | 16 | relay channel id |
| `MAX_TRANSFER_CHARS` | 200,000 | transferred text |
| message text | 32,000 chars | composed text after attachment links |
| attachments | 10 per message | `message.send` |
| upload chunk | 32 KiB | `file.upload.chunk` |
| upload size | 25 MB | one file |
| pending uploads | 16 uploads / 100 MB | per bridge |
| upload TTL | 30 min | before completion |
| finished uploads | swept after 7 days | disk |
| session list | 200 default / 500 max | `session.list` |
| message list | 50 default / 200 max | `message.list` |
| transfer TTL | 120 s | `transfer.prepare` → `transfer.commit` |
| shell command | 8,000 chars | `shell.exec` |
| shell timeout | 120 s default / 600 s max | `shell.exec` |
| shell output | 1 MB then killed | `shell.exec` |
| concurrent shells | 8 | per bridge |

Uploads are isolated per owning channel, names are sanitized, and every path is
resolved (symlinks included) and must stay inside the uploads directory.
Transfers are bound to one device and consumed before use.

## 7. Adapters

Each adapter implements the same shape: `enumerate()`, `read()`, `send()`,
`capabilities()`, and optionally compact/rename. Capabilities are advertised per
session, so the UI hides what an agent cannot do.

### `claude-code` — Claude Desktop · Code (provider: anthropic)

- **Data:** `~/Library/Application Support/Claude-3p/claude-code-sessions` and
  the `Claude` equivalents, plus `~/.claude/projects` and `~/.claude/sessions`.
- **Read:** partial — visible conversation, not every tool result.
- **Send:** wakes the desktop app with a deep link, then writes a peer envelope
  into `/tmp/cc-socks/<pid>.sock`.
- **Create:** no.
- **Caveat:** because the message arrives as a peer/cross-session message, the
  session may refuse to treat an "approve" as the user's decision. This is the
  core limitation described in `REMOTE_APPROVAL.zh-CN.md`.

### `claude-code-cli` — Claude Code · CLI

- **Data:** `~/.claude` session stores.
- **Send:** to a running CLI through `/tmp/cc-socks` when available, otherwise
  spawns `claude --resume <id> -p <text>` for a one-shot turn.
- **Read:** partial. **Create:** no.

### `codex` — ChatGPT Desktop · Codex (provider: openai)

- **Data:** the app's SQLite catalog and session database plus
  `~/.codex/ipc/ipc.sock`.
- **Send:** IPC methods `thread-owner-discovery`,
  `thread-follower-start-turn`; only works for a thread that is currently open in
  the app.
- **Compact:** native, via `thread-follower-compact-thread`.
- **Read:** full for the visible thread. **Create:** no.

### `codex-cli` — Codex · CLI

- **Send:** `codex queue --thread <id>` for a running session, otherwise
  `codex exec resume`.
- **Read:** partial. **Create:** no.

### `antigravity` — Antigravity CLI (provider: google)

- **Data:** `~/.gemini/antigravity-cli` SQLite plus protobuf conversation blobs.
- **Send:** `agy --conversation <id> --print <text>`.
- **Restriction:** cannot send while the session is running. **Create:** no.

### `antigravity-desktop` — Antigravity Desktop (provider: google)

- **Data:** `~/.gemini/antigravity` through the language-server RPC.
- **Read only.** `send()` throws `unsupported`.

### `dsh` — DeepSeek Harness (provider: deepseek)

- **Data:** `~/.dsh/sessions/*.jsonl.zstd` (zstd-compressed JSONL).
- **Send:** `dsh --profile headless --session-id <id>`.
- **Read:** full. **Create:** no.

### `hosted` — Claude Code · Hosted by Bridge

Full enumerate/read/send/create. See [section 8](#8-hosted-sessions).

## 8. Hosted sessions

### 8.1 Why it exists

Every other adapter is a guest in someone else's process. A hosted session is
the opposite: the bridge spawns the CLI, owns stdin/stdout, and therefore sees
permission requests as first-class protocol objects it can render as buttons and
answer on the user's behalf.

### 8.2 Process model

```
claude -p
  --input-format stream-json --output-format stream-json --verbose
  --permission-mode <manual|acceptEdits|auto|bypassPermissions|dontAsk|plan>
  --permission-prompts host --permission-prompt-tool stdio
  [--session-id <uuid> | --resume <uuid>] [--model <id>]
```

- Permission mode defaults to `manual`; every tool request becomes a pending
  `next-step` block in the chat with Allow / Deny.
- `bypassPermissions` is accepted only when `allowBypassPermissions` is true in
  `hosted.json`; otherwise creation and resume of such sessions are rejected.
- Model ids are validated against `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$`.
- Stream events handled: assistant, system, `control_request`, result.
  `AskUserQuestion` becomes an `ask` block; a permission request becomes a
  pending block. Text answers are also accepted: `允许 / 批准 / 同意 / 可以 /
  allow / yes`, and `拒绝 / deny / no`.

### 8.3 Lifecycle

- A supervisor sweeps every 60 s and stops processes idle longer than
  `idleTimeoutMs` (default 30 min, min 60 s): SIGTERM, then SIGKILL after 2 s.
- Sending a message to a stopped session resumes it (`--resume`), preserving the
  CLI conversation.
- If `--resume` fails because the conversation no longer exists, the bridge
  retries with `--session-id`, starting a fresh conversation with a new id and a
  visible note.
- Transcripts are appended to `$AGENT_BRIDGE_HOME/hosted/<id>.jsonl`; the
  registry is `hosted/sessions.json`.
- Context usage is computed from the CLI `usage` field (input + cache read +
  cache write) against a 200k window, or 1M for models whose id contains `[1m]`,
  `-1m` or `1m-context`. The gauge offers a compact action: native compact when
  the adapter supports it, otherwise it copies `/compact` for the user to send.
- Hosted sessions never appear in the Claude desktop app.

### 8.4 Directory allowlist

`hosted.json` `dirs` are absolute paths, `~`-expanded and `realpath`ed before
comparison, so a symlink cannot escape the allowlist. Only allowlisted
directories appear as hosted projects. Changing the file requires restarting the
bridge.

## 9. Remote devtools

Two independent switches, both **off by default**, both with a TTL of 60 s to
24 h:

```
agent-bridge devtools [files|terminal|all] [on|off|status] [--ttl 60..86400]
```

### Files

- Confined to the session's project directory; a worktree at `session.cwd` is
  allowed.
- Read-only. Symlinks are resolved and must remain inside the root.
- `node_modules` and `.git` are hidden.
- At most 2,000 entries per listing; text files up to 1 MB; images up to ~3 MB
  (headroom under the 4 MiB message limit).
- Binary files are detected by a NUL byte and rejected.

### Terminal

- One command per request, max 8 concurrent.
- Runs `$SHELL -lc <command>` in its own process group; on timeout or cancel the
  group gets SIGTERM, then SIGKILL.
- Output is capped at 1 MB, after which the process is killed.
- Only the owning channel can cancel its commands; closing the channel kills
  them.
- Expiry of the terminal switch kills all running commands.

Both switches are visible in the admin API snapshot, so the Mac always knows
what is currently exposed.

## 10. Web client

Framework-free TypeScript, built by Vite, shipped as a PWA.

### Routes

| Route | View |
| --- | --- |
| `#/clients` | Agent cards with session counts |
| `#/devices` | Paired devices |
| `#/clients/:appId` | Projects for one agent |
| `#/clients/:appId/projects/:projectId` | Sessions in one project |
| `#/clients/:appId/projects/:projectId/sessions/:sessionId` | Chat |
| `…/sessions/:sessionId/tasks/:taskId` | Background task detail |

The session rail exposes environment, context usage, MCP servers and background
tasks where available. The model chip is display-only; the model is chosen on
the Mac (except when creating a hosted session).

### Behaviour

- Pairing link handling, vault setup/unlock, multi-device switching.
- Polling: chat and list views poll every 5 s, the background session watcher
  every 10 s, and the client version every 60 s. Polling pauses when the tab is
  hidden and skips while a request is in flight.
- Composer: text plus up to 10 attachments, markdown image/file links appended
  to the outbound text; a transfer preview lets the user inspect and edit a
  message being moved between sessions.
- Rename, compact, cancel turn, approval buttons, slash-command hints for
  hosted sessions, and a form-preservation guard so a re-render does not wipe
  what the user is typing.
- PWA install plus Web Push subscription.
- The UI is `zh-CN` only. There is no i18n layer.

### Content security

`index.html` declares a strict CSP: `default-src 'self'`,
`script-src 'self' 'wasm-unsafe-eval'`, `connect-src https: wss:`,
`frame-ancestors 'none'`. The service worker only handles push and
notification clicks for same-origin URLs.

## 11. Notifications

- VAPID keys are generated locally and stored in `bridge.db` meta
  (`push_vapid`); they never leave the Mac except as the public key in
  `push.info`.
- The browser subscribes with `push.subscribe`; subscriptions are stored in the
  `push_subscriptions` table.
- Notification triggers: a turn completed, or a session newly needs a decision.
  State is polled every 10 s; sessions stale for more than 12 h are skipped.
- The notification URL deep-links to the session.

Web Push requires HTTPS and a browser that supports it; iOS requires the PWA to
be installed to the home screen.

## 12. State, backup and recovery

Default state directory:
`~/Library/Application Support/AgentBridge`, overridable with
`AGENT_BRIDGE_HOME`.

| Path | Contents |
| --- | --- |
| `bridge.db` | SQLite, WAL: `meta`, `devices`, `invites`, `device_events` (last 200 per device), `push_subscriptions`, `session_titles` |
| `identity.json` | Noise static identity |
| `hosted.json` | Hosted allowlist and policy (you create this) |
| `hosted/<id>.jsonl` | Hosted transcripts |
| `hosted/sessions.json` | Hosted session registry |
| `admin-port` | Admin port for this state directory |
| `admin-token` | Admin bearer token, mode 0600 |

The directory is created 0700 and the database 0600.

- **Backup:** copy the whole directory while the daemon is stopped. Device pairs
  and hosted transcripts survive; the noise identity must be preserved, or every
  device must re-pair.
- **Reset pairings:** delete `bridge.db` (and `identity.json`) and run `init`
  again, or revoke devices individually.
- **Preview vs production on one Mac:** use a different `AGENT_BRIDGE_HOME` per
  environment. The admin port file is per state directory, which is why both can
  run at once (47825 production, 47826 preview).
- **Relay URL migration:** the store migrates the old preview relay URL
  `https://agent-bridge-preview.gowinder.workers.dev` to
  `https://agent-bridge-preview.craftstead.app` automatically.

## 13. Admin API

Used by the menu bar app; usable directly with `curl`.

- Bind: `127.0.0.1` only.
- Port resolution: `AGENT_BRIDGE_ADMIN_PORT` → `admin-port` file → legacy meta →
  default (47826 preview, 47825 production; preview is inferred when the relay
  host contains `preview`/`staging`, or set explicitly with
  `AGENT_BRIDGE_ENV`).
- Auth: `Authorization: Bearer <contents of admin-token>`, compared in constant
  time. A request whose `Host` header is not a loopback name is rejected, and
  requests carrying an `Origin` header are rejected (browsers cannot call it).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | Devices, connections, devtools state, pairings, version |
| POST | `/invite` | Mint an invite (TTL clamped to 30–600 s) |
| POST | `/devtools` | Toggle files/terminal and TTL |
| POST | `/devices/disconnect-all` | Close all browser sockets |
| POST | `/devices/revoke-all` | Revoke every device |
| POST | `/devices/:id/disconnect` | Close one device's sockets |
| POST | `/devices/:id/revoke` | Revoke one device |

## 14. Deployment

`wrangler.toml` defines one Worker, `agent-bridge-relay`, with:

- Durable Object binding `ROOMS` → class `Room`, SQLite migration `v1`.
- Static assets from `../web/dist` with SPA fallback and
  `run_worker_first = ["/v1/*"]`.
- Production: custom domain `agent-bridge.craftstead.app`.
- Preview: worker `agent-bridge-preview`, custom domain
  `agent-bridge-preview.craftstead.app`, `workers_dev = false`.

CI (`.github/workflows/deploy.yml`): Node 24, Rust wasm target, `npm ci`,
`build:wasm`, `npm run check`, web build, then `wrangler deploy` — preview on
`develop` when the root version changed; production on `main` when the root
version changed or a `vX.Y.Z` tag on `main` matches the package version.
Prerelease tags never reach production.

Release (`.github/workflows/release.yml`): macOS runner, universal Node runtime,
`AgentBridge.app`, DMG, SHA-256, GitHub Release on `v*` (prerelease if the tag
has a hyphen). Signing and notarisation require the Apple secrets; without them
the DMG is unsigned. Stable releases can dispatch a `repository_dispatch` to the
homepage repository.

Branch rules (from `AGENTS.md`): feature branches from `develop`, PRs only,
never push directly, `develop` → preview and `main` → production. A production
release needs a version bump in the root `package.json` plus lockfile, a
`chore(release): <version>` commit and a `CHANGELOG.md` entry. `npm run check`
runs before committing.

## 15. Security hardening

If you expose this to the internet (which is the normal case), do these:

1. **Keep the relay on HTTPS/WSS.** `init` enforces it; only loopback is exempt.
2. **Keep invite TTL short.** 60–300 s is enough. The invite is a bearer token
   until it is used.
3. **Confirm the 6-digit code out of band.** On a call, or by reading it off the
   Mac's own screen. Do not accept a code read to you by someone else.
4. **Set a vault password.** Without it, the Noise private key sits in
   `localStorage` in a form any script on that origin can read.
5. **Leave devtools off.** Turn them on for a bounded window (`--ttl`) and turn
   them off when done. The terminal is a real shell in your project.
6. **Keep `allowBypassPermissions` false** unless you deliberately want
   unattended tool execution.
7. **Revoke devices you no longer use.** The list is in the web client and in
   `bridge devices`.
8. **Keep the admin token private.** It is 0600, but anything reading it as your
   user can mint invites.
9. **Do not reuse a room id across machines.** Claim is first-come and permanent
   until the relay clears the room.
10. **Treat hosted transcripts as sensitive.** They contain full conversations
    and live unencrypted in the state directory.

What the relay can still do: deny service, delay or drop frames, correlate
traffic by timing and frame size, and observe which room ids are active. What it
cannot do: read or modify messages, forge a pairing, or impersonate a bridge to
an already-paired device.

## 16. Limitations and known issues

### Protocol

- `session.subscribe`, `session.unsubscribe`, `sync.resume` and `operation.get`
  are in `METHODS` but not dispatched by `apps/bridge/src/sessions.ts`. Calling
  them returns an unsupported-method error.
- Only `shell.output` is emitted as an event. Chat and list views poll.
- No protocol negotiation beyond `PROTOCOL_VERSION`; a mismatched client and
  bridge fail at the first unknown method rather than downgrading.

### Adapters

- Browsers cannot create sessions outside the hosted adapter.
- `claude-code`, `claude-code-cli`, `codex`, `codex-cli`, `antigravity` and
  `dsh` can lose history detail (tool output, attachments, system turns) because
  they read stores that were not designed as a public API. A desktop app update
  can break an adapter.
- `antigravity-desktop` is read-only.
- `antigravity` cannot send while the session is running.
- `codex` can only send to a thread that is open in the app.
- Remote approval of a desktop session is unreliable: the injected message is
  peer input, and the agent may refuse to treat it as the user's decision. Use a
  hosted session for approvals, or do the final step on the Mac.
- `claude --resume -p` one-shot turns are a spike-quality path: they start a new
  process, may re-read context, and can conflict with a running session.

### Hosted sessions

- Claude Code only; there is no hosted Codex or hosted Antigravity.
- The transitive model list and permission modes depend on the installed CLI
  version.
- A resume after the CLI drops the conversation silently starts a new
  conversation id.

### Platform

- macOS 13+ only for the menu bar app; the daemon itself is portable Node.
- Adapters read macOS-specific paths.
- The DMG is unsigned unless Apple secrets are configured.
- Web Push on iOS requires the PWA installed on the home screen.
- No mobile app; the PWA is the mobile experience.

### Operations

- One bridge per room; a second Mac is rejected.
- The relay's rate limiter is in-memory per Worker isolate, so limits are
  approximate across colos.
- Idle rooms are cleaned after 30 days; devices must re-pair after that.
- Transcripts and `bridge.db` are not encrypted at rest.
- The web UI is Chinese only.
- No multi-user model: one room belongs to one person, and every paired device
  has full access to every session the bridge exposes.

## 17. Troubleshooting

**No pairing link works / relay says the room is unclaimed**
The bridge must be connected first: check `agent-bridge status` and the menu bar
icon. If the room was previously claimed by another Mac, the relay refuses this
one; clear the room or use a new room id.

**`init` fails on the health check**
The relay URL must be reachable and serve `/v1/health` over HTTPS (or loopback).
Check DNS and any proxy.

**Browser pairs, then immediately disconnects**
Usually a device TTL or revocation: `agent-bridge devices`. Also check that the
invite had not already been used, and that the confirmation code matched on both
sides.

**Pairing works but every request fails**
`wasm/noise.wasm` missing in a source build: run
`npm run build:wasm -w @craftstead/crypto` and rebuild.

**The vault keeps asking for the password**
The 30-minute unlock window expired, or `localStorage` was cleared. If the
password is lost, reset the vault and re-pair.

**The menu bar app cannot control the bridge**
Port mismatch. `agent-bridge port` prints the current port; the app writes
`admin-port` in the state directory. A preview and a production bridge must use
different `AGENT_BRIDGE_HOME`.

**A desktop session does not accept my approval**
Expected — see [Limitations](#16-limitations-and-known-issues). Use a hosted
session.

**A hosted session will not start**
Check (in order): the directory is in `hosted.json` `dirs` and the file was
saved before the bridge started; the CLI is found (`cliPath`, then
`AGENT_BRIDGE_CLAUDE_PATH`, then `PATH`); the requested permission mode is
allowed (`bypassPermissions` needs the flag).

**The context gauge is wrong**
It is computed from the CLI `usage` fields; a missing or unusual usage shape
falls back to the 200k window. Long-context models are detected by id substring.

**Notifications do not arrive**
Web Push needs HTTPS, a granted permission, and a live subscription — re-enable
it from the session list. iOS needs the PWA on the home screen. The bridge polls
for state changes every 10 s, so expect a short delay.

**Nothing shows up after an agent update**
An adapter reads an undocumented store. Check the daemon's stdout logs (the
`serve` process prints them). Compare against the adapter's expected paths in
`apps/bridge/src/adapters/`. Run `npm test` to see whether the fixtures still
parse.
