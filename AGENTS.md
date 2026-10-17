# AGENTS.md — pi-tsgw

这是我们维护项目时给后续会话的工作约定。只记录开发边界、维护入口、验证和发布方式；版本快照、审查报告和临时待办不放在这里。使用说明见 `README.md`，实现以源码和测试为准。

## 项目与维护入口

`pi-tsgw` 是以自用为目标、公开发布的 MIT Pi 扩展，为 TOSSP AIH gateway 注册 `tsgw` provider。负责聊天、图片与分类模型目录、厂商请求改写、内置联网、追踪与会话状态；聊天响应解析复用 Pi，图片协议由独立适配器承载；非原生联网模型通过受控的 `tsgw_search` 代理调用支持模型。

| 改什么 | 从哪里看 |
| --- | --- |
| 依赖、测试命令、包版本 | `package.json`、`package-lock.json` |
| 扩展总入口与包清单 | 根 `index.ts`（`package.json` 的 `pi.extensions` 指向 `./index.ts`） |
| provider 注册、生命周期、命令、追踪 | `extensions/provider/index.ts`；配置读取 `extensions/provider/config.ts`，状态 `extensions/provider/status.ts` |
| 模型规格、价格、thinking 策略 | `extensions/models/vendors/*.ts` |
| 随包技能、模型选型与资源验证 | `skills/`、`extensions/skills.test.ts`、`extensions/skill-resources.test.ts` |
| 提示词注册与正文 | `extensions/prompts.ts`（`registerPrompts`）、`prompts/memory.ts`（含原有维护授权） |
| 记忆规则注入与详细维护流程 | `extensions/prompts.ts`、`skills/tsgw-smemo/` |
| 目录拼接、过滤与请求调度 | `extensions/models/catalog.ts`、`operations.ts` |
| 网络目录与缓存 | `extensions/models/gateway-catalog.ts` 及缓存辅助模块 |
| 内置联网 | `extensions/models/web-search.ts`、`extensions/search/`（`index.ts`、`proxy.ts` 及相邻测试） |
| 原生分类目录与适配器、宿主集成 | 厂商规格 `extensions/models/vendors/typesafe.ts`；能力入口与适配 `extensions/classifiers/`；`extensions/provider/classifier-host.test.ts` |
| 原生图片生成、适配与维护说明 | `extensions/images/`、`extensions/images/README.md`；宿主集成测试 `extensions/images/host-integration.test.ts` |
| provider 状态与测试 | `extensions/provider/status.ts`、`extensions/provider/` 中 provider 单测、状态单测和状态集成测试 |
| MCP 配置与宿主认证边界 | `README.md` 的 MCP 服务配置、`extensions/upload/README.md` |
| 宿主集成总测试 | 根 `index.test.ts`；其他共享测试夹具仍在 `extensions/` |
| 本地上传、分片恢复与直传安全 | `extensions/upload/`、其中的 `README.md` |
| 编译、打包、发布 | `tsconfig*.json`、`.npmignore`、`.github/workflows/publish.yml` |

## 开发边界

