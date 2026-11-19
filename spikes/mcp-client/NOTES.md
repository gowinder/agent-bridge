# MCP 无头配对 spike（Part 1）

一次性验证脚本：不带浏览器，用 MCP 客户端身份走完「邀请配对 → 设备重连 → 一轮读写」。
不参与 `tsc -b`（根 `tsconfig.json` 只有 `references`，`files: []`，不含 `spikes/`），纯 ESM，无构建步骤。

## 用法

```bash
# 无网络自检（必跑）
node spikes/mcp-client/spike.mjs selftest

# 配对（把邀请链接整条贴进引号；fragment 必须在）
node spikes/mcp-client/spike.mjs pair "https://<host>/#/pair?relay=...&room=...&invite=..."
# → 打印「配对确认码：XXXXXX」，等人把 yes 写进状态目录的 confirm 文件

# 重连 + 一轮读写验证
node spikes/mcp-client/spike.mjs verify [--name "Muse (MCP) · spike"] [--dir <白名单目录>]

# 只验证身份持久化
node spikes/mcp-client/spike.mjs reconnect
```

状态目录（设备私钥与重连令牌只存这里，仓库内不出现任何凭据文件）：

- 默认 `~/Library/Application Support/AgentBridge-mcp-spike/`
- 可用 `AGENT_BRIDGE_SPIKE_HOME` 覆盖
- 目录 0700；`identity.json`/`device.json` 0600
- `confirm` 是人工确认门文件（内容 `yes` 才继续）

重配前要删状态目录：`rm -rf "<状态目录>"`（`device.json` 存在时 `pair` 会直接拒绝）。

## 模块

| 文件 | 对应网页实现 |
| --- | --- |
| `spike.mjs` | 子命令分派（网页没有对应物） |
| `relay.mjs` | `apps/web/src/relay.ts` 的 `RelayConnection` / `helloMessage` |
| `peer.mjs` | `apps/web/src/peer.ts` 的 `PeerClient` |
| `pairing.mjs` | `apps/web/src/pairing.ts` + `apps/web/src/link.ts` |
| `state.mjs` | 网页用 localStorage 存设备；这里落盘到仓库外的状态目录 |
| `selftest.mjs` | 无网络自检 |
| `verify.mjs` | verify / reconnect 流程 |

`PeerClient` 语义与网页一致：response 按 id 匹配 pending，event 忽略，`open()` 返回 null 视为「分片已缓存，继续读」，请求默认 20s 超时（慢操作按调用覆盖到 60s），`seal()` 返回的数组逐帧 `sendBinary`。

## develop 基线重核结果

基线：`origin/develop` @ `e3fdfa6`（含 PR #200），根 `package.json` 版本 `0.11.5`。

| 项 | 结论 |
| --- | --- |
| `RELAY_PROTOCOL_VERSION` | `2`（`packages/protocol/src/index.ts:2`） |
| `RELAY_WS_PATH` | `/v1/ws`（`:13`） |
| `METHODS` | 65 项（`:96-166`）；`approval.respond` / `turn.cancel` / `operation.get` / `session.subscribe` / `sync.resume` 都在表里，但 `DeviceSession` 的 default 分支抛 `unsupported`（`apps/bridge/src/sessions.ts:1192-1193`）→ 本 spike 一律不调用 |
| `MessageListResult.busy` | 存在（`:857`），托管会话也会填（`apps/bridge/src/hosted/manager.ts:619`） |
| `SessionListParams.includeArchived` | 存在（`:1015`）；Bridge 只在 `=== true` 时采用（`sessions.ts:754`） |
| `HostedCreateParams` | `path` 必填且必须是 `hosted.dirs` 里的条目（`manager.ts:2365-2381` `allowedPath`），`agent?: "claude" \| "pi"`（`:743-770`）；pi 的 `permissionMode` 被强制成 `manual` |
| `device.rename` | 仍只许改自身设备（`sessions.ts:1134-1149`，`unauthorized: 只能重命名当前设备`）；成功返回 `{ok: true, name}`，不只是 `{ok}` |
| `device.list` | 返回全部设备（`sessions.ts:1110-1119`），无「只看自己」的过滤 |
| `pair.request` | Bridge 只读 `deviceName`、`confirmCode` 与 `clientType`（`sessions.ts:463-536`）；`platform` 被忽略；确认码不符 → `invalid_params` + 关通道；本 spike 自报 `clientType: "mcp"`（老 Bridge 忽略该键，新版会标成 MCP 设备） |
| 邀请一次性 | 中继在 hello 阶段就 `UPDATE invites SET used_at`（`apps/relay/src/room.ts:602`），Bridge 在 `pair.request` 前再复查（`sessions.ts:484-500`）→ 一次握手失败就烧掉邀请 |
| 中继错误码 | `bridge_offline` / `invite_used` / `invite_expired` / `invalid_credential` / `device_revoked` / `device_expired` / `channel_in_use`（`room.ts:573-647`） |
| 帧上限 | 中继 64KiB（`room.ts:30`）；协议单帧明文 32KiB、分片 20000B/片、重组上限 4MiB（`protocol:5-11`、`crypto/src/channel.ts:17`）→ selftest 里 40KB 消息=3 帧，最大一帧 26785B |
| i18n | 8 语言：`apps/web/src/i18n.ts:14` 的 `Lang` 是 `zh` + `i18n.en/ja/ko/es/fr/de/pt.ts` 七个文件；`apps/web/scripts/check-i18n.mjs` 只比对英文表之外的 6 张（en 是基准，zh 在 `i18n.ts` 里内联），所以 check 打印「6 种语言」。与简报的「8 语言 + check 脚本」一致，本任务未改动 |

