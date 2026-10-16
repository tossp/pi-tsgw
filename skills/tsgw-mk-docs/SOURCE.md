# 来源与适配说明

## 来源与授权

- 来源：用户提供并授权本地收纳的 Pi 较新版本个人技能 `mk-docs/`，以本次读取的本地快照为准；不声称来自特定上游发布号。
- 初次收纳时完整读取来源的 `SKILL.md`、`references/` 和 `assets/` 后复制适配，未使用旧宿主版本替代。后续按用户授权移除项目版及用户级来源正文中的审阅插件联动提示，保留独立文档治理约束。
- 技能名称改为 `tsgw-mk-docs`，frontmatter 许可证标识为 `MIT`，按用户授权收纳；不将本地授权表述为未经核实的上游许可证声明。
- 为保持可移植性，不记录本机绝对路径。下列路径均相对于本文件，与来源资源的相对位置一一对应。

## 完整资源清单

来源共 14 个文件，全部保留；本文件为新增的来源与边界说明。

| 文件 | 处理 |
| --- | --- |
| [SKILL.md](SKILL.md) | 保留独立治理正文，修改名称、许可证及资源链接，补充使用与迁移授权边界；已移除审阅插件联动提示与专项流程 |
| [references/design-doc-boundaries.md](references/design-doc-boundaries.md) | 原样保留 |
| [references/000-terminology.md](references/000-terminology.md) | 原样保留 |
| [references/000-todo.md](references/000-todo.md) | 修正资源相对链接，澄清项目规则和技能包行数边界 |
| [references/a-series/overview.md](references/a-series/overview.md) | 将同目录资源导航改为可点击相对链接 |
| [references/a-series/modules.md](references/a-series/modules.md) | 原样保留 |
| [references/a-series/checklist.md](references/a-series/checklist.md) | 原样保留 |
| [references/b-series/overview.md](references/b-series/overview.md) | 将同目录资源导航改为可点击相对链接 |
| [references/b-series/modules.md](references/b-series/modules.md) | 原样保留 |
| [references/b-series/checklist.md](references/b-series/checklist.md) | 原样保留 |
| [references/c-series/overview.md](references/c-series/overview.md) | 将同目录资源导航改为可点击相对链接 |
| [references/c-series/modules.md](references/c-series/modules.md) | 原样保留 |
| [references/c-series/checklist.md](references/c-series/checklist.md) | 原样保留 |
| [assets/000-todo.template.md](assets/000-todo.template.md) | 原样保留 |

## 治理与适配边界

- 保留 A 层需求与完成标准、B 层设计与边界、C 层实现与验证、000 层术语及状态证据的分工，包括小项目最小模式、轻量追踪和回退规则。
- 保留迁移前完整展示源文件与章节到目标文件的清单、明确授权后才写入的要求；删除或改写源文件同样纳入确认。
- 项目规则、正式文档路径及例外优先；通用规范冲突先说明并澄清，不为了套用骨架另建权威文档。
- 已移除审阅插件的联动描述、模式核验、开启提醒、调用入口和专项协作流程；不再要求用户进入插件审阅流程。
- 保留通用约束：优先复用正式执行计划，不另建第二份权威计划；审阅反馈按职责回写，修订后检查一致性并按需复审。
- 不依赖固定工具名、特定宿主入口或插件安装状态推断能力；需要工具时现场核验，不擅自安装、启用或修改配置。
- 审阅批注不等于执行批准；批准仅覆盖受审版本及明确操作，不扩张至发布、部署、删除、凭据或权限调整；实质变更须重新确认。
- 本包仅包含静态 Markdown 规则、参考资料和模板，不依赖审阅插件；收纳和维护本包本身不启动文档规划或审阅流程。本次清理仅修改技能提示词，不卸载插件或修改其安装与配置。

## 完整性检查口径

- 对照来源相对路径检查 14 个文件均存在；标为原样保留的文件应逐字节一致。
- 检查全部 Markdown 内部相对链接可解析到包内文件；正文中的 A/B/C/000 名称为目标文档角色示例，不是假定项目已存在对应文件。
- 来源最长文件为 146 行，无需拆分；本包每个文件均须不超过 500 行，后续超限时按主题拆分并同步修正链接。
- 检查无本机绝对路径、无特定其他宿主的入口假定、无运行时脚本或自动安装命令。