- 本插件用于自用，功能、随包技能与工作流以用户自身环境、需求和明确授权为设计依据；公开仓库与 npm 发布不代表面向通用用户设计。不得仅因公开发布就要求将个人工作流通用化、拆出既有授权或增加多用户兼容层；仍须遵守既有授权范围、凭据保护与宿主权限边界。
- 扩展总入口是根 `index.ts`；provider 的 Pi 运行时注册、生命周期、命令、追踪集中在 `extensions/provider/index.ts`，配置读取与状态分别由 `config.ts`、`status.ts` 承载。模型模块只使用 Pi 类型。目录拼接、过滤、请求改写、状态格式化保持纯逻辑；网络/磁盘缓存独立，不自行读取 Pi 配置。
- 厂商策略写在对应 vendor 分片；`operations.ts` 只汇总调度，不新增模型族 switch。共享工具在 `_tools.ts`；公共 compat 在 `vendors/_protocols.ts`，厂商特例留在分片。
- 复用宿主的 Completions、Responses、Anthropic、Google adapter；不复制 stream/response 实现，不引入通用 JSON Patch、消息历史或 token-limit 改写。
- 新增运行时依赖、协议或公共接口前先确认必要性。新能力以 Pi 架构为基础，能力模块可独立复用，MCP 只是可能的调用接口。
- 请求改写必须 copy-on-write，非普通对象和非 tsgw 请求原样返回；保留非目标字段及引用，用冻结输入测试。此限制不妨碍目录模块构造自己的 HTTP URL/header。
- 不为顺手优化扩大任务范围；不覆盖已有改动。源码原则上不超过 500 行，按职责拆分，不机械碎片化。
- 项目说明统一使用中文，包括文档、技能、工具及参数描述、命令帮助、错误与状态提示、代码注释和测试说明；标识符、协议字段、模型名、命令、URL、外部测试原文及标准许可证原文保持不变。

## 配置与安全

- 配置从 `getAgentDir()` 下的 `settings.json` 顶层 `tsgw` 在初始化时读取，不假称支持项目配置合并或热加载。新增配置同步更新 README 和配置测试。
- 凭据交给 Pi：启动目录查询使用 `readStoredCredential()`，刷新使用宿主传入的 credential，推理声明 `$TSGW_API_KEY`；不另建凭据解析或优先级规则，不假定两条目录凭据路径完全等价。
- 默认地址 `https://aih.example.com` 是占位符。真实网关地址、内部价格、密钥、令牌和敏感原始响应不得进入仓库、诊断或普通日志。
- 保留公开标识 `tsgw`、`TSGW_API_KEY`、`AH-*` 及产品名 TOSSP AIH gateway；不恢复旧的 `AIH_*` 命名。
- 追踪默认关闭，既有同名头按大小写不敏感方式保留。当前请求匹配检查 hostname，不应宣传成完整 origin/path 安全校验。

## 模型与缓存

