@AGENTS.md

## 发版

- 每次发布生产环境（`develop` → `main` 的 PR）必须递增版本号，不能复用已发布过的版本号。
- 版本号写在仓库根 `package.json` 的 `version`，并同步 `package-lock.json`；提交信息用 `chore(release): <version>`。
- 同一个发版 PR 内更新 `CHANGELOG.md`：把 `[Unreleased]` 下的改动归入新版本号与日期，分类用 Added / Changed / Fixed / Removed。
