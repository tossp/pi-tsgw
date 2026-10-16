# pi-tsgw

面向 TOSSP AIH gateway 的 Pi 扩展。注册 `tsgw` 提供商，其模型目录涵盖四种通信协议
（openai-completions、openai-responses、anthropic-messages、google-generative-ai），
并按厂商对请求体执行相应操作，使思考级别、推理格式和可选的内置网络搜索在网关上正常工作。

本项目不包含私有 API 密钥或网关端点。静态目录包含模型元数据和公开价格估算；
这些价格并非你的网关计费费率。

## 安装

```bash
pi install git:github.com/tossp/pi-tsgw
```

或通过 npm 安装：

```bash
pi install npm:pi-tsgw
```

然后执行 `/reload`（或重启 pi）。模型选择器中会出现 `tsgw` 提供商。

## 配置

所有配置均位于 `~/.pi/agent/settings.json` 的 `tsgw` 命名空间下。
插件不读取环境变量；API 密钥仅由 Pi 自身的凭据解析机制处理。

示例：

```json
{
  "tsgw": {
    "baseUrl": "https://aih.example.net",
    "mcpUrl": "https://xn--oht.cc/mcp",
    "tsSearch": "live",
    "traceHeaders": false,
    "excludeModels": ["gpt-*", "claude-*"],
    "includeModels": ["gpt-6-*"]
  }
}
```

### 网关地址

`baseUrl` 指向你的 AIH 网关（可以是公共实例或自托管实例）。规范化时会去掉 `/v1` 后缀。
未设置时使用一个中性的占位根地址，该地址无法实际使用。

### API 密钥

扩展将凭据读取和解析交由 Pi 处理：

1. **`/login`** — 选择 `tsgw` 提供商并输入密钥；pi 将其存储在
   `~/.pi/agent/auth.json` 中（推荐方式）。
2. **`TSGW_API_KEY` 环境变量** — 未存储凭据时由 Pi 回退使用。

启动时的发现使用 Pi 的已存储凭据 API；后续目录刷新使用 Pi 提供的凭据。
如果仅通过环境变量认证，初始目录可能回退到静态模型，直到 Pi 刷新目录。

### 选项

| 设置（`settings.json` 中的 `tsgw.*`） | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | 占位地址 | 网关根地址（规范化时去掉 `/v1` 后缀） |
| `mcpUrl` | `https://xn--oht.cc/mcp` | 可选的 `ts_oht` HTTP(S) 端点覆盖值；独立于模型网关 |
| `tsSearch` | `live` | GPT：`cached` 或 `live`；未设置、旧值 `off` 和无效值均回退到 `live`。受支持的 Grok 模型始终使用实时搜索。 |
| `traceHeaders` | `false` | 添加 `AH-Thread-Id` / `AH-Trace-Id` 请求头，用于网关侧追踪 |
| `includeModels` | 未设置 | 重新纳入的覆盖规则：匹配的模型 ID 即使也被 `excludeModels` 匹配，仍会保留（精确 ID 或 `prefix-*` 通配模式） |
| `excludeModels` | 未设置 | 黑名单：匹配的模型 ID 会被移除，除非通过 `includeModels` 重新纳入（精确 ID 或 `prefix-*` 通配模式） |

## 模型目录

目录由各厂商的分片（`extensions/models/vendors/`）组装而成，涵盖 11 个厂商系列：
DeepSeek、GLM（智谱）、MiMo（小米）、MiniMax、Kimi（Moonshot）、Qwen（阿里巴巴）、
GPT（OpenAI）、Gemini（Google）、Claude（Anthropic）、LongCat 和 Grok（xAI）。
当前静态目录包含 36 个聊天模型 ID（含保留的别名）；这不是实时可用模型数量。
厂商文件包含文档链接和元数据注意事项。别名映射、输出限制和共享思考策略并未全部
针对网关端点逐项验证；公开价格估算不构成计费保证。
MiMo 使用 `mimo-v2.6-pro` 和 `mimo-v2.6-flash`；不再注册原有 V2.5 ID。
请将显式模型选择或过滤规则更新为新 ID。