- 新增模型前核对网关目录、静态登记和测试，列候选供确认；不自动把全部候选加入用户启用配置，不擅自删旧别名。ID 区分大小写，特别是 `MiniMax-*`。
- 规格、输入能力、价格与 thinking 支持须有明确证据；有国内/国际站时采用国内站。记录来源和必要的档位、汇率、别名说明；上下文窗口不等于最大输出，同族复用不等于逐型号验证。
- 经确认按网关缺席清理静态目录时，若某厂商删除后将不剩任何型号，保留一个型号及其配套策略作为后续接入参考；仍按网关交集过滤，不绕过登记规则。
- 新模型改 vendor；新供应商接入 catalog，有策略则接入 operations。补逐 ID、档位及非目标字段保留测试，不只检查总数量。
- 调整模型目录、规格、thinking 档位、价格或选型依据时，同步检查 `skills/tsgw-delegate-model-selection/SKILL.md` 的选型表与说明是否需要更新；只有涉及代码逻辑变更时才调整对应测试，选型表和说明内容通过 diff 审阅。参考表由插件维护，使用技能的模型直接参考，不承担查榜、实时核验或时效判断职责。
- 静态目录与网关目录取交集后再应用用户过滤，不自动登记未知 ID。include 优先于 exclude，但不能突破该交集；两者只支持精确 ID 和尾部 `*` 前缀匹配。
- 原生图片仅在 Pi `VERSION` 为 1.2.0 或更高稳定版本时注册 `type: image` 的 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`；低版本不注册图片模型/adapter，但聊天保持原功能，不提高最低 peer，也不以策略说明冒充旧版真实验收。图片走现有 tsgw provider、`baseUrl` 和宿主凭据解析，不增加 MCP 注册、HTTP 客户端 SDK 依赖或服务端改动。生成与编辑共用图片适配器，默认单张 PNG 而不是写死上游能力；不自动登记裸别名或其他图片模型。图片不作为聊天模型或搜索代理候选；状态计数含实际登记的聊天、图片与分类模型。
- TypeSafe 是厂商，Jev 是模型系列；厂商规格归 `extensions/models/vendors/typesafe.ts`，`extensions/classifiers/models.ts` 仅导出能力入口与宿主门。分类以 Pi 1.2.0 及以上稳定版为已验证登记基线，仅 `jev-latest`、`jev-preview`，`type: classifier`、`typesafe-system-one`，复用同 tsgw provider/认证及网关交集/用户过滤；低版本不登记分类器，不提高聊天最低 peer。目录与刷新状态计数包含分类项，但聊天选择器与搜索代理必须排除；不因网关列出就登记 Kev、SemIf 或 Luna Decisions。通过宿主可解析的 `@earendil-works/pi-ai/providers/all` 懒加载复用内置 TypeSafe classify，不复制 HTTP/解析、不增运行时依赖。始终关闭自动重试、不自动切模型，透传取消/钩子/usage，原生错误先脱敏。仅文本，总窗口 64K 与每题 32K 分开说明；公开价不是网关实扣价，输出参考价为零不等于丢弃输出 tokens。不额外开启实验头或宣称全部质量已验收。
- 图片 API 适配 `/v1/images/generations` 和 `/v1/images/edits`；两个直接工具 `tsgw_generate_image` / `tsgw_edit_image` 共用宿主 registry/认证与适配器，不要求 codemode。支持上游明确适用于两款模型的参数及组合，默认值用于减少传参，不作为任意功能限制；旧模型字段不机械搬入。默认请求 600s，支持 signal 和显式 timeout 覆盖；严禁自动重试或自动切模型，不声称取消必然停止上游处理/计费。原生 `models.generateImages` 仍仅两个参数，`context.tsgw` 是本插件扩展，不冒称宿主原生参数。
- 编辑本地输入按工具整体权限读取原始文件字节，不借用会缩放/转码的 read 预览；不宣传为内置 read 的路径审批或沙箱。图片 URL/file_id 交上游解析，不自行下载或另建文件上传服务。蒙版与原图的尺寸、格式、alpha 校验按可验证输入执行；远端引用的不可本地验证项明确交上游。工具输出保存原始字节，宿主预览可能转换；流式响应消费不等于 Pi Web 渐进预览。
- 图片价格 0 表示未映射准确价格，不是免费；usage 只含上游报告的有效 tokens。图片真实端点验收需明确授权，模拟测试不能替代真实端点验证。
- 缓存按网关与凭据隔离，不存明文凭据。过期/失败回退不得重置 `storedAt`；force 绕过新鲜缓存；迟到请求不得覆盖新缓存。旧格式或不同 scope 的磁盘数据不能直接信任。
- 带 signal 的请求独立取消，不共享调用者 signal；磁盘写入失败不阻断目录使用。入口和底层缓存分别保护乱序，不能互相替代。
- 启动缓存有效期 7 天，工具调用 24 小时，force 忽略有效期；宿主额外非强制自动同步沿用已登记目录、不追加启动联网请求；所有入口共用缓存且命中/失败不重置 storedAt。单次联网超时 5 秒，仅启动无有效作用域缓存时失败允许重试一次。启动过期缓存刷新失败沿用缓存；无缓存且失败则登记零模型，不回退静态目录。启动失败通过宿主 ui.notify 提示择机强制刷新（Pi Web Toast），非 UI 不依赖通知。动态刷新失败保留已登记列表；保留 allowNetwork、signal、乱序与身份作用域语义。

## 生命周期与联网

- 请求体/请求头钩子只读实例私有快照，不访问失效 context；会话退出断开 UI sink，但保留快照供迟到请求。跨 await 的命令和并发刷新保留 revision 防护，不因宿主升级就删除。
- 状态只描述目录新鲜度与登记数，不代表推理健康；诊断不发健康探测请求、不显示敏感值。非 UI 模式不得依赖状态渲染。Pi 核心兼容性和 Pi Web 展示分开验证。provider 状态单测和状态集成测试放在 `extensions/provider/`；共享测试夹具仍放 `extensions/`。
- GPT 内置联网仅 cached/live，默认 live；未配置、旧 off、非法值回退 live，已有 cached 保留。Grok 支持名单内固定实时，不修改 GPT 会话模式。会话控制不写 settings 或历史。
- 内置联网支持由 `builtinSearchSupport` 的精确 ID 与协议共同判断。不覆盖已有搜索工具/字段，不控制 Qwen 策略或外部工具，不宣传成全局联网开关。不恢复旧 `ts_search`；仅 tsgw 非原生联网模型激活 `tsgw_search`，从生效目录优先选 GPT 6 Luna。代理复用宿主 registry 的认证和 adapter，不复制 HTTP/stream/usage 解析；只发送搜索问题，不传会话历史或本地工具，不切换主模型，不因推理失败自动改用更贵模型。代理凭据不使用 `readStoredCredential()`；原生与代理联网都不能仅凭参数注入或 HTTP 200 声称已完成搜索验证。
- GPT reasoning 留给 adapter；Astra/6.1 Sol 的 off/minimal 用显式 null 禁用，不以省略代替。具体映射以 vendor 与测试为准，不把单个带工具请求失败推广到无工具能力。
- 分开报告目录匹配、参数注入、普通文本推理和搜索/工具/引用验证；单测或 HTTP 200 不能替代端点能力验证。

## 本地上传

- 插件不自动登记 MCP 服务、不自动写配置。用户需自行在用户级 `~/.pi/agent/mcp.json` 配置原名原 URL 的 `ts_oht`（`https://xn--oht.cc/mcp`）和 `ts_tool`（`https://mcp.tossp.com/mm/ts/mcp`），均为 codemode；示例见 README。OAuth 与凭据由宿主管理。插件不自建客户端或认证，不读写 MCP 配置和凭据。
- `upload_local_file` 只经宿主 `ctx.executeTool` 使用用户配置并由宿主连接的 `ts_oht`，不另建 MCP 客户端/服务、不读取或保存其凭据。`reachesTools` 只声明两个上传/链接工具，Pi 1.2+ 的发现/重连等待交给宿主；不能据此绕过权限、禁用或登录，也不把宿主执行前等待算入插件 330 秒 MCP deadline。宿主接口依据见 Blinko `871`、`930`；运行时能力检查与模型 provider 的最低兼容版本分开。
- 只支持当前 `mode`/`uploads[]` 契约，不恢复 `uploadUrl` 旧格式。单次 PUT 与 multipart 分开确认；上传成功不因链接签发失败降级，未知结果不自动重试。
- `resume` 是不含凭据的恢复记录，不是新建授权；先检查旧 key，只有明确 not-found 才恢复未完成分片，核对文件身份及原 key/uid 后仅发送缺失分片。进程内锁不是跨客户端锁。
- 外传权限由上传工具整体及宿主钩子控制，直接文件读取不等于内置 read 的路径审批或沙箱。签名 URL/原始错误不得进入普通日志；公开 HTTPS 目标校验、禁止重定向、并发排空和失败阶段信息不能省略。

