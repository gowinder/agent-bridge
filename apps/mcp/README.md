# Agent Bridge MCP

A stdio MCP server that lets an agent running on another machine drive the
**pi** / **Claude Code** sessions that Agent Bridge hosts on your Mac.

> **中文快速开始**（10 行内跑通；细节见下文英文部分）
>
> 1. Mac 上 Agent Bridge（菜单栏 app 或 `bridge serve`）保持运行；本机装 Node 22+。
> 2. `git clone https://github.com/gowinder/agent-bridge.git && cd agent-bridge && npm ci && npm run build:wasm -w @craftstead/crypto && npm run build`
> 3. Mac 上 `npm run bridge -- invite --ttl 600`，把整条链接写进本机文件 `~/invite.txt`（别贴进聊天）。
> 4. 本机 `node apps/mcp/server/pair.mjs --invite-file ~/invite.txt`，比对终端里的 6 位码与 Mac 侧（菜单栏，或 `~/Library/Application Support/AgentBridge/bridge.log` 里的「配对握手完成，确认码 NNNNNN」）。
> 5. 一致时 `printf yes > ~/.agent-bridge/mcp/confirm`；看到「配对成功」后 `echo '{}' > /tmp/ab.json`。
> 6. `node apps/mcp/bin/client.mjs call-tool --name bridge_status --arguments-file /tmp/ab.json` → 出现 `"connected": true` 即通。
> 7. 把 `<repo>/apps/mcp/server/index.mjs` 的绝对路径配进 MCP host（stdio，`command: node`），见下方 "MCP host configuration"。

## Contents

