# Changelog

本文件记录发版变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与仓库根 `package.json` 保持一致。

## [Unreleased]

## [0.3.2] - 2026-11-13

### Fixed

- 聊天记录里点击文件链接（文件应用/产物）弹出的预览报「sessionId required」：预览请求补上当前会话的 `sessionId`，Bridge 才能按会话所属项目放行 `fs.read`。

## [0.3.1] - 2026-11-13

### Changed

- 桌面端聊天页头部压缩成两行：标题一行、说明一行（过长省略，悬停看全文），右侧按钮横排，不再占掉三四行高度；窄屏布局不变。

### Fixed

- 托管会话的上下文用量改用 CLI 转录兜底：模型走代理时 assistant 事件里的 usage 可能全是 0，回合结束时按转录里的真实用量更新。
- 上下文用量上线的老会话，Bridge 启动时从 CLI 转录补算一次，网页侧栏和输入框的上下文读数不再一直是空的。

## [0.3.0] - 2026-11-13

### Added

- 网页「托管」的工程列表页新增「添加目录」：填本机已存在的绝对路径即可加入托管白名单，立即出现新的工程，不用再手改 `hosted.json` 并重启 Bridge。新增 `hosted.addDir` / `hosted.removeDir`，操作会记入设备的最近操作日志。

## [0.2.1] - 2026-11-13

### Added

- 网页顶栏的连接徽标显示 Bridge 版本号。

### Fixed

- 托管会话新建面板的模型清单补上 `~/.claude/settings.json` 里 `modelPicker.options` 配置的自定义模型（例如 magpie 的路由模型），单独成「自定义」一组并排在最前。

## [0.2.0] - 2026-11-13

### Added

- Bridge 托管会话在网页侧栏显示上下文用量（输入/缓存读/缓存写/输出），数据取自 CLI 的 assistant 事件并随会话记录持久化。
- 网页输入框输入「/」时提示该会话可用的斜杠命令与技能（来自 CLI init 事件），支持方向键选择、回车/点击补全。
- 菜单栏 app 增加版本检测与自更新：启动后和每 6 小时查一次 GitHub Release（preview 取预发布，生产只取正式版），有新版本弹窗提示，下载 DMG 校验 sha256 后替换应用并自动重启。
- 网页新建托管会话时可直接选择模型与思考程度：模型取自本机模型目录（常用/更多两组），思考程度取自 `claude --help`；选择会写进会话记录，并在启动进程时传给 CLI。
- 托管会话的输入框新增「停止」：回合运行中可中断当前回合，进程与会话保留；中断状态随会话记录保存，网页重开仍显示「已中断」。
- 网页宽屏布局左侧新增 dock 侧边栏，含「结构」（agent → project → session 树）和「历史」（按更新时间排序）两个 tab，选中的 tab 会记住。

### Fixed

- 网页新建托管会话时，列表后台刷新或重连不再重建表单：已输入的标题、模型和权限模式会保留；列表更新等表单结束再重绘。
- 托管会话的进程被停止后，再发消息会自动拉起；旧进程迟到的退出事件不再顶掉刚启动的新进程。

- 本机保存的旧预览中继地址（`agent-bridge-preview.gowinder.workers.dev`）在打开状态目录时自动改写为 `agent-bridge-preview.craftstead.app`，避免 workers.dev 路由下线后一直报 `relay websocket error`。

## [0.1.9] - 2026-11-12

### Added

- 本地管理端口按状态目录保存到 `admin-port`：preview 默认 47826、生产默认 47825，两份 Bridge 可同时运行；菜单栏新增「管理端口」设置并重启，CLI 新增 `agent-bridge port [<端口>]`。
- 托管会话新增 Mac 侧开关 `hosted.json` 的 `allowBypassPermissions`（默认 `false`）：关闭时不接受 `bypassPermissions`，已有 bypass 会话也不能再启动；打开后网页创建面板才提供该模式。
- 菜单栏新增「断开全部连接」「作废全部证书」，一次处理所有设备。
- 每台设备的子菜单新增「最近操作日志」：先列最近三条，再通过「更多…」查看全部历史（存本地库，Bridge 重启后仍在）。
- 菜单顶部与托盘提示显示 Bridge 版本号。
- 托管会话在列表行和聊天页顶部常驻显示当前模型与权限模式（中文说明），执行中也照常显示。

### Fixed

- 一次提问包含多个问题时，改为逐个选中后点「提交答案」统一发出，不再点第一个答案就立即提交。
- 邀请窗口的二维码改用软件渲染兜底，避免没有可用 GPU 时整块空白。

### Changed

- 预览环境改用自有域名 `agent-bridge-preview.craftstead.app`，不再依赖国内访问不了的 `workers.dev` 默认地址。

## [0.1.8] - 2026-11-11

### Fixed

- 网页新建托管会话后直接进入聊天页：先把新会话写入当前快照，避免误报「找不到这个会话」。

## [0.1.7] - 2026-11-11

### Added

- Bridge 托管会话：由本机 Bridge 启动并持有 `claude -p` stream-json 进程，网页可新建、停止、恢复，输入直接写入 stdin（不再经过桌面 peer 通道）。
- 托管目录允许列表 `$AGENT_BRIDGE_HOME/hosted.json`，默认权限模式 `manual`，工具批准与 AskUserQuestion 在网页上作答。
- `npm test` 运行 node:test 用例，覆盖托管会话关键路径。

### Changed

- 网页会话列表与聊天页标注「由 Bridge 托管，不出现在桌面应用」。

## [0.1.6] - 2026-11-11

### Added

- macOS 菜单栏 app 与 bridge CLI 打成通用 DMG，推 tag 时自动建 Release（附 sha256，未签名构建附 Gatekeeper 说明）。
- 官网落地页新增下载入口：生产指向 `/releases/latest` 的固定地址，预览指向最新 prerelease。

### Changed

- 工作流按 GitHub Environment 拆成 preview / production；wrangler 的生产名字与自定义域移入 `[env.production]`，预览保持 `routes = []`。

## [0.1.4] - 2026-11-11

- 0.1.4 及更早的发版早于本文件建立，未逐条记录。