## 验证

使用 npm，不使用 bun。TypeScript 保持 strict、NodeNext 与 `.ts` 源码导入，生产编译排除测试。

```bash
npm ci
npm test
npm exec -- tsc -p tsconfig.json
npm pack --dry-run --json
git diff --check
```

- 单元测试只验证代码逻辑，不锁定技能或文档正文、说明措辞、示例数量、展示名称及静态目录快照；这些内容通过 `git diff` 和人工审阅确认。工具测试使用独立夹具；保留加载、过滤、协议、计算、权限及脱敏等功能验证，不以单测或静态检查声称技能实际可用。
- 改哪个功能边界就补对应测试。默认测试隔离 agent-dir、凭据和网络，不读取个人配置、不请求生产网关。检查编译退出码，不把已生成 dist 当作通过。
- `TSGW_UPLOAD_LIVE=1 npm run test:upload:live` 是需授权的真实合成上传验收，不属于 `npm test`；复用宿主配置/认证，不修改服务、桶或客户端设置。远端测试对象交由既有生命周期清理，不擅自删除。
- 升级 Pi 前读目标版本的 extensions、custom-provider、packages 文档与相关示例；同步 package/lock，跑类型检查、单测与真实宿主集成。不要混淆 legacy `ProviderConfig.refreshModels` 返回列表与完整 `Provider` 的 publish 契约。
- 宿主与开发依赖版本分别核验；SDK 各包的传递依赖也要检查，不能把 coding-agent 1.2 搭配 ai/core 1.3 的混合树当作纯 1.2 验证。测试直接导入的 AI/MCP 声明为 dev 依赖，不依赖偶然提升；schema 构造器与宿主内置验证器版本分开核验。不只因本机升级就提高最低 peer 版本。未实测的上游能力与 UI 明确报告，不用模拟结果代替。
- `.npmrc` 的 dev 依赖覆盖配置有历史原因；修改前确认实际 npm 配置与安装结果，不按旧 npm 版本的假设处理。
- 检查打包清单：发布 TS 源码，不包含 dist、测试、规则或开发配置。修改 `package.json.files` 会改变 `.npmignore` 的作用，必须重查。
- 完成时报告关键改动、验证结果与阻塞，检查工作区及 HEAD 与远端 main 的关系；不能为制造干净状态擅自提交或丢弃修改。