精选目录保留 DeepSeek `deepseek-flash` 和 V4 Pro；GLM 5.2+，以及明确例外
`glm-4.5-air`；MiniMax M3+；Kimi K3；GPT 6+；以及 Gemini 3.5+ 和无版本号的
`gemini-flash` / `gemini-pro` 别名。Qwen、MiMo、LongCat、Claude 和 Grok 保留现有注册。
已移除的 ID 及其专用请求策略不再注册；即使网关仍列出这些 ID，纳入规则也无法恢复它们。
现有显式模型选择若引用了已移除的 ID，需要更新。

Kimi 提供 `kimi-k3` 和网关变体 `kimi-k3-256k`，后者显示为
**Kimi K3 (256K)**，上下文窗口为 262,144 个 token。其余元数据、价格估算和思考策略
继承自 K3；131,072 个 token 的输出设置与上下文大小彼此独立。
这些继承值不代表已逐项验证该端点，也不保证该变体的计费费率。

目录还包含 `MiniMax-M3.1-Flash-Preview`、`glm-5.3`、`glm-5.3-flash` 和
`glm-5.3-flashx`。这四个模型都要求启用思考：MiniMax 使用 low/medium/high/xhigh/max；
GLM 使用 low/high/max。模型元数据中禁用了不受支持的 `off`，过时的 off/minimal 请求
会映射到 low，而不是静默选择默认的 max。MiniMax 和 GLM Flash/FlashX 支持图像输入；
GLM 5.3 仅支持文本。注册并不证明网关支持推理或工具调用。

截至 2026-10-16 的核查，MiniMax 已公布 M3.1 Flash Preview 的订阅访问方式，
但未公布按 token 计费的价格。其费用字段为零表示**未知**，而非免费，因此用量费用总计
会遗漏其实际收费。GLM 5.3 的价格估算使用国内公开费率和现有的固定 USD/CNY 换算率；
临时免费的缓存存储记为零，不代表永久计费保证。

使用宽泛的 `excludeModels` 规则排除模型系列，再用精确的 `includeModels` 规则
重新纳入指定模型。`includeModels` 不是全局白名单：两个列表都未匹配的模型仍然可用。
若只想注册指定模型，使用 `"excludeModels": ["*"]`，再通过 `includeModels` 重新纳入。
两个列表均区分大小写，仅支持精确 ID 或末尾 `*` 前缀匹配（不支持通用通配模式）；
请保留 `MiniMax-*` 的大小写。网关目录可用时，先与静态目录取交集，再应用过滤。
纳入规则无法添加未知或不可用的 ID。

打开 `/model` 会在后台刷新网关目录，并使用五分钟缓存避免重复请求。
运行 `/tsgw-refresh` 可绕过缓存立即强制刷新，无需重启或重新加载 Pi。
刷新失败时，继续使用最近一次成功获取的模型列表。

内存和磁盘缓存通过 SHA-256 摘要限定在网关根地址与凭据对应的作用域内；不存储明文凭据。
磁盘缓存仅有一个槽位，位于 `<agent-dir>/tsgw/models-cache.json`：改变作用域可能需要
重新获取。旧版无作用域缓存文件会被忽略，并在获取成功后替换。
进程内请求排序可防止较晚返回的结果覆盖更新的缓存写入；这不是跨进程锁机制。

## 状态栏与会话控制

支持 `command:/…` 状态的 Pi Web 客户端会将其渲染为可点击按钮；终端 CLI 显示状态文本，
并接受相同命令：

- **`TSGW · N`**（`/tsgw`）：在同一菜单中**刷新模型目录**和**查看诊断信息**。
  数量表示过滤后已注册的目录条目数，而非健康推理端点的数量。
  🟢 表示新鲜的目录结果；🟡 表示静态/过期目录或刷新失败；⚠️ 表示缺少凭据或网关配置；
  ⏳ 表示正在刷新。
- **内置联网**（`/tsgw-search`）：GPT 仅为当前会话提供 `cached / live`，默认为 `live`。
  受支持的 Grok 模型固定使用实时搜索：此命令只显示提示，不提供选择器，也不改变 GPT
  的会话模式。其他 TSGW 模型通过 `tsgw_search` 使用**委托搜索**，前提是有效目录中
  仍有支持搜索的模型。状态显示 `代理`（live）或 `代理缓存`（cached）；对其他提供商隐藏。

对于原生 GPT 或 GPT 委托模型，输入 `/tsgw-search cached` 或 `/tsgw-search live`；
不再接受 `off`。这些控制不会修改 `settings.json`，也不会在重新加载或新会话后保留；
`tsgw.tsSearch` 仍是启动默认值。现有 `cached` 配置会保留；未设置、旧值 `off` 和
无效配置现在均默认使用 `live`。