## 与简报不符之处（以实读为准）

1. **远程设备不能改托管白名单。** `hosted.addDir` / `hosted.removeDir` 在配对设备通道上直接抛
   `unsupported: 托管目录只能在 Mac 菜单栏的「设定」里修改`（`sessions.ts:823-826`）。
   所以 verify 无法「临时目录 + addDir + create」：
   - 仍会试一次 `hosted.addDir` 并把拒绝结果打印成证据；
   - 真正建会话用 `hosted.dirs` 里第一个 `exists !== false && allowed !== false` 的目录，可用 `--dir` 指定；
   - 结尾的 `hosted.removeDir` 同样以 `unsupported` 收尾并打印；
   - 临时目录只在状态目录下建了又删，从未被白名单接受。
2. **允许 http 中继的条件不同。** 网页在「页面自己就是 http」时也放行 http 中继（本地开发），
   Node 没有页面，脚本只放行 https 与回环 http（`pairing.mjs` 的 `credentialsFromFragment`）。
3. **`RelayConnection.connect` 多了一条 race。** 网页只等 `ready`/`error` 控制消息；Node 下连不上时
   只有 `close` 事件，白等 10 秒，所以这里与 `closed()` race，失败立刻报错。
4. **`device.rename` 的返回值**是 `{ok: true, name}`（网页只按 `{ok: boolean}` 用），verify 原样打印。

## 已知限制 / 实跑注意

- `selftest` 覆盖了 wasm 加载、xxpsk3 与 ik 回环握手、`remoteStatic` 一致性、确认码、单帧与 >32KiB
  分片往返、中继 URL 转换、hello 帧过 `parseRelayHello`、邀请链接解析（含拒绝用例）。
  **它不覆盖真实 relay/Bridge**：网络路径只有实跑才能验证。
- verify 会真的在 Bridge 机器上用 `pi` 建一个托管会话（在白名单目录里），发一条
  `Reply with exactly: SPIKE-OK`，最后 `hosted.stop` + `hosted.archive`。**不 `hosted.delete`**，
  归档会话会留在列表里，需要人工清理。
- `hosted.create` 依赖 Bridge 机器上装了 `pi`；没装就报错，不要当成脚本 bug。
- `PeerClient` 的通道判死阈值是 60s 无下行帧（照抄网页 `FRAME_IDLE_MS`）。`hosted.create` 冷启动
  超过 60 秒还没任何事件的话，通道会被判死、请求以 `closed` 失败——这一版 Bridge 没有心跳补偿。
- 配对需要人工确认门：确认码不一致就写 `no` 或 Ctrl-C；邀请默认 30 天有效，
  但**邀请是一次性的**，中途失败要重新生成链接。
- 确认门最长等 240s。这段期间没有心跳：中继用 Cloudflare 自动 ping/pong，不需要客户端保活；
  网页的 `host.ping` 是探活用的，不是中继要求。
- 状态目录默认是 macOS 路径；非 macOS 上请显式设 `AGENT_BRIDGE_SPIKE_HOME`。
- 不要对着生产实例（47825）或没有邀请链接的 preview（47826）跑 `pair`/`verify`：
  链接指向哪个实例，就会真的在那个实例上建一条设备记录。