## 发布

### 版本选择

- 当前 `0.x.y` 阶段采用本项目约定：补丁版本 `y` 用于修复、技能/文档调整、模型新增及参数更新等不改变既有使用方式的变更；次版本 `x` 用于新增独立能力，或删除模型、改变配置/工具接口等需要用户注意的兼容性变化。升次版本时补丁归零，不因普通目录更新或内部重构机械升次版本。
- `1.0.0` 由用户确认主要使用契约稳定后单独决定，不因功能数量或发布次数自动升级；已经发布的版本不重编号、不复用、不移动 tag。
- 功能提交与版本发布提交分开。日常开发不为每个提交改版本号；仅在获得发布授权、准备实际发布时，根据自上次发布以来的全部待发布改动选择版本，同一批含多类变更时采用要求最高的级别。
- 发布前核对 `package.json`、`package-lock.json`、Git tags、远端 main 和 npm 已发布版本，确认目标版本未占用；同步修改 package/lock，并确保 `v<version>` tag 指向相应发布提交。明确报告所选版本及理由，已符合规则且获授权时无需重复确认。
- 不专门维护 `CHANGELOG.md` 或其他独立变更文档；使用 Git 提交、必要的现有使用文档更新和发布汇报说明变更及兼容性影响。
- 区分源码已提交、代码/tag 已推送、CI/npm 已发布、本机插件已更新及运行验收；发布成功不代表本机安装或会话加载已更新。

### 执行与授权

- 发布流程：提交代码 → 创建版本 tag → 推送代码与 tag → GitHub Actions 自动测试并发布 npm；具体步骤以 `publish.yml` 为准。
- CI 使用 npm Trusted Publishing/OIDC，无需配置长期 `NPM_TOKEN`。`package.json.repository` 与实际 GitHub 仓库保持一致，供发布来源证明使用。
- 未经用户明确要求，不擅自触发发布；获得发布授权后按完整流程执行，不逐步骤重复确认。
- Actions 保持可读主版本引用，不仅为信息性告警改成 SHA pin；安全修改须有具体威胁依据。
