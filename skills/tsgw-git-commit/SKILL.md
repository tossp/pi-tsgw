---
name: tsgw-git-commit
description: 核验 Git 暂存内容、按功能拆分提交并生成中文提交说明。用户要求 commit、提交代码或跨仓库分批提交时使用；遵循项目提交规范及明确授权范围。
license: MIT
compatibility: 需要 Git；附带的只读仓库发现脚本需要 Node.js。
---

# Git 提交

先确认目标仓库与授权范围，再以暂存区作为提交内容的唯一依据。本技能由本地维护的提交工作流整理为 Pi 版，不依赖 OpenCode 专属工具，也不安装 Git hook。

## 1. 定位仓库

- 用户已明确仓库或当前上下文唯一时，直接使用该仓库，不重复询问。
- 用 `git -C <repo> rev-parse --show-toplevel` 确认真实根目录，并检查分支、工作区及已有暂存内容。
- 多仓库任务需要盘点时，使用随附只读脚本；它检查目标目录及直接子目录，支持 `.git` 目录和 worktree 的 `.git` 文件，不递归扫描整台主机：

```bash
node <skill-dir>/scripts/discover-repos.mjs --json <project-root>
```

`<skill-dir>` 替换为本技能实际目录。脚本仅报告有暂存变更的仓库；空列表不代表没有未暂存修改，失败也不应当作空列表。

- 多个候选无法判定、用户指定的仓库不存在或提交范围不明确时，集中询问必要问题。使用当前宿主实际提供的交互入口；不假设存在 `questions`。

## 2. 核验内容与划分批次

```bash
git -C <repo> status --short
git -C <repo> diff
git -C <repo> diff --cached --name-only
git -C <repo> diff --cached --stat
git -C <repo> diff --cached
git -C <repo> log -5 --oneline
```

- `git status` 只给工作区概况，不能替代完整 `git diff --cached`。
- 已有暂存内容默认保留，不把其他协作者的变更混入或移出。
- 用户已授权提交本轮实现、但文件尚未暂存时，可以仅 `git add -- <明确路径>` 暂存本轮相关文件；没有暂存内容且没有暂存授权时，报告现状并停止。
- 按独立功能、修复或文档范围分批提交；已明确的分批授权无需逐批重复确认。
- 若涉及他人暂存内容、拆分不明确或同一文件中混有无关修改，先说明方案并确认；不盲目全量 `git add .`，不默认交互式拆分。
- 每次调整暂存区后，重新读取该批次的 `git diff --cached` 并核对文件与差异。

## 3. 验证与提交说明

- 运行与改动范围相称的测试、编译或静态检查，再执行 `git diff --cached --check`。
- 检查失败先修复或明确报告阻塞，不用跳过检查、禁用 hook 或降低验证标准制造成功。
- 优先遵循项目 `AGENTS.md`、提交校验器与既有格式。没有项目规范时采用 `type(scope): 中文说明`；scope 可省略，正文用中文解释原因与边界。
- 常用 type 为 `feat`、`fix`、`refactor`、`docs`、`test`、`build`、`ci`、`chore`、`perf`、`style`、`revert`。不要把这份建议覆盖到项目既有校验规则。
- emoji 可按项目习惯使用，不强制引入 gitmoji 数据集或一套新的校验器。
- 仅描述本批次实际改动。有关 issue、PR 或工作项使用平台可识别的引用；不要伪造未推送提交链接。

## 4. 提交与结果核对

简单说明可用 `git -C <repo> commit -m 'type(scope): 中文说明'`；多行正文先通过宿主文件写入工具保存到安全的临时文件，再使用 `git -C <repo> commit -F <message-file>`，避免 Shell 插值。

- 用户已明确授权且范围清楚时，验证后直接提交；只有用户要求审阅或范围实质变化时才再次确认。
- 不单独执行、安装或绕过 Git hook；普通 `git commit` 正常触发仓库已有 hook，失败时读取原因并报告。
- 提交后核验 `git log -1 --oneline`、`git status --short` 和剩余 diff，确认本批次没有遗漏或混入其他改动。
- 多仓库分别验证、分别提交；发生失败时说明哪些仓库已成功、哪些尚未提交，不声称跨仓库原子成功。
- 汇报提交 hash、主题、验证结果及未提交／未推送状态。推送、打 tag、发布只有取得对应授权后才执行。

## 安全边界

不把提交授权解释为删除数据、覆盖工作区、改写历史或发布授权。不执行 `git reset --hard`、`git clean -fd`、强制推送或未经授权的 amend。不要在提交准备中顺手修改无关源码、凭据、远端配置或用户配置。
