@AGENTS.md

## 发版

- 每次发布生产环境（`develop` → `main` 的 PR）必须递增版本号，不能复用已发布过的版本号。
- 版本号写在仓库根 `package.json` 的 `version`，并同步 `package-lock.json`；提交信息用 `chore(release): <version>`。
- 同一个发版 PR 内更新 `CHANGELOG.md`：把 `[Unreleased]` 下的改动归入新版本号与日期，分类用 Added / Changed / Fixed / Removed。
- 每个 Release / prerelease（推 `v*` tag）的说明必须写清「相对上一个版本改了什么」：内容取自 `CHANGELOG.md` 里该版本的小节，由 release 工作流自动拼进 Release 说明；这一节缺失时工作流直接失败，不能只发版本号与安装步骤。