- [What it is / what it is not](#what-it-is--what-it-is-not)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [MCP host configuration](#mcp-host-configuration)
- [Pairing](#pairing)
- [Verify the connection](#verify-the-connection)
- [First task](#first-task)
- [Launch profile](#launch-profile)
- [Tool surface](#tool-surface)
- [Listener (optional)](#listener-optional)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Self-checks](#self-checks)

## What it is / what it is not

**It is** a stdio MCP server that runs on the *calling* machine (a cloud agent
VM, or your own laptop) and relays requests through Agent Bridge to the Mac: it
can start a hosted `pi` / `claude` session in an allowlisted directory, send it a
message, read the reply, wait for the turn to finish, stop and archive it. Nine
tools, one bridge connection, no inbound port on either side.

**It is not**:

- not a remote shell — no `shell.exec`, no file reads/writes, no `device.*`,
  `file.upload.*`, `transfer.*`, `hosted.delete`, `push.*`, `approval.respond`;
  those protocol methods are not mapped, and the MCP server does not call them
  internally either (`device.list` is used once inside `bridge_status` for a
  self-check, and is not a tool);
- not a way to reach your filesystem — it only touches sessions in its own
  registry (`<state>/registry.json`), created by `session_open` or adopted by an
  explicit `session_adopt`;
- not a bypass of the hosted allowlist — `session_open` refuses a `cwd` that the
  Mac has not allowlisted, and remote devices cannot add directories (the bridge
  answers `hosted.addDir` with `unsupported` by design);
- not a new crypto channel — the relay still only sees Noise ciphertext.

## Prerequisites

1. **Agent Bridge running on a Mac** — the menu bar app, or `npm run bridge -- serve`
   for a headless machine. It must be online on the relay.
2. **A hosted engine installed on the Mac** — `pi`, or `claude` for
   `engine: "claude"`. Hosted sessions must be enabled in the bridge settings.
3. **Node on the machine that runs this MCP server** (a Muse VM or your own
   machine). `package.json` declares `engines: >=22` because the relay connection
   uses the built-in `WebSocket`, which Node only exposes by default from 22 —
   Node 20.19 has `typeof WebSocket === "undefined"`. Use **Node 22 or newer**.
   Nothing needs to be installed on the Mac for this app.
4. **The directory you want to work in is already allowlisted on the Mac.**
   `hosted.json` → `dirs`, or the menu bar app's settings. A paired remote device
   cannot add a directory; if `session_open` returns `cwd_not_allowlisted` the
   list of usable directories is in the error's `details.allowlistedDirs`.

## Install

Two routes: the published npm package, or a clone of this repository.

### Route A — npm (recommended)

The package is `@craftstead/agent-bridge-mcp`. It pulls `@craftstead/crypto` and
`@craftstead/protocol` from the registry, and the crypto tarball already carries
`wasm/noise.wasm`, so this route needs neither a Rust toolchain nor a repo build:

```sh
npx -y @craftstead/agent-bridge-mcp        # spawns the stdio server (bin: agent-bridge-mcp)
npm i -g @craftstead/agent-bridge-mcp     # or install once; the four bins go on PATH
```

With a global install the commands below that are written as
`node apps/mcp/…` become the packaged bins instead: `agent-bridge-mcp`,
`agent-bridge-mcp-pair`, `agent-bridge-mcp-client`, `agent-bridge-mcp-listen`.

### Route B — from a clone

Run everything from the repository root — in the workspace `apps/mcp` imports
`@craftstead/crypto` and `@craftstead/protocol` from the monorepo, so
`server/index.mjs` cannot be copied out of the repo.

```sh
git clone https://github.com/gowinder/agent-bridge.git
cd agent-bridge
npm ci
npm run build:wasm -w @craftstead/crypto   # Rust Noise module → packages/crypto/wasm/noise.wasm
npm run build                              # tsc -b across all workspaces
```

`build:wasm` needs a Rust toolchain with the wasm target:

```sh
rustup target add wasm32-unknown-unknown
```

`packages/crypto/wasm/*.wasm` is gitignored, so a fresh clone has no
`noise.wasm` and the MCP server fails with `wasm_unavailable`. If you cannot
build it, take the identical file from an installed Agent Bridge release and
drop it in place:

```sh
cp "/Applications/AgentBridge.app/Contents/Resources/bridge/node_modules/@craftstead/crypto/wasm/noise.wasm" \
   packages/crypto/wasm/noise.wasm
```

(Copy it out of the released DMG the same way if the app is not in
`/Applications`; the file ships at that path inside the bundle.)

Check the install without touching the network:

```sh
node apps/mcp/server/index.mjs < /dev/null
# [agent-bridge] Agent Bridge MCP v0.1.0 就绪（stdio）
node apps/mcp/bin/client.mjs list-tools
# JSON: protocolVersion, allowedTools[], tools[] …
```

## MCP host configuration

The server speaks MCP over stdio, so any host that can spawn a process works.
Point `command` at `node` and `args[0]` at the **absolute** path of
`<repo>/apps/mcp/server/index.mjs`:

```json
{
  "mcpServers": {
    "agent-bridge": {
      "command": "node",
      "args": ["/Users/you/code/agent-bridge/apps/mcp/server/index.mjs"],
      "env": {
        "AGENT_BRIDGE_MCP_HOME": "/Users/you/.agent-bridge/mcp"
      }
    }
  }
}
```

- `env` is optional; without it the state directory is `~/.agent-bridge/mcp`
  (see [Pairing](#pairing) for the full rule). `AGENT_BRIDGE_MCP_HOME` must be
  an **absolute** path — a relative value is ignored and the default is used.
- The host's working directory does not matter; module resolution is relative to
  the script path, so keep this clone where it is.
- stdout carries JSON-RPC only. Human-readable logs go to stderr, so a host that
  shows server logs will display lines prefixed `[agent-bridge]`; set
  `AGENT_BRIDGE_DEBUG=1` in `env` to get the `[agent-bridge debug]` lines about
  channel setup and `hosted.create`.

**Exec-only runtimes.** Some runtimes (Muse) cannot hold a long-lived stdio
session; drive the same server through the bundled CLI instead. It spawns the
server itself, does `initialize` → `tools/list` / `tools/call`, prints the tool
result as JSON on stdout, and only allows the nine reviewed tools:

```sh
node apps/mcp/bin/client.mjs list-tools
node apps/mcp/bin/client.mjs call-tool --name bridge_status --arguments-file /tmp/ab-args.json
```

`--arguments-file` is **required**, even for a tool that takes no arguments —
write `{}` into the file. Exit codes: `0` success, `1` tool error / JSON-RPC
error / timeout, `2` usage error or a tool outside `ALLOWED_TOOLS`.

## Pairing

Pairing is a one-time, human-confirmed step: the MCP server gets its own device
identity, which the Mac stores like any other paired browser. The invite is
single-use and must not be pasted into a chat.

1. **Mac: mint an invite** (10 minutes):

   ```sh
   npm run bridge -- invite --ttl 600
   ```

   The menu bar app can mint the same link. It looks like
   `https://agent-bridge.craftstead.app/#/pair?relay=…&room=…&invite=…`.

2. **Calling machine: write the whole link to a local file** — keep the `#/pair?…`
   fragment, that part never leaves the machine:

   ```sh
   $EDITOR ~/invite.txt
   ```

3. **Run the pairing command.** It prints the six-digit confirmation code:

   ```sh
   node apps/mcp/server/pair.mjs --invite-file ~/invite.txt
   # optional: --name "Ada on Muse"      (default device name: Muse (MCP))
   # optional: --allow-relay             (only for a self-hosted / preview relay)
   ```

   ```text
   ==============================================
     配对确认码：123456
     核对 Mac 菜单栏上的码是否一致（不一致就写 no）
   ==============================================
   ```

   The code is derived from both public keys. Compare it with the Mac: the menu
   bar app's pairing screen, or the bridge log
   (`~/Library/Application Support/AgentBridge/bridge.log`) line
   `配对握手完成，确认码 123456`.

4. **Confirm from the calling machine** by writing the file the command tells you
   about (default below). `yes` continues, anything else aborts, and the command
   gives up after 240 s:

   ```sh
   printf yes > ~/.agent-bridge/mcp/confirm
   ```

5. **Success looks like this** — the identity is written with mode `0600`, the
   device shows up in `device.list`, and the token is never printed:

   ```text
   配对成功，身份已落盘（0600，不会打印令牌）：
     /Users/you/.agent-bridge/mcp/identity.json
     设备：<deviceId>（Muse (MCP)）
     bridge：<name> <version> / darwin
     device.list 自查：✓ 在列（2 台设备，clientType=mcp）
   ```

**State directory** — resolved the same way by every command (`--state-dir` on
`pair.mjs` sets it explicitly):

1. `--state-dir <abs path>` (pair.mjs only)
2. `$AGENT_BRIDGE_MCP_HOME` (must be absolute)
3. `$XDG_CONFIG_HOME/agent-bridge/mcp`
4. `~/.agent-bridge/mcp`

The directory is created `0700` and every file in it is written `0600`:
`identity.json` (device key + reconnect token), `registry.json` (which sessions
this device owns), `profile.json` (launch preferences), `confirm` (transient).

**Re-pairing** is refused while `identity.json` exists. Delete the state
directory first, then mint a fresh invite:

```sh
rm -rf ~/.agent-bridge/mcp
```

## Verify the connection

```sh
echo '{}' > /tmp/ab-args.json
node apps/mcp/bin/client.mjs call-tool --name bridge_status --arguments-file /tmp/ab-args.json
```

Expect, among other fields:

```json
{
  "ok": true,
  "connected": true,
  "device": {
    "deviceName": "Muse (MCP)",
    "clientType": "mcp",
    "clientTypeInBridge": "mcp",
    "presentInDeviceList": true,
    "revokedAt": null
  },
  "devices": [{ "name": "Muse (MCP)", "clientType": "mcp", "self": true }],
  "registry": { "sessions": 0, "active": 0 }
}
```

`ok:false` means the connection failed; the `error.code` tells you why — see
[Troubleshooting](#troubleshooting). Before pairing this tool returns exactly
`ok:false` with `error.code: "unpaired"` and a hint that lists the pairing
commands, so it doubles as the "is this machine set up?" check.
`bridge_status` is read-only and safe to run repeatedly.

## First task

The session model is **get-or-create**: a session is keyed by
`(engine, cwd, purpose)`, and `purpose` is normalised (trimmed, lowercased,
whitespace collapsed), so `"MCP Smoke"` and `"mcp smoke"` are the same line of
work. Reuse the same `purpose` to continue where you left off; use a new one when
you want a fresh conversation.

Every `call-tool` call takes a JSON object file:

```sh
cat > /tmp/open.json <<'JSON'
{ "cwd": "/Users/you/code/scratch", "purpose": "mcp-smoke" }
JSON
node apps/mcp/bin/client.mjs call-tool --name session_open --arguments-file /tmp/open.json
```

```json
{
  "ok": true,
  "reused": false,
  "reason": "created",
  "session": { "sessionId": "hosted:<uuid>", "title": "MCP · mcp-smoke", "busy": false, "hosted": true },
  "registry": { "sessionId": "hosted:<uuid>", "title": "MCP · mcp-smoke", "archived": false },
  "tag": "MCP",
  "createParams": { "path": "/Users/you/code/scratch", "agent": "pi", "title": "MCP · mcp-smoke" }
}
```

`cwd` must be an absolute path inside the Mac's hosted allowlist. `createParams`
contains only the non-empty preferences, so an empty `profile.json` really means
"let the CLI decide". A cold `pi` start takes roughly 8 s. The session is tagged
`MCP` and titled `MCP · <purpose>` on the Mac so the owner can tell it apart.

Send work:

```sh
cat > /tmp/send.json <<'JSON'
{ "sessionId": "hosted:<uuid>", "text": "Reply with exactly: mcp ok" }
JSON
node apps/mcp/bin/client.mjs call-tool --name session_send --arguments-file /tmp/send.json
```

```json
{
  "ok": true, "accepted": true, "delivered": true,
  "operationId": "<uuid>", "promptSuffixApplied": false,
  "audit": { "messageSha256": "…", "chars": 26, "note": "登记册只存消息哈希与元数据，不存全文。" }
}
```

Only one in-flight turn per session is allowed. While one is running,
`session_send` fails with `session_busy` instead of queueing, so pass a stable
`operationId` when you retry after a timeout — the server dedupes on it and will
not deliver the same message twice.

Get the result:

```sh
cat > /tmp/wait.json <<'JSON'
{ "sessionId": "hosted:<uuid>", "timeoutMs": 120000 }
JSON
node apps/mcp/bin/client.mjs call-tool --name session_wait --arguments-file /tmp/wait.json
```

`session_wait` polls the bridge every 5 s until `busy` turns false or the timeout
expires (default 120 s, max 600 s), and returns the messages that appeared while
it waited (`newMessages[].text`, full text, never summarised). Two consequences:

- if the turn is still running at the deadline you get `timedOut: true` and
  `busy: true` — call `session_wait` again with the remaining time;
- if the turn finished **before** you called `session_wait`, there is nothing new
  to observe: it returns after a 15 s idle grace with `newMessageCount: 0` and
  `"note": "会话当前空闲，等待期间没有新消息。"`. That is not an error — read the
  transcript with `session_read`:

```sh
cat > /tmp/read.json <<'JSON'
{ "sessionId": "hosted:<uuid>", "limit": 20 }
JSON
node apps/mcp/bin/client.mjs call-tool --name session_read --arguments-file /tmp/read.json
```

`session_read` returns the last `limit` messages (default 20, max 100) plus
`busy`, `nextBefore` for paging, and — when the hosted agent ended its turn by
asking a question — `needsUser: true` with `needsUserMessage`. Relay that text to
the user verbatim; then send their answer back with `session_send`.

Finish, and free the Mac's process:

```sh
cat > /tmp/archive.json <<'JSON'
{ "sessionId": "hosted:<uuid>" }
JSON
node apps/mcp/bin/client.mjs call-tool --name session_archive --arguments-file /tmp/archive.json
# → "archived": true, "registry": { "archived": true }
```

An archived session does not block reuse: the next `session_open` with the same
`(engine, cwd, purpose)` creates a new one and says
`reason: "replaced_missing_or_archived"`.

## Launch profile

`<state>/profile.json` holds the default engine and model preferences for new
sessions. It is created on first use with every preference empty:

```json
{
  "engine": "pi",
  "model": "",
  "thinking": "",
  "subagentModel": "",
  "subagentThinking": "",
  "promptSuffix": "",
  "relayUrl": "wss://agent-bridge.craftstead.app",
  "modeA": false
}
```

| Field | Meaning |
| --- | --- |
| `engine` | `pi` or `claude`. Default `pi`. |
| `model`, `thinking`, `subagentModel`, `subagentThinking` | Passed to `hosted.create` for `pi`. An empty string means *do not send the parameter* and let the CLI's own default apply. `session_open` arguments override these per call. |
| `promptSuffix` | Appended to the end of every `session_send` message (visible in the transcript, no hidden injection). Empty = off; `useSubagent: false` skips it for one message. |
| `relayUrl` | Relay origin. `wss://` and `https://` are normalised to the same origin. Change it for a self-hosted or preview relay. |
| `modeA` | When `true`, a question from the hosted agent is still reported as `needsUser: true`, but without `needsUserMessage`: the host is told an answer is needed and not given the text to relay, so the user answers in the Mac-side session UI. Default `false` (the question text is returned for verbatim relay). |

`profile.example.json` in this directory is the shipped default profile
(all optional fields empty) — copy it and fill in the model ids your own `pi`
accepts, and only add a `promptSuffix` if you want one appended to every
message:

```sh
cp apps/mcp/profile.example.json ~/.agent-bridge/mcp/profile.json
$EDITOR ~/.agent-bridge/mcp/profile.json
```

Model names are passed through verbatim. If `pi` rejects one, report its error
as-is rather than guessing a replacement. The profile is re-read on every tool
call, so a change applies to the next call with no server restart (sessions that
already exist keep their model).

## Tool surface

| Tool | Kind | Notes |
| --- | --- | --- |
| `bridge_status` | read | Connection, device, relay, bridge version, `device.list` self-check, registry summary. |
| `session_list` | read | Registry sessions only, with live `busy`/`hosted`/`archived` state. `includeArchived` defaults to false. |
| `session_open` | write | get-or-create by `(engine, cwd, purpose)`; `cwd` must be allowlisted. |
| `session_send` | write | One in-flight turn; `operationId` dedupes retries; `session_busy` when a turn is running. |
| `session_read` | read | Last N messages in full, `busy`, `needsUser`, `nextBefore` paging. |
| `session_wait` | read | Polls until the turn ends or the timeout; returns only what is new. |
| `session_stop` | write | Stops the hosted process. |
| `session_archive` | write | Archives (or unarchives with `archived: false`) and marks the registry entry. |
| `session_adopt` | write | Takes over an existing hosted session the user named explicitly. |

## Listener (optional)

`session_wait` blocks the caller. If the calling runtime prefers to poll, the
listener does the watching in the background: it keeps its own bridge connection,
polls every `AB_LISTENER_POLL_MS` (default 15000, minimum 5000), and appends
`completed` / `needs-user` / `gone` events to `<listener state>/events.jsonl` for
sessions you registered with `watch.mjs`. `gone` means the session disappeared from
`session.list` for 3 consecutive polls, and it closes the watch. The host then
drains events cheaply.

It is a **separate device** with its own identity and its own state directory
(default `<state>/listener`, i.e. `~/.agent-bridge/mcp/listener`), because two
connections cannot share one device identity. Pair it with its own invite:

```sh
node apps/mcp/server/pair.mjs --invite-file ~/invite-listener.txt \
  --state-dir ~/.agent-bridge/mcp/listener --name "Muse (MCP) Listener"
printf yes > ~/.agent-bridge/mcp/listener/confirm
```

Then control it (commands below are run from the repository root; the script is
`apps/mcp/bin/listener.sh`):

```sh
bash apps/mcp/bin/listener.sh start     # background start; no-op if already running
bash apps/mcp/bin/listener.sh status    # {"running":…, "pid":…, "stateDir":…, "heartbeat":{…}}
bash apps/mcp/bin/listener.sh stop      # SIGTERM, SIGKILL after 10 s
```

Register the sessions you want events for (this only writes the watch registry;
the listener owns the edge state):

```sh
node apps/mcp/bin/watch.mjs add --session <sessionId> --chat <chatId> --purpose "nightly build"
node apps/mcp/bin/watch.mjs list
node apps/mcp/bin/watch.mjs done --id <watchId>
node apps/mcp/bin/watch.mjs remove --id <watchId>
```

`--chat <chatId>` is your own identifier for the conversation the event belongs
to; it is echoed back in every event line. `add` takes an optional
`--message-count <n>` watermark; without it the listener uses the message count
at its first poll, so older messages are never reported as new output.

Drain events:

```sh
node apps/mcp/bin/drain-events.mjs          # print new events, then advance the cursor
node apps/mcp/bin/drain-events.mjs --peek   # print without advancing (dry run)
```

One line per event, nothing at all when there is nothing new:

```text
[agent-bridge] completed · nightly build · session hosted:<uuid> · chat <chatId>
```

Environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AB_LISTENER_STATE_DIR` | `<state>/listener` | Listener state directory (identity, watches, events, pid, log). |
| `AB_LISTENER_POLL_MS` | `15000` | Poll interval; values below 5000 are raised to 5000. |

Exit codes: the listener exits `2` when it is not paired (it prints the exact
pairing command for its own state directory) and `3` when another instance is
already running.

## Troubleshooting

**The six-digit code does not match, or `pair.request` is rejected.**
The handshake finished against a different peer or the invite was already used.
Write `no` (or Ctrl-C) instead of `yes`, mint a new invite on the Mac, and start
over. Invites are single-use and expire in 30–600 s; a code mismatch closes the
channel, so nothing is retried automatically.

**`pair.mjs` says the relay in the invite does not match `profile.relayUrl`.**
The Mac is on a different relay (preview, or self-hosted) than this device's
profile expects. Point `relayUrl` in `<state>/profile.json` at that relay, or pass
`--allow-relay` if you mean to pair across relays.

**`session_busy`.**
A turn is already running in that session; the message was **not** sent. Call
`session_wait` (or `session_read`) until `busy: false`, then send. Do not retry
the send in a loop. When a send times out, retry with the same `operationId` —
the server has already recorded that delivery and will return the previous
result instead of sending twice.

**`not_in_registry`.**
The `sessionId` was not created by this device (`session_open`) and not adopted.
Either use `session_open` for a new line of work, or — only when the user names
the session explicitly — `session_adopt` with `{ "sessionId": …, "purpose": … }`.

**Relay unreachable.** The error code says which hop failed:

| Code | Meaning / fix |
| --- | --- |
| `unpaired` | No usable identity (`identity.json` missing or incomplete). Run the [pairing](#pairing) steps; the error hint prints the exact paths. |
| `connect_failed` | The relay did not answer or the handshake failed. Check the URL in `<state>/profile.json`, outbound WSS, and that the Mac's bridge is running. |
| `bridge_closed` / `bridge_timeout` | The channel dropped or the Mac did not answer in time. Call again — the next call reconnects with the stored identity. |
| `bridge_offline` | The relay is reachable but the Mac's bridge is not connected. Start the menu bar app (or `bridge serve`) and retry. |
| `channel_in_use` | Another process is using the same device identity. Stop it (only one instance per identity) and retry. |

Other relay refusals (`rate_limited`, `invite_expired`, `invite_used`, …) come
back as `connect_failed` with the relay's own message, or as a
`配对失败：…` line from `pair.mjs`.

**`device_revoked` / `device_expired` / `invalid_credential`.**
The device was revoked on the Mac, its reconnect token expired, or the Mac no
longer knows this key. Re-pair: `rm -rf ~/.agent-bridge/mcp`, then a new invite.

**`cwd_not_allowlisted`.**
The directory is not in the Mac's hosted allowlist — `details.allowlistedDirs`
lists what is. Ask the owner to add it in the menu bar app's settings
(`hosted.json` → `dirs`); a remote device cannot add it. `hosted_disabled` means
hosted sessions are turned off entirely on the Mac.

**`wasm_unavailable`.**
`packages/crypto/wasm/noise.wasm` is missing. Run
`npm run build:wasm -w @craftstead/crypto`, or copy the file out of an installed
Agent Bridge bundle (see [Install](#install)).

**Node is too old.**
The relay connection needs the built-in `WebSocket`: Node 22+ has it by default,
Node 20.19 does not (`--experimental-websocket` only). The symptom is
`connect_failed` with `WebSocket is not defined` in the message, and the server
otherwise looks fine (it starts, `list-tools` works). Check `node -v` first;
CI and releases build on Node 24.

**Anything prefixed `bridge_`.**
Bridge-side rejections are passed through unchanged as `bridge_<code>` (for
example `bridge_invalid_params` for a bad `hosted.create`, `bridge_unsupported`
for a method the bridge refuses). The message is the bridge's own wording; do
not retry blindly, read it.

**`session_not_found` / `not_hosted` / `session_archived` (from `session_adopt`).**
The id does not exist, is not a bridge-hosted session, or is archived. Ask the
user to confirm the id or unarchive it on the Mac; never guess a session id.

## Security

- **The relay sees ciphertext only.** Pairing is a Noise `xxpsk3` handshake with
  the PSK derived from the invite token and room id; reconnects use `ik` with the
  stored device key. The relay forwards opaque frames and channel ids.
- **Invites are single-use.** Only the token's SHA-256 hash reaches the relay,
  the link travels in the URL fragment, and the code is compared by a human on
  both sides before the device is registered.
- **`identity.json` is a credential.** It holds the device private key and the
  reconnect token. The state directory is `0700`, its files `0600`; the keys and
  token are registered with the logger and printed as `[redacted]` even if a
  stack trace would contain them. Never commit it, paste it into a chat, or ship
  it in a log bundle. `.gitignore` excludes the in-repo state paths as a second
  line of defence, but the default location is outside the repository.
- **Revoke from the Mac.** The menu bar app's device list, or
  `npm run bridge -- revoke <deviceId>`. Revocation also closes live sockets, and
  this server then reports `device_revoked` until you pair again.
- **Narrow MCP surface.** Nine tools, mapped onto a reviewed subset of protocol
  methods — no shell, filesystem, device, upload, transfer, delete, push or
  approval methods. `bin/client.mjs` additionally refuses any tool name outside
  its own `ALLOWED_TOOLS` list.
- **Registry gate.** Only sessions this device opened or adopted can be read,
  written, stopped or archived; everything else is `not_in_registry`.

## Self-checks

Fully offline — no network, no Mac, no production instance. Run these inside
`apps/mcp` (or add `-w @craftstead/agent-bridge-mcp` from the repository root):

```sh
npm run check               # node --check on every shipped .mjs in apps/mcp
npm run selftest            # handshake, protocol, profile, registry, message views, unpaired behaviour, redaction
npm run selftest:peer       # request/response/error/timeout paths against an in-memory fake bridge
npm run selftest:listener   # edge detection, watches.json, events, drain cursor, listener.sh start/stop/status
```

From the repository root, `npm run test:mcp` runs all three suites
(`selftest:all` inside the `@craftstead/agent-bridge-mcp` workspace). `npm run check` at the
root is the TypeScript type check for the rest of the monorepo; this app is plain
`.mjs` and is covered by the syntax check above.
