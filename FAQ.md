# Agent Bridge — FAQ

Agent Bridge is an open-source, self-hosted bridge that lets you read and reply to the coding-agent sessions running on your Mac from a phone or any browser, and start new ones in its hosted entry. It is for people who already drive Claude Code, Codex, pi, Antigravity or DeepSeek Harness on a Mac and want that same work reachable from another device without opening a port.

Answers below are for the current release, **0.11.10** (2026-11-23), with the pre-release **0.11.11-rc.1** (2026-11-26) called out where it changes something. Facts and mechanisms: [README.md](README.md). Protocol-level detail: [docs/GUIDE.md](docs/GUIDE.md).

## Contents

- [Can I drive Claude Code or Codex on my Mac from my phone?](#can-i-drive-claude-code-or-codex-on-my-mac-from-my-phone)
- [Does my code or data leave my machine? What can the relay see?](#does-my-code-or-data-leave-my-machine-what-can-the-relay-see)
- [How is this different from just running Claude Code or Codex locally?](#how-is-this-different-from-just-running-claude-code-or-codex-locally)
- [Do I need the ChatGPT app open to use a Codex desktop thread?](#do-i-need-the-chatgpt-app-open-to-use-a-codex-desktop-thread)
- [Which agents and clients are supported? Can another AI connect over MCP?](#which-agents-and-clients-are-supported-can-another-ai-connect-over-mcp)
- [Is it free? What license?](#is-it-free-what-license)
- [Does it run on Windows or Linux?](#does-it-run-on-windows-or-linux)
- [How do approvals work? Who approves a sensitive action?](#how-do-approvals-work-who-approves-a-sensitive-action)
- [Which interface languages are there?](#which-interface-languages-are-there)
- [Where does Bridge keep its data on the Mac?](#where-does-bridge-keep-its-data-on-the-mac)
- [How do I revoke a device?](#how-do-i-revoke-a-device)

## Can I drive Claude Code or Codex on my Mac from my phone?

Yes. Install the menu bar app (macOS 13 or newer), mint a one-time invite — in the app, or `bridge invite --ttl 600` — open the link on the phone, compare the 6-digit code on both sides and confirm. After that the browser reaches every agent adapter the Mac has installed and keeps working across reconnects.

Reading and replying works for both; creating new sessions from the browser works in the hosted entry and, for DeepSeek Harness, as a headless run in a project directory. A Codex *desktop* thread has an extra condition — see [Do I need the ChatGPT app open to use a Codex desktop thread?](#do-i-need-the-chatgpt-app-open-to-use-a-codex-desktop-thread)

## Does my code or data leave my machine? What can the relay see?

Only ciphertext. Pairing uses a Noise `xxpsk3` handshake and reconnects use `ik`; the Mac opens **one outbound WebSocket** and listens on no port, so no tunnel and no firewall rule is involved. The relay forwards 16-byte channel ids and encrypted frames and holds no key. What it can still observe: room id, timing and frame sizes — it is trusted for availability, not for confidentiality, and could drop, delay or refuse traffic.

Invites are single-use, only the SHA-256 hash of the token is stored on the relay, and they expire in 30–600 s (default 300). Each paired device is a Noise static public key; revoking one takes effect on the Mac immediately.

Transcripts stay on the Mac: `bridge.db` (SQLite, WAL) and `hosted/*.jsonl`, protected by macOS file permissions (0700/0600). There is no extra encryption at rest.

## How is this different from just running Claude Code or Codex locally?

Locally, the session belongs to the terminal or desktop app that started it and only that machine can drive it. Bridge adds two things:

- **Mirroring**: it reads and replies to sessions that already exist on the Mac (8 adapters). It cannot create them — the agent's own app still owns that, with one exception: DeepSeek Harness can be started headless in a project directory.
- **Hosting**: it spawns the agent process itself (3 engines), which is the only way a browser can create a session with real approval prompts, and the only way approvals become actual `Allow` / `Deny` buttons in the chat.

The behavioural difference that matters: input sent into an already-existing desktop or CLI session arrives as peer / cross-session input, so the agent may decline to treat it as your own decision. Bridge does not claim otherwise; sensitive steps belong on the Mac, or in a hosted session.

## Do I need the ChatGPT app open to use a Codex desktop thread?

For the `codex` adapter: yes. It needs the ChatGPT app running (`~/.codex/ipc/ipc.sock`) and can only drive the thread that is currently open in the Codex panel. Native ChatGPT Chat and Work threads are not part of that channel.

For the **Codex · App Server** hosted engine: no. Bridge spawns `codex app-server --listen stdio://` itself and speaks the official Codex JSON-RPC protocol over stdio. It writes one thread per session into `~/.codex/sessions`, resumes it with `thread/resume` after a restart, and defaults to sandbox `workspace-write` with approval `on-request`. This engine exists only in the pre-release **0.11.11-rc.1**; the 0.11.10 release hosts Claude Code and pi.

## Which agents and clients are supported? Can another AI connect over MCP?

Nine entries in the web client: 8 adapters that mirror sessions already on the Mac (`claude-code`, `claude-code-cli`, `codex`, `codex-cli`, `antigravity`, `antigravity-desktop`, `dsh`, `pi`) plus the `hosted` entry, which fronts 3 engines — Claude Code, pi, and Codex · App Server (pre-release only). Clients: the web client is a PWA that works in any modern browser; the host is the macOS menu bar app.

MCP: yes, for hosted sessions only. `@craftstead/agent-bridge-mcp` 0.1.0 (MIT, Node 22 or newer because it uses the built-in WebSocket) is a stdio MCP server you install on the *calling* machine. It exposes 9 tools — `bridge_status`, `session_list`, `session_open`, `session_read`, `session_wait`, `session_send`, `session_stop`, `session_archive`, `session_adopt`. It maps no shell, file or device methods, cannot leave the hosted directory allowlist, and only touches sessions in its own registry: the ones it opened with `session_open`, or ones the user adopted by name with `session_adopt`.

## Is it free? What license?

MIT — daemon, relay, web client and menu bar app, all in one repository. There is no paid tier and no account on our side; the public instance runs at <https://agent-bridge.craftstead.app>.

If you want your own relay, `apps/relay` is a Cloudflare Worker + Durable Object that you deploy with `wrangler` on your own Cloudflare account, then point `bridge init --relay` at it. See [docs/GUIDE.md](docs/GUIDE.md#14-deployment).

## Does it run on Windows or Linux?

No. The host app is macOS 13 or newer only, one universal build for Apple Silicon and Intel. There is no Windows or Linux build, and Windows/Linux machines cannot run the daemon.

Demand is tracked in issue [#253](https://github.com/gowinder/agent-bridge/issues/253).

## How do approvals work? Who approves a sensitive action?

For hosted sessions, the bridge owns the agent's stdin, so a tool-permission question arrives in the web chat as a real prompt with **Allow** / **Deny** buttons and goes back as a `control_response` (Claude Code via `--permission-prompts host`, Codex · App Server via its protocol, pi via its RPC channel). Approving from the phone is a genuine approval there.

For desktop and CLI sessions (`claude-code`, `claude-code-cli`, `codex`) the answer is different by design: your message is injected as peer / cross-session input, and the agent may refuse to treat it as the user's own decision. Approve on the Mac, or use a hosted session. `codex-cli` and `pi` non-interactive resumes inherit their own configuration, so anything that needs an interactive approval is simply refused. Details: [REMOTE_APPROVAL.zh-CN.md](REMOTE_APPROVAL.zh-CN.md).

## Which interface languages are there?

Eight, in both the web client and the menu bar app: 中文 (the source language), English, 日本語, 한국어, Español, Français, Deutsch, Português. The UI follows your browser or system language on first load and can be switched by hand at any time.

## Where does Bridge keep its data on the Mac?

`~/Library/Application Support/AgentBridge`, or `$AGENT_BRIDGE_HOME` if set:

```
bridge.db      SQLite (WAL): devices, invites, push subscriptions, titles, events,
               and the Noise static identity
hosted.json    hosted-session allowlist (dirs, idleTimeoutMs, allowBypassPermissions, cliPath)
hosted/        hosted transcripts (*.jsonl) and sessions.json
admin-port     loopback admin port for this state directory
admin-token    bearer token for the admin API (mode 0600)
```

The directory is created 0700 and the token file 0600. Back it up to keep devices paired; deleting it unpairs everything.

## How do I revoke a device?

```sh
npm run bridge -- devices          # list paired devices
npm run bridge -- revoke <deviceId>
```

Revocation is local and immediate — the relay closes that device's live sockets. The web client can only manage the device you are currently using; other devices are managed on the Mac.
