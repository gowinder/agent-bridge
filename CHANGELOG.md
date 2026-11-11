# Changelog

本文件记录发版变更，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号与仓库根 `package.json` 保持一致。

## [Unreleased]

## [0.1.6] - 2026-11-11

### Added

- macOS 菜单栏 app 与 bridge CLI 打成通用 DMG，推 tag 时自动建 Release（附 sha256，未签名构建附 Gatekeeper 说明）。
- 官网落地页新增下载入口：生产指向 `/releases/latest` 的固定地址，预览指向最新 prerelease。

### Changed

- 工作流按 GitHub Environment 拆成 preview / production；wrangler 的生产名字与自定义域移入 `[env.production]`，预览保持 `routes = []`。

## [0.1.4] - 2026-11-11

- 0.1.4 及更早的发版早于本文件建立，未逐条记录。