注入仍仅限于现有的模型/协议支持列表。GPT Responses 追加一个 `web_search` 工具
（`cached` 时 `external_web_access` 为 false，`live` 时为 true）；Grok Completions
追加 `search_parameters: { mode: "on" }`。绝不覆盖现有搜索工具/字段。
此设置不控制 Qwen 的厂商策略、外部工具或思考模式，也不是全局网络访问开关。

当当前 TSGW 模型缺少原生搜索能力时，插件会启用 `tsgw_search`：当前模型用搜索问题
调用它，由支持搜索的模型执行内置网络搜索，再将答案/来源返回当前模型。
对话模型不会改变。仅发送问题，不发送会话历史或本地工具。原生搜索模型不暴露此代理工具。

委托模型从过滤后的有效目录中选择，优先顺序为 **GPT 6 Luna**，其次是 GPT 6 Sol、
GPT 6.1 Sol、GPT 6 Astra，然后是受支持的 Grok 模型。没有候选模型时搜索不可用。
推理失败会直接报告，不会静默改用更昂贵的模型重试。每次工具调用都会额外产生一次模型请求，
以及网关可能收取的搜索费用。GPT 委托模型遵循 `cached/live`；Grok 委托模型始终实时搜索。
此工具由当前模型按需调用，不会在每条用户消息后自动搜索。

委托搜索要求 `modelRegistry.streamSimple`（已在 Pi 1.1.0 上测试）。
它复用 Pi 的注册表认证和适配器，包括 token 用量/费用统计；不会自行解析 HTTP 响应或凭据。
委托请求不继承主会话的请求/请求头钩子（包括 `traceHeaders`）。
可用时从适配器流元数据中收集来源 URL；同时也会要求搜索模型提供链接。
状态显示或请求成功都不能证明端点确实执行了搜索或返回了可靠引用。
不会恢复旧的 `ts_search` 工具。`ts_oht.search` 等外部工具仍然独立。

诊断信息显示目录来源、最初获取时间、缓存新鲜度、配置是否存在以及安全的刷新错误摘要，
绝不显示 API 密钥或 URL。诊断不会额外发起网络请求。状态会随会话/模型活动和目录刷新更新；
不会在后台轮询健康状态。

图标使用 Emoji/Unicode：Pi Web 目前会移除命令按钮中的 ANSI 颜色。
会话忙碌时按钮不可用。终端 CLI 以文本显示相同状态；请在那里使用斜杠命令。
Pi Web 可能要等会话运行时启动后才显示扩展状态。

## 随包技能

| 技能 | 用途 |
| --- | --- |
| [tsgw-git-commit](skills/tsgw-git-commit/SKILL.md) | 暂存内容核验、分批提交与中文提交说明；包含支持 worktree 的只读仓库发现脚本。 |

技能从本地维护的工作流整理并适配 Pi，按本项目 MIT 许可证提供；不包含第三方 gitmoji 数据集。
项目规则和用户授权优先，不安装 Git hook，不自动推送或发布。已有同类用户级技能时，建议择一启用，避免重复指导。

### 子代理编排与模型选型

本包附带 [tsgw-delegate-model-selection](skills/tsgw-delegate-model-selection/SKILL.md)，
鼓励适合的任务通过后台子代理执行，并提供模型/思考级别指导，包括独立的 Kimi + Astra 审查。
任务拆分、并行、验证和升级仍由代理自行决定。

插件在同一份 `SKILL.md` 中维护参考表，供直接使用，无需要求代理检查实时排名或数据新鲜度。
它是指导，不是模型白名单或固定执行顺序。价格是 API 参考费率，不是订阅费用。
GLM 指导使用 5.3，并以 Flash 和 FlashX 为备选。思考级别使用 Pi 名称：M3 推荐 `high`，
与其其他非 off 级别一样，映射为 adaptive。

安装并执行 `/reload` 后，Pi 会通过包清单发现随包技能，除非宿主/包设置禁用或过滤了技能。
可以使用 `/skill:tsgw-git-commit` 等命令显式加载；仅加载 `extensions/index.ts` 不会加载包内技能。
包设置中的 `skills: []` 可禁用全部技能，`skills: ["skills/tsgw-git-commit"]` 可仅加载指定技能，
或用 `skills: ["!skills/tsgw-git-commit/**"]` 排除该技能；由宿主处理，不是 `tsgw` 配置项。

