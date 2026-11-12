# 手机/网页上的指令，为什么批准不了合并

## 现象

在手机或网页里对某个 Claude Code 桌面会话说「可以，合并」，会话回复：

> 「可以，合并」是另一个会话转来的，不是你在本会话里说的。

同一句话，在桌面端那个会话的输入框里打就能生效。普通请求（改代码、查东西、跑命令）从手机发也照常执行，只有合并、发版、删除这类动作被拒。

## 原理

### 1. 只有一条通道

Bridge 往运行中的 Claude Code 桌面会话送文字，只有一条路：CLI 的本地 peer socket `/tmp/cc-socks/<pid>.sock`（`apps/bridge/src/adapters/claude-code.ts:865` 的 `send()`，实际写入在 `injectUds`，`:1443`）。

写进去的帧被包成 peer 信封（`apps/bridge/src/adapters/claude-code.ts:1492`）：

```
<cross-session-message from="uds:/tmp/cc-socks/<bridge pid>.sock" from-name="Agent Bridge · <配对设备名>" from-mode="bypass|default">
<用户的原话>
</cross-session-message>
```

- 发送者名由 `senderLabel()` 拼出（`apps/bridge/src/adapters/claude-code.ts:201`），所以手机上发的话，到达时署名是 `Agent Bridge · iPhone · 402×874`。
- `from-mode` 来自桌面会话的权限模式（`:892`），bypass 模式下接收端还可能以 `no-mode-asserted` 挂起。
- 回执分三态：`delivered` / `held`（目标忙，桌面排队）/ `refused`（`:1471`）。

会话就是按这个信封判断的：这不是本会话输入框里的输入，而是一条从别处转来的 peer 消息。

### 2. 答问也一样

网页上点 AskUserQuestion 的选项，答案不是走桌面提问通道回去的，而是把选项文案拼成文本再 `message.send`（`apps/web/src/main.ts:4014`），到会话里同样是 peer 信封。

### 3. 判定差在动作，不在内容

收到消息的 Claude 对普通请求照做，对不可逆或对外的动作要求「用户本人在本会话说过」。peer 消息不能当作本人批准，是会话侧的安全规则：否则任何被转发的文本都能冒充用户批准生产操作。所以症状表现为「文本可以，合并会串」——其实是同一个会话认了内容，不认发送者。

### 4. 没有替代通道

- 桌面里 CLI 的 stdin 归桌面进程所有，Bridge 拿不到。
- 桌面内部的发送接口（例如压缩用的 `deps.send(sessionId, "/compact")`）没有对外暴露。
- `claude://` URL Scheme 只有 `claude://code/continue?session=…` 这一种唤醒用途（`apps/bridge/src/adapters/claude-code.ts:1111`），不能带文本。
- 唤醒后依然是往 peer socket 注入，信封不变。

同样的原因导致另一处能力缺失：Claude Code 会话无法从 Bridge 触发上下文压缩——`claude-code` 适配器没有实现 `compact()`，`session.compact` 会返 `unsupported`（`apps/bridge/src/adapters/index.ts:143`）。只有 Codex 桌面有 `thread-follower-compact-thread` IPC（`apps/bridge/src/adapters/codex.ts:52`），并上报 `canCompact: ipc`（`codex.ts:553`）；Claude 会话在网页里只退化成「复制 /compact」按钮（`apps/web/src/main.ts:3809`）。

## 现行做法

| 场景 | 手机/网页 | 桌面会话 |
| --- | --- | --- |
| 普通请求、答选择题 | 可用 | 可用 |
| 合并、发版、删除等批准类动作 | 不算本人授权，会被拒 | 可用 |

按可靠程度：

1. **最后一步自己做**：让会话把分支、PR、检查准备到就绪，你在桌面端合并或跑命令。
2. **桌面端先立常驻规则**：在那个会话里说清楚「检查通过后你自己合 develop 的 PR，不用再问我」。之后手机上的同类指令落在已给出的授权范围内。代价是授权立下后，手机转来的任何一句话都能触发这个范围。
3. **让它把命令打给你**：会话输出 `gh pr merge …` 之类，你在终端自己执行。

