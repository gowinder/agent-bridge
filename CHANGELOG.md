# Changelog

本文件记录发版变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与仓库根 `package.json` 保持一致。

## [Unreleased]

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