只有模型选型技能需要宿主提供支持模型选择的子代理工具及可用的 `tsgw` 模型；通用开发技能不绑定模型 provider。
本包不提供子代理工具，也不改变调度设置、用户规则或权限。

## 默认 MCP 注册

插件每次加载时都会注册 `ts_oht`，端点为 `https://xn--oht.cc/mcp`，
暴露方式为 `codemode`。使用此默认配置无需任何 MCP 配置。
用户级设置中可选的 `tsgw.mcpUrl` 会改变插件使用的端点；它独立于 `tsgw.baseUrl`，
且仅在初始化时读取一次。显式 URL 无效时，会安全地发出警告并跳过注册，
而不是静默连接默认端点。不支持 `registerMcpServer` 的旧宿主会跳过注册。

Pi 管理连接、OAuth 登录和凭据。需要登录时，在会话内使用 `/mcp login ts_oht`。
插件不读写 `mcp.json` 或 `mcp-auth.json`，也不携带凭据。
保持相同的服务器名称和完全一致的 URL，才能复用宿主现有的 OAuth 作用域。

有效的全局/项目 `mcp.json` 中同名的 `ts_oht` 优先于插件注册，包括 `enabled: false`；
插件不会创建第二条连接，也不会绕过该选择。要覆盖 URL、暴露方式、超时、认证或启用状态，
请在文件中使用完整的同名配置。对插件提供的服务器所做的更改仅作用于当前会话，不会保存。
Shell 中的 `pi mcp` 命令不加载插件，无法看到仅由此注册提供的服务器。
配置变更后请重新加载或重启。

## 本地文件上传

`upload_local_file` 工具使用已连接的 `ts_oht` MCP 进行签名，将 Pi 宿主上已获授权的文件
直接上传到 S3。它支持单次 PUT 和流式分片上传、显式恢复、自定义下载有效期，
以及 inline/attachment 链接。它使用宿主管理的连接，不存储凭据。

上传功能要求宿主支持 `ctx.executeTool`（已在 Pi 1.1.0 和 1.2.0 上测试），
且 `ts_oht` 上传工具可调用。在 Pi 1.2+ 上，`reachesTools` 允许宿主在发现/重连期间
等待这两个依赖；旧宿主仍要求工具已经连接。它不会绕过禁用的工具、权限或认证。
文件访问使用宿主操作系统权限，而非沙箱。在含有敏感文件的环境中启用前，
请阅读[上传用法与安全边界](extensions/upload/README.md)。

## 开发

```bash
npm ci
npm test
npm exec -- tsc -p tsconfig.json
npm pack --dry-run --json
```

Pi 作为开发依赖安装；锁文件定义测试基线（Pi SDK 1.2.0，结构约束（schema）测试使用 TypeBox 1.3.37）。
SDK 保留其自身的 TypeBox 1.3.27 验证器，因此不假设结构约束构造与宿主验证使用相同版本。
Pi AI/MCP 是明确仅用于测试的开发依赖；运行时依赖和提供商的对等依赖最低版本保持不变。
测试使用临时代理目录隔离配置和凭据。单元测试使用模拟宿主；宿主集成测试通过真实 Pi SDK
加载扩展并模拟 HTTP 响应，不发起生产请求。它们不验证上游推理、原生搜索结果或 Pi Web
渲染效果。升级 Pi 后请运行完整测试套件。

## 技术细节

- [厂商配置](https://github.com/tossp/pi-tsgw/tree/main/extensions/models/vendors)：模型元数据、兼容性标志和思考映射。
- [请求操作](https://github.com/tossp/pi-tsgw/blob/main/extensions/models/operations.ts)：写时复制分派；DeepSeek/Claude 响应仍由 Pi 的适配器处理。
- [内置搜索](https://github.com/tossp/pi-tsgw/blob/main/extensions/models/web-search.ts)：精确的模型/协议支持范围和仅追加注入。
- [宿主集成](https://github.com/tossp/pi-tsgw/blob/main/extensions/index.ts)：配置、刷新、命令和生命周期快照。延迟执行的请求回调不得访问过期的会话上下文。

这些源码链接描述仓库当前的 main 分支；已安装的发行版可能有所不同。
`AGENTS.md` 中的开发规则仅用于仓库，不属于 npm 包。