## 根治条件

需要桌面客户端提供一条非 peer 的用户输入通道（例如把「用户在配对设备上输入」作为一等来源传给 CLI）。在此之前，Bridge 侧无论怎么改都无法让手机上的话算作本人批准；放宽信封语义等于让任意转发文本都能冒充授权，不做。

## 实验结论（2026-11-11）：`claude --resume -p` 能否替代 peer 信封

环境：Claude Code CLI 2.1.321（桌面同版本）、macOS、一次性仓库 `$TMPDIR/ab-resume-spike-*`、模型走本机代理。所有不可逆操作只在该临时仓库里做。

### 结果速览

| 项 | 结论 |
| --- | --- |
| (a) 会话映射 | 可稳定映射：桌面记录 `cliSessionId` + `cwd`；运行进程 `~/.claude/sessions/<pid>.json`；转录 `~/.claude/projects/<cwd 编码>/<cliSessionId>.jsonl` |
| (b) 同一会话追加 | 是。`--resume <id> -p` 在同一条 JSONL 末尾追加普通 `user` 条目，session id 不变；`--fork-session` 默认关闭 |
| (c) 不可逆请求 | 不再被判为 cross-session：真实生成了 git commit |
| (d) 桌面显示 | 未能在真正的桌面应用里验证（见「限制」）；运行中的 CLI 不会实时显示外部追加的回合，转录出现分叉 |
| (e) 并发写入 | 没有锁、没有「已在用」拒绝；两个写者各写各的分支，同一 JSONL 出现多个 head |
| (f) 权限模式 | 必须显式传 `--permission-mode`，否则继承全局 `defaultMode`；flag 生效，但 Bash 仍可能被用户的 PreToolUse hook 自动放行 |
| (g) 流式回传 | `--output-format stream-json --verbose` 可用；不加 `--include-partial-messages` 时只有整条消息，没有 token 级增量 |

### (a) 桌面会话 → sessionId / cwd

- 桌面记录：`~/Library/Application Support/Claude-3p/claude-code-sessions/<账号>/<工作区>/<localId>.json`，字段 `sessionId`（`local_…`）、`cliSessionId`（uuid）、`cwd`、`permissionMode`。`Claude/` 目录同构。
- 运行进程：`~/.claude/sessions/<pid>.json`，字段 `pid`、`sessionId`（= cliSessionId）、`hostSessionId`（= localId）、`cwd`、`status`（`idle`/`busy`）、`startedAt`。适配器已用 `startedAt` 排除 pid 复用（`mergeDesktopSessions`）。
- 转录：`~/.claude/projects/<cwd 编码>/<cliSessionId>.jsonl`。macOS 上 `/tmp/...` 会编码成 `-private-tmp-...`（realpath 后），所以适配器遍历 projects 目录按文件名匹配（`transcriptPath`）是稳的，不要自行拼接 cwd。
- argv 里的 `--resume <uuid>` / `--session-id <uuid>` 也能定位到同一内核会话（`scanProcesses` 已用）。

### (b) resume 是否追加真正的 user turn

```
claude --resume 2222… -p "记住：本仓库是 spike 专用。只回复 NOTED" --output-format json
```

- 返回 `session_id` 与 resume 前相同；没有生成新 JSONL。
- 文件行数 32 → 70；追加条目里第 35 行 `type:"user"`，`message.content` 就是原文，`parentUuid` 接上一条，`sessionId` 相同，非 sidechain。
- 帮助文本：`--fork-session` 是显式开关（「When resuming, create a new session ID instead of reusing the original」），默认关闭。无需额外 flag。

### (c) 不可逆请求是否还被拒

```
claude --resume 2222… -p "请把 feature.txt 加入 git 并提交，提交信息 spike: add feature…" \
  --permission-mode bypassPermissions --output-format json
```

- 生成了真实提交 `63d6548 spike: add feature`，只含目标文件；回复里没有「这是另一个会话转来的」之类拒绝。
- 注意：执行者是 **resume 起来的那个进程**，不是桌面里正在跑的那个会话（见下文）。

