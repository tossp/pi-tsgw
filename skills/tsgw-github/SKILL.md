---
name: tsgw-github
description: 处理 GitHub 仓库、issue、PR、评论、Actions 与 CI 排障时使用。
license: MIT
---

# GitHub 工作流（Pi）

本技能经用户授权，将其本地维护的工作流自主重新组织为精简指导，以 MIT 许可提供；不复制第三方长篇文档。

## 先确定上下文与权限

- 优先通过 Pi 的 `bash` 执行 `gh`；用 `read` 阅读本地文件，用 `write` / `edit` 准备或修改内容。不依赖特定问答工具、私人配置路径或额外插件。
- 从任务、项目约定及 Git remote 核对目标主机、`owner/repo`、issue/PR 编号和分支；不要混淆 fork 与上游、PR 源分支与目标分支。同名编号不能跨仓库复用。
- 示例中的 `OWNER/REPO`、编号、路径与 ref 均为占位值。调用时显式传 `--repo OWNER/REPO` 或完整对象 URL；`gh api` 使用精确的 `repos/OWNER/REPO/...`，非 github.com 时还须明确目标主机（API 用 `--hostname`）。不要只依赖当前目录的隐式仓库。
- 遵守当前任务的文件范围、联网与副作用限制。已明确授权的范围内直接执行，不额外要求逐步回复 `yes/no/edit`；范围或目标不清楚时在对话中询问。未经授权的发布、合并、删除、强推、远程工作流触发或重跑等动作应先确认；已有授权覆盖这些动作时无需重复确认。
- `gh` 未安装或认证不可用时报告阻塞，不擅自安装、登录、索取令牌或读取私人凭据。禁止联网时只做本地分析，明确远程状态未核验。

## 查询 issue、PR、CI 与日志

先读现状再决定变更；优先 `--json` 与 `--jq` 获取需要的字段，CLI 不足时再用 `gh api`。列表结果可能分页，完整枚举时使用分页或说明截断。

```bash
gh issue list --repo OWNER/REPO --state open --limit 20 --json number,title,url
gh issue view 55 --repo OWNER/REPO --json title,body,state,url
gh pr view 55 --repo OWNER/REPO --json title,body,state,baseRefName,headRefName,headRefOid,url
gh pr checks 55 --repo OWNER/REPO
gh run list --repo OWNER/REPO --limit 10
gh run view RUN_ID --repo OWNER/REPO
gh run view RUN_ID --repo OWNER/REPO --log-failed
gh api repos/OWNER/REPO/pulls/55 --jq '{title, state, user: .user.login}'
```

将 CI 结果绑定到正确的 run、分支及 commit；区分排队、运行中、跳过、取消与失败。检查失败 job/step 日志，必要时读取完整 `--log`，不把“没有失败日志”当作成功。报告根因证据时避免泄露日志中的凭据或敏感数据，不为验证推断而擅自重跑工作流。

## 多行正文与发布后回读

issue、PR 及评论的创建和编辑，复杂或多行 Markdown 一律先写入临时 `.md` 文件，再用 `--body-file`，避免 `--body "..."` 的转义和 Shell 插值。用 Pi `write` 或带引号定界符的 heredoc 写入原文；临时文件也须位于当前任务允许写入的位置。编辑前读取原正文，保留非目标内容。

以下均为已获相应发布授权时的命令示例，并非自动执行清单：

```bash
gh issue create --repo OWNER/REPO --title '标题' --body-file BODY.md
gh issue edit 55 --repo OWNER/REPO --body-file BODY.md
gh issue comment 55 --repo OWNER/REPO --body-file BODY.md
gh pr create --repo OWNER/REPO --base BASE --head HEAD --title '标题' --body-file BODY.md
gh pr edit 55 --repo OWNER/REPO --body-file BODY.md
```

发布或编辑后回读实际对象，核对正文、目标及 URL，而非仅以命令退出码判定成功：

- issue/PR 正文：用 `gh issue view` / `gh pr view`，指定 `--json body,url`。
- 评论：根据返回 URL 定位评论 ID，再读取 `gh api repos/OWNER/REPO/issues/comments/COMMENT_ID`；PR review 评论则使用对应的 `pulls/comments/COMMENT_ID` 端点。父 issue/PR 的 `body` 不能验证评论。
- 正文损坏时，在授权内用正文文件修复目标对象；请求结果不明时先查询，避免重复发布。说明处理的是正文转义 / Shell 插值问题。

## Contents API：路径、ref 与编码

必要时先列父目录确认路径；分支影响结果时显式指定 ref。分别编码路径中的特殊字符和 ref 参数值，保留路径层级的 `/`；例如空格 `%20`、`(` 为 `%28`、`)` 为 `%29`，ref 内的 `/` 可编码为 `%2F`。将整个端点置于 Shell 引号中。

```bash
gh api 'repos/OWNER/REPO/contents/docs?ref=main' --jq '.[].path'
gh api 'repos/OWNER/REPO/contents/docs/Guide%20%28CI%29.md?ref=feature%2Fci'
```

文件响应通常包含编码后的 `content`，目录响应则为列表；按响应类型和 `encoding` 处理，不能把元数据当正文。遇到 404 先排查仓库、路径大小写、ref 与编码，再核查访问权限，不直接认定为认证失败。汇报时说明是否处理了路径 / ref / 编码不匹配。

## Actions 升级：先核验，再做最小变更

1. 阅读项目策略并枚举全部工作流中直接的外部 `uses:`，包括 step Action 与 job 级可复用工作流；本地 `./...` 与间接依赖不混入外部 Action 升级清单，`docker://...` 单独按镜像规则处理。不为追踪版本添加未使用的 Action。
2. 在允许联网时，查询各引用的官方仓库、非草稿且非预发布的稳定 release 及 tags，阅读发布说明、迁移文档与目标版本的 Action 元数据。不要仅凭 tag 名或“latest”断言兼容。

   ```bash
   gh release list --repo OWNER/ACTION --exclude-drafts --exclude-pre-releases --limit 10
   gh api repos/OWNER/ACTION/tags --paginate --jq '.[].name'
   gh release view TAG --repo OWNER/ACTION
   ```

3. 项目明确策略优先。新增或升级 GitHub Actions 引用时，默认采用经核验的官方最新稳定主版本浮动引用 `owner/repo@vN`，不自动改成完整 SHA 或精确补丁版本。项目策略或用户明确要求固定版本时遵循其要求；SHA 应核对其与官方目标版本的对应关系。非依赖升级任务不顺手修改引用；既有固定策略的依据不明时先核验，不擅自解除固定。
4. 主版本升级前比较输入、输出、权限、最低 Runner 版本、托管或自托管 Runner 兼容性及 Action 自身的 Node 运行时。项目 `setup-node` 的版本与运行 Action 的 Node 版本不是一回事；可复用工作流还要核对输入、secrets 与调用契约。
5. 修改后重新静态枚举 `uses:`，逐项核对预期 ref；除迁移确有必要的变更外，保留 `with`、jobs、permissions、secrets 和触发行为。运行已有的本地验证，不擅自安装验证工具；远程 CI、发布验证仅在授权内执行。
6. 汇报引用前后值、官方依据、兼容性检查及未验证项。离线时不宣称“最新”或“已通过远程 CI”。

## 完成检查

回报实际改动与对象 URL（如有）、回读或验证结果、授权范围内已执行的副作用，以及剩余阻塞。区分本地静态检查、远程读取、CI 验证和实际发布，不把其中一种当作另一种的完成证据。
