# Changelog

本文件记录发版变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与仓库根 `package.json` 保持一致。

## [Unreleased]

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