### (d) 桌面应用如何显示新回合

- 未能验证真正的桌面应用（原因见「限制」）。
- 可验证的部分：用一个运行中的交互 CLI 持有该会话（PTY 里 `claude --resume <id>`），从另一个进程 resume 写入 `EXT_IDLE_OK`。持有进程的界面日志里搜不到这条消息（它能显示加载时已在转录里的更早条目），说明它不 tail、不重读转录，内存上下文里也没有新回合。
- 该会话的 JSONL 出现多个分支；之后持有进程再对话时按自己的链追加，外部回合成为孤儿分支。

### (e) 会话忙/并发写入

- 没有会话级锁：两个 `--resume -p` 同时写同一会话都成功，没有 `already in use` 之类拒绝。
- 一个长回合（先 `sleep 45`）进行中再写入 `SHORT_B`/`SHORT_C`：两条各自成链，长回合继续按自己的链写，最终同一文件多个 head（统计到 17 个叶子/分支点）。写者之间互不可见。
- 可用的忙碌/存活判定（任一成立都不是安全写入窗口）：
  - `~/.claude/sessions/<pid>.json` 的 `status`（桌面 CLI 自维护，实时）；
  - 适配器现有的 `scanProcesses` / `isBusy`（转录时间戳）；
  - peer 回执 `held`。
  - 关键：**只要存在持有该会话的 pid，它就是并发写者**，跟 status 是 idle 还是 busy 无关。

### (f) 权限模式对齐

- 桌面记录实测取值：`bypassPermissions`、`auto`、`acceptEdits`；CLI 的 `--permission-mode` 取值为 `acceptEdits`/`auto`/`bypassPermissions`/`manual`/`dontAsk`/`plan`，没有 `default`，需把 `default` 映射成 `manual`（实测 `manual` 在转录里记为 `default`）。
- 不传 flag 会继承用户全局 `settings.defaultMode`（本机是 `bypassPermissions`），等于静默 bypass；因此必须显式传，且不得额外传 `--dangerously-skip-permissions`。
- flag 确实生效：`manual` + `--permission-prompts none` 时 `Write` 被拒并记进 `permission_denials`；`plan` 只出计划、不写盘。
- 例外：该用户装了 RTK 的 `PreToolUse` hook，`rtk rewrite` 返回 0 时 hook 自动放行 Bash，所以 `manual` 下 `git add/commit` 仍会执行。权限模式不能作为「不可逆操作会被拦下」的保证。

### (g) 流式回传

- `--output-format stream-json --verbose` 依次给出 `system`（hook/init）、`assistant`（整条消息）、`result`（含 `session_id`、`result`、`is_error`）。
- 不加 `--include-partial-messages` 没有 token 级 `stream_event`；够用来在 web 上按消息更新助手回复，不支持逐字输出。stderr 还会混入 `[claude-code:unrecognized_model]` 一类非 JSON 行，解析时要跳过。

### 为什么停在这里（停损）

1. resume 写的是**磁盘转录**，不是运行中会话的**内存上下文**。实测运行中的 CLI 不重读转录，新回合进不了它的上下文。
2. 对「桌面正开着」的会话，resume 等于**再起一个并行 agent**：它把文本当 user turn 并真的执行（包括 commit），但桌面里的会话不知道、也没执行——回执与实际会话状态不一致。
3. 对活跃会话写入没有并发保护，转录会分叉；桌面之后继续对话按自己的链写，外部回合成为孤儿分支，而 Bridge 读转录又会把它显示成会话的一部分。
4. 因此这条路径只能对**没有活跃进程**的会话成立；对任务目标（让正在运行的会话执行不可逆动作）无效且会污染转录。按停损条件，不实现 resume-input 投递策略。

### 还可能试的路（未验证，不要直接上线）

- 桌面客户端提供一等输入通道（非 peer）。
- 若能在真实桌面端验证它确实监听转录，可在「无活跃进程」时用 resume 排队，等下次打开会话时生效——这仍不是实时批准。
- 研究 peer socket 帧**不带信封**时接收端是否按本会话输入处理。CLI 二进制里存在 `<cross-session-message>` 的解析正则，说明接收端会解析它；这属于改投递语义，须单独评估安全后果。

