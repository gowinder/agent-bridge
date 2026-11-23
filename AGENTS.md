# Agent 约束

## 分支与部署

- `develop` → preview 环境
- `main` → production 环境
- 两者都不直接 push，改动一律走 PR。

依据：`.github/workflows/deploy.yml` 中 `preview` job 仅在 `develop` 上运行，`production` job 仅在 `main` 上运行。

## 分支模型

- feature 分支从 `develop` 切出，PR 合回 `develop`
- 需要上线时，再开 `develop` → `main` 的 PR

## 发版

- 每次发布生产环境（`develop` → `main` 的 PR）必须递增版本号，不能复用已发布过的版本号。
- 版本号写在仓库根 `package.json` 的 `version`，并同步 `package-lock.json`；提交信息用 `chore(release): <version>`。
- 同一个发版 PR 内更新 `CHANGELOG.md`：把 `[Unreleased]` 下的改动归入新版本号与日期，分类用 Added / Changed / Fixed / Removed。
- 预发布 tag（`v0.11.10-rc.1`）可以直接打在 `develop` 的提交上，不用先合 main；正式 tag 必须打在 main 上。
- 每个 Release / prerelease（推 `v*` tag）的说明必须写清「相对上一个版本改了什么」：内容取自 `CHANGELOG.md` 里该版本的小节，由 release 工作流自动拼进 Release 说明；这一节缺失时工作流直接失败，不能只发版本号与安装步骤。

## 开发流程

1. 在 worktree 中开发，不在主 checkout 直接改：
   `git worktree add .claude/worktrees/<name> -b feat/<name> origin/develop`
2. 完成后提交、推送 feature 分支，创建 PR，base 为 `develop`。
3. PR 由开发者自行审核（不再使用 Codex 审核）：合并前通读完整 diff，重点看回归面与向后兼容；可派独立 reviewer 交叉核对。
4. 审核发现的问题必须修复并推送到同一分支，PR 自动更新；修复后重跑检查。
5. 审核意见清零后再合并到 `develop`；preview 验证通过后，再走 `develop` → `main`。

## 提交前检查

- `npm run check`（`tsc -b` + web `tsc --noEmit`）必须通过。
- 改动涉及 wasm 或 web 构建时，本地也跑一遍部署链路：
  - `npm run build:wasm -w @craftstead/crypto`
  - `npm run build -w @craftstead/web`
- `npm test`（`npm run build && node --test apps/bridge/test`）也要通过；没有 lint 脚本。

## 约定

- 提交信息用中文 Angular 风格：`feat(scope): ...`、`fix(scope): ...`。
- 会话来源（agent 适配器）新增或改动时，同步检查同级的其他适配器是否需要相同处理。