### 不要做

- 不要在会话 live（即使 idle）时并发写同一份 JSONL。
- 不要通过改信封文案或去掉信封来伪装本人授权。
- 不要把 resume 进程执行的结果当成「桌面会话已批准」。

### 限制

真正的桌面 Code 会话无法在自动化里创建：`claude --desktop` 要求 Claude 账号登录（本机 CLI 走代理，无 OAuth），且交互式 CLI 的首个目录需要信任对话框。因此 (d) 的桌面渲染与 live-idle 行为仍待有桌面会话的环境复测；上面的停损结论基于「运行中的 CLI 不重读转录 + 并发写分叉」两项实测。spike 产生的临时会话、计划文件与临时仓库均已清理。

## 官方远程输入调研（2026-11-11）

目的：确认已安装的 Claude Code 是否有一条官方通道，能把输入送进运行中的本地会话，并且该输入算作会话自己的用户回合（不带 cross-session 信封），同时能被 Bridge 程序化驱动。

本机 `claude --version` 输出 `2.1.321 (Claude Code)`。`claude --help` 中与本问题相关的选项：`--remote-control [name]`、`--input-format`、`--output-format`、`--permission-mode`、`--permission-prompts`、`--permission-prompt-tool`、`--bg`、`--cloud`、`--session-id`、`--resume`。`claude remote-control --help` 给出 `--spawn <same-dir|worktree|session>`。

### 候选 1：Remote Control（`--remote-control` / `claude remote-control` / `/remote-control`）

文档：<https://code.claude.com/docs/en/remote-control>、<https://docs.claude.com/en/docs/claude-code/remote-control>。

- 定位：把本地会话接到 claude.ai/code 与 Claude 手机/桌面应用。在这些入口里发的话是一等用户回合，不带 peer 信封；甚至能挂到 Desktop / VS Code 已开着的会话上。
- 官方限制：需要 claude.ai 订阅，不支持 API key 或第三方 provider；`ANTHROPIC_BASE_URL` 指向非 `api.anthropic.com` 时（本地代理、网关、Bedrock/Vertex/Foundry）不可用；输入只能来自用户的 claude.ai 入口，没有本地 API/IPC 可供第三方写入；转录保存在 Anthropic 服务器。
- 实测：

  ```
  $ claude auth status
  {"loggedIn":false,"authMethod":"none", ...}

  $ claude remote-control
  Error: You must be logged in to use Remote Control. ...
  ```

  本机 `~/.claude/settings.json` 的 `env.ANTHROPIC_BASE_URL` 指向本地代理，按文档 Remote Control 本来也不可用。
- 按四个问题核对：
  1. 输入是真正用户回合——是，但只能由用户本人在 claude.ai/code 或 Claude 客户端输入；
  2. 适用桌面会话——可挂到 Desktop / VS Code 会话；
  3. 认证——claude.ai 订阅，且不能走代理/网关；本机环境不满足；
  4. Bridge 可否程序化驱动——不能。没有本地接口，且密钥不出 Mac 的前提下无法把配对设备的输入代填进用户账号界面。

### 候选 2：`claude --cloud <session_id> -p`

只把输入排进云端会话（claude.ai 托管），对本地桌面会话无效，且同样要求账号侧认证。

### 候选 3：`claude --bg` + `claude attach` / `claude agents --json`

后台会话由 CLI 自己持有 PTY，`attach` 是交互式 TTY 接管，不是给第三方进程的输入接口；Bridge 无法在不抢走终端的前提下写入。

### 候选 4：`-p --input-format stream-json` + `--permission-prompt-tool stdio`

这是官方支持的流式控制接口：调用方启动进程并拥有 stdin，写 `{"type":"user","message":…}` 就是真正的 user 回合；工具批准与 AskUserQuestion 以 `control_request`（`subtype:"can_use_tool"`）回到 stdio，调用方用 `control_response` 答复。它不解决「往已有桌面会话注入」，但正好是「Bridge 自己托管一个 Claude Code 会话」所需的能力（见下节）。

### 结论

没有可被 Bridge 程序化驱动、又能把配对设备输入送进运行中桌面会话的官方通道。Remote Control 是唯一官方「远程输入」能力，但入口锁死在用户自己的 Claude 账号界面，本机环境（本地代理 + 未登录）也不可用；其余入口要么只对云端会话有效，要么是 TTY 交互。因此按任务要求进入 Phase 2：由 Bridge 托管独立会话。

## Bridge 托管会话（Phase 2）

思路：不去碰桌面会话，改由 Bridge 自己启动并持有一个 Claude Code 进程。写进它 stdin 的每一句都是这个进程自己的用户回合，不经过 peer socket，也不会出现 cross-session 信封。

### 形态

- 适配器 `hosted`（`apps/bridge/src/adapters/hosted.ts`），会话 id 为 `hosted:<uuid>`，进程由 `apps/bridge/src/hosted/manager.ts` 管理。
- 启动参数：

  ```
  claude -p --input-format stream-json --output-format stream-json --verbose \
    --permission-mode <显式模式> --permission-prompts host \
    --permission-prompt-tool stdio --session-id <uuid>
  ```

  resume 时用 `--resume <uuid>` 替代 `--session-id`。不传 `--dangerously-skip-permissions`，也不依赖 CLI 默认值（本机全局默认是 `bypassPermissions`）。
- stdin 由 Bridge 独占：用户消息写 `{"type":"user","message":…}`；工具批准与 AskUserQuestion 通过 `control_request`/`control_response` 往返。
- 网页「新建托管会话」的目录只能从 Mac 侧允许列表里选。允许列表文件 `${AGENT_BRIDGE_HOME}/hosted.json`：

  ```json
  { "dirs": ["/Users/you/code/demo"], "idleTimeoutMs": 1800000, "allowBypassPermissions": false }
  ```

  目录按 realpath 精确匹配；增删条目后重启 Bridge 生效。默认空闲 30 分钟停止进程（60 秒扫一次），再发消息自动 `--resume`。`allowBypassPermissions` 默认 `false`：托管会话不接受 `bypassPermissions`，老会话也不能再用该模式启动；设为 `true` 后网页创建面板才会出现该选项。
- 生命周期：网页断开不影响进程；网页上可「停止进程」「恢复进程」；Bridge 重启后从 `hosted/sessions.json` 恢复列表，会话记录在 `hosted/<uuid>.jsonl`。

### 输入与权限

- 只有通过 Noise 握手、已配对设备的请求才会进入 `DeviceSession.dispatch`，`hosted.*` 与 `message.send` 都只在那之后可达。未认证连接没有写 stdin 的路径；其他本机会话转来的 peer 文本只走桌面适配器，不会被写进托管进程。
- 工具批准以 `next-step` 块（允许 / 拒绝）展示，AskUserQuestion 以 `ask` 块展示。点击后网页把按钮文案作为普通消息发回，Bridge 匹配后写 `control_response`；不是批准文案的输入会先拒绝该次调用，再作为普通用户消息写入。
- 用户消息原样写入 stdin，不加发送者标签——这是托管会话自己的输入，不是转发。

### 与桌面会话的边界

- 不读写桌面转录，不使用 `/tmp/cc-socks`，不把托管输入伪装成桌面会话。
- 网页明确标注「由 Bridge 托管，不出现在桌面应用」；这些会话不会出现在 Claude 桌面/Claude Code 应用里。
- 权限模式不是「不可逆操作必被拦下」的保证：用户的 `PreToolUse` hook（如 RTK 自动放行 Bash）仍会生效。

### 测试

`npm test`（根目录）先构建再跑 `apps/bridge/test/hosted.test.mjs`，用注入的假进程覆盖：创建参数与非 bypass 模式、写入用户回合并回传助手消息、工具批准、AskUserQuestion 回答、停止/恢复、允许列表拒绝、未知会话不写 stdin、重启后恢复列表。真实进程的端到端在 preview 环境另测。
