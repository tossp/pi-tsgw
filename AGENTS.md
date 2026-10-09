# AGENTS.md — pi-tsgw

本文件面向后续在此仓库工作的协作者（人类与 AI 会话），描述项目是什么、当前处于什么状态、以及如何继续开发。用户向的使用说明见根目录 `README.md`；本文件的"技术细节"章节承载请求体改写、生命周期兼容性等实现细节。

## 项目是什么

`pi-tsgw` 是 [Pi](https://pi.dev)（`@earendil-works/pi-coding-agent`）的扩展包（pi package），用于接入 **TOSSP AIH 网关**（兼容网关实例，地址由用户配置）。它向 Pi 注册 `tsgw` provider，提供：

- **模型目录**（`extensions/models/`）：按供应商分片（`vendors/`），由 `catalog.ts` 拼接展开，横跨四种 wire 协议——`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`；支持 `excludeModels` 宽排除 + `includeModels` 精确拉回（拉回优先）。网关目录在打开 `/model` 时按 5 分钟 TTL 动态刷新，也可用 `/tsgw-refresh` 强制刷新；失败保留最近成功列表。
- **请求体改写**（厂商思维链策略下沉在各 `vendors/*.ts`，`operations.ts` 只做调度）：按厂商改写 thinking 档位、reasoning 格式、Google thinkingConfig 等，纯函数、copy-on-write。
- **内置查询**（`extensions/models/web-search.ts`）：为支持内置查询的模型（GPT / Grok）追加原生搜索参数，属模型请求改写的一部分。
- **网关追踪**（可选）：`AH-Thread-Id` / `AH-Trace-Id` 请求头，供网关侧链路追踪。
- **状态栏控制**：`/tsgw` 合并目录刷新与只读诊断，`/tsgw-search` 切换本会话内置联网；Pi Web 0.11.0+ 显示为图标按钮，CLI 保留文字与命令入口。

定位：**公开项目**（MIT），发布为 pi package，供多台设备统一安装（`pi install git:...` 或 `npm:pi-tsgw`）。

## 当前状态（2026-08）

- 从本机 Pi 全局扩展 `~/.pi/agent/extensions/aih` 抽离而来，已**脱敏**：源码/测试/文档中无真实网关地址（网关地址仅作为用户侧配置值，由用户自行填写），`DEFAULT_ROOT` 为中性占位符 `https://aih.example.com`，无任何密钥。
- 配置机制：**settings.json 顶层 `tsgw` 命名空间**（`baseUrl` / `tsSearch` / `traceHeaders` / `includeModels` / `excludeModels`）→ 内置默认；模型过滤采用 `include` 拉回优先语义，若要全局只留指定模型，使用 `excludeModels: ["*"]` 后由 `includeModels` 拉回。**插件不读任何环境变量**；API key 由 Pi 凭据机制解析（`/login` 写入 `auth.json`，或 `TSGW_API_KEY` 环境变量兜底——后者是 Pi 宿主行为，插件不触碰）。provider id 为 `tsgw`。
- 结构：`extensions/index.ts`（薄入口）组装 `models/`（模型目录 + 思维链调度 + 内置查询注入），并通过 provider `refreshModels` 动态同步网关 `/v1/models`；缓存位于 `<agent-dir>/tsgw/models-cache.json`。
- 测试：8 个可执行测试文件（独立搜索测试已移除），共享宿主模拟在 `test-support.test.ts`，纯 npm 生态（tsc 编译 + node 运行），`FakePi` / `FakeContext` 模拟宿主，`PI_CODING_AGENT_DIR` 隔离配置目录。`npm run test` 全绿。
- **模型扩充进行中**：从网关实际目录（173 个）筛选 8 家供应商新增约 42 个对话模型，规格/定价需从各官网查证后写入 vendors 分片。
- **尚未 git init / 未发布**……（已发布至 github.com/tossp/pi-tsgw，main 分支；本机旧扩展 `~/.pi/agent/extensions/aih` 仍在被 Pi 加载，待本机切换后删除）。

## 环境与工具

| 项 | 值 |
| --- | --- |
| Node | v24（含原生 type-stripping，但本仓库用 tsc 编译） |
| npm | v11（**内置默认 `omit=dev`**，项目 `.npmrc` 已用 `omit[]=` 覆盖；npm 会对该空值打无害 warn） |
| 编译器 | `typescript@7`（devDependency），tsconfig 开启 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（源码 `.ts` 后缀导入编译时改写为 `.js`） |
| 测试 | `npm run test` = `tsc -p tsconfig.test.json` + 8 个 node 测试；生产构建使用 `tsc -p tsconfig.json`，排除测试及测试辅助文件 |
| 禁止 | 不使用 bun；不引入运行时依赖（Pi 宿主提供 `@earendil-works/pi-coding-agent` 与 `typebox` peer） |

## 代码结构

```text
extensions/index.ts            # 唯一 Pi 宿主耦合点：配置读取 + registerProvider + 生命周期钩子 + 追踪
extensions/index.test.ts       # 宿主集成测试
extensions/test-support.test.ts # 测试专用 FakePi/FakeContext/withAgentDir
extensions/status.ts           # 状态图标、缓存新鲜度与诊断纯展示
extensions/status.test.ts      # 展示与内置搜索能力测试
extensions/status-integration.test.ts # 命令、UI 生命周期与请求改写联动测试
extensions/models/             # 模型模块（平行、独立）
├── catalog.ts                 # 拼接 vendors + exclude/include 拉回过滤 + PROVIDER_ID/DEFAULT_ROOT/normalizeRoot
├── catalog.test.ts            # 拼接/过滤/规范化纯函数测试
├── gateway-catalog.ts         # 网关模型列表加载 + TTL 缓存（纯逻辑）
├── gateway-catalog.test.ts    # 拉取失败回退、缓存命中/过期测试
├── operations.ts              # 思维链调度：汇总 vendors 策略 → 按 modelId 查表应用（薄）
├── operations.test.ts         # 思维链改写测试（deepFreeze 输入）
├── _tools.ts                  # 内部工具层：PayloadWriter / 类型 / 通用 thinking 辅助（下划线 = 内部模块）
└── vendors/                   # 供应商分片（自包含：协议引用 + compat + 思维链策略 + 模型 + 文档 URL）
    ├── _protocols.ts          # 四种 wire 协议的公共 compat（下划线 = 内部模块）
    ├── deepseek.ts / glm.ts / mimo.ts / minimax.ts / kimi.ts
    ├── longcat.ts / qwen.ts / openai.ts / gemini.ts / anthropic.ts
├── web-search.ts              # 内置查询注入：BUILTIN_SEARCH_MODELS + applyBuiltinSearchTool
└── web-search.test.ts
```

## 关键约束（改动前必读）

1. **宿主耦合只允许在 `extensions/index.ts`**。`models/` 保持纯逻辑，保证可在无 Pi 环境直接测试。`index.ts` 是唯一的组装点。
2. **生命周期快照模式**：Pi 0.82+ 可能由旧 runner 延迟回调钩子（context 已失效）。`index.ts` 的钩子只读私有快照（provider/modelId/api/baseUrl/thinkingLevel），**不得**读取 `ctx` / `pi`；快照在 `session_start` / `agent_start` / `model_select` / `thinking_level_select` 刷新，`session_shutdown` 后保留。
3. **思维链策略跟厂商走**：需要请求体改写的 `vendors/*.ts` 自带该厂商模型的 thinking 策略（导出 `xxxThinking: Record<modelId, ThinkingApplier>`）；由 Pi adapter 原生处理的 Responses/Anthropic 模型可以没有策略。`operations.ts` 只汇总调度，**不得**在 operations.ts 里新增模型族 switch。通用工具（`PayloadWriter`、`applyEnabledThinking` 等）在 `_tools.ts`，vendors 与 operations 都从这里引用（避免循环依赖）。
4. **协议定义单一来源**：协议 id 与协议级 compat 在 `vendors/_protocols.ts`；只维护四种主流协议（openai-completions / openai-responses / anthropic-messages / google-generative-ai），其他协议暂不纳入。
5. **新增模型**：改对应 `vendors/*.ts`（模型定义 + 该厂商 thinking 策略 + 头部文档 URL）；新增供应商 → 新建分片 + `catalog.ts` 加一行 import/spread + `catalog.test.ts` 补供应商覆盖断言。模型规格（contextWindow/maxTokens/input）与定价须从各官网公开信息查证，不得臆造；有国内站/国际站的供应商统一用国内站文档。
6. **配置**：settings.json `tsgw.*` > 内置默认。**插件不得读取环境变量**（含 `PI_CODING_AGENT_DIR`——那是测试隔离专用）；新增配置项保持该顺序并在 `testSettingsConfig` 补测试。
7. **公开项目红线**：不得提交真实网关地址、内部定价、密钥、令牌或任何内部信息；provider id `tsgw`、`TSGW_API_KEY`（Pi 宿主凭据变量）、`AH-*` 追踪头名属公开约定，保留。
8. **npm 11 环境**：`npm install` 默认跳过 dev 依赖，本项目 `.npmrc` 的 `omit[]=` 不可删除。

## 技术细节

### 思维链档位矩阵

| 别名族 | `off` | `high` | `xhigh` / `max` |
| --- | --- | --- | --- |
| DeepSeek V4 Responses | Pi 原生 `reasoning.effort=none` | Pi 原生 `reasoning.effort=high` | `xhigh=high`, `max=max` |
| GLM 5.1 / 5.2 | disabled + `reasoning_effort=none` | enabled + `clear_thinking=false` + `high` | enabled + `clear_thinking=false` + `max` |
| MiMo / Kimi Coding | disabled, remove generic effort | enabled, remove generic effort | enabled, remove generic effort |
| MiniMax M3 | disabled + `reasoning_split=true` | adaptive + split | adaptive + split |
| Kimi K3 | remove `thinking` and effort | remove `thinking`, effort `high` | `xhigh=high`, `max=max` |
| LongCat 2.0 | disabled, remove generic effort | enabled, remove generic effort | enabled, remove generic effort |
| Qwen 3.7 | thinking/preserve false; remove budget options | thinking/preserve true + 6000/agent-max/code-interpreter | same as high |
| Gemini Flash | thoughts false, budget 0 | thoughts true, budget 16000 | `xhigh=16000`, `max=24576` |
| Gemini Pro | thoughts false + `thinkingLevel=LOW` | thoughts true + `HIGH` | `HIGH` |
| GPT Responses | retain Pi's `reasoning`; text verbosity by alias; no `service_tier` (flex is beta, model/account-limited — upstream rejects with 400) | same | same |
| Claude | Pi native adaptive thinking; no operation | no operation | no operation |

DeepSeek V4 aliases use `openai-responses`; Pi's adapter owns the `reasoning` object. The extension only declares the official effort mapping (`off=none`、`minimal/low=low`、`medium/high/xhigh=high`、`max=max`) and Responses compat, and does not rewrite its payload. Flash supports image input; Pro remains text-only.

For GLM, `tool_stream=true` is added only when the already-built payload has `stream === true`. Lower GLM levels retain Pi's existing native mapping rather than inventing an unverified provider strength. LongCat is explicitly an OC/AIH compatibility policy because its public HTTP thinking schema was not verified. The extension does not tighten `catalog.ts` thinking maps, so no model's current default `medium` level is newly clamped.

For the OpenAI Responses aliases, the installed Pi 0.82.0 implementation and the Responses wire schema use `text: { verbosity: ... }` (not `textVerbosity` or camelCase). Existing `reasoning`, `include`, `store`, and `parallel_tool_calls` remain untouched.

GPT-6 Sol / Luna（2026-09-23）：采用 `openai-responses`，保留既有 GPT-5.x；`off=none`、`minimal=low`，其余档位同名映射，沿用 `text.verbosity=low` 并加入内置查询名单。规格与 Standard 短上下文价格依据 Blinko #763 及 vendors 中的官方模型页；网关最小文本请求均返回 HTTP 200，尚未实测工具调用或内置查询。

GPT-6.1 Sol（2026-09-30）：依据[官方模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol.md)新增 `gpt-6.1-sol`，保留全部旧模型；采用 Responses、`low/medium/high/xhigh/max` 同名映射（显式设置 `off: null`、`minimal: null`，不能仅省略键）、`text.verbosity=low`，加入内置查询名单。网关目录已包含该 ID，最小文本请求返回 HTTP 200；工具调用与内置查询未实测。本轮 Blinko MCP 不可用，外部证据尚未同步至 Blinko。

GPT-6 档位回归：`gpt-6-astra` 与 `gpt-6.1-sol` 的 `off/minimal` 必须显式映射为 `null`；Pi 将省略的低档位视为支持，会使自动标题发送 `none`。两款均实测拒绝 `none`，`low/medium/high/xhigh/max` 均成功；`minimal` 请求因 `image_gen` 工具兼容性失败，不能据此单独证明无工具时的支持性。`gpt-6-sol` / `gpt-6-luna` 保留 `off=none`、`minimal=low`，七个 Pi 档位均实测成功。

### 内置查询（models/web-search.ts）

`tsgw.tsSearch` accepts only `off` (default), `cached`, and `live`. For models in the `BUILTIN_SEARCH_MODELS` list (GPT Responses aliases today; Grok uses the same `web_search` tool name per xAI docs, pending gateway protocol confirmation) using the AIH/OpenAI Responses API, a missing `tools` field or an existing tools array gets this append-only operation unless any `web_search*` tool is already present:

```json
{
  "type": "web_search",
  "search_context_size": "medium",
  "external_web_access": false
}
```

`cached` uses `false`; `live` uses `true`. Existing function tools, `tool_choice`, and `include` are preserved. Pi 0.82.0 drops requested sources, so this operation deliberately does not request them.

### 独立查询工具边界

独立 `ts_search` 已移除；其 GPT / Grok 并行搜索能力由外部 `ts_oht.search` 覆盖，不要求超时、重试等实现细节完全等价。使用者需自行配置外部搜索工具，本包不依赖或自动连接该 MCP 服务。模型原生联网与 `tsgw.tsSearch` 配置保留。

### 状态栏与会话控制

采用 Pi Web `command:/…` 状态键约定：`command:/tsgw` 打开目录刷新/诊断菜单，`command:/tsgw-search` 选择内置联网模式；不注册独立的刷新状态格。状态展示纯函数在 `status.ts`，宿主命令、生命周期与 UI 绑定仍只在 `index.ts`。

内置联网覆盖值只存于当前扩展运行时，`session_start` 恢复 settings 默认；不写 settings，不持久化到会话历史，不控制外部搜索工具。支持性查询和请求注入复用 `builtinSearchSupport`，避免 UI 声称支持实际上不注入的模型。Grok 既有 cached/live 均注入 `mode:on`，因此界面只提供 off/live，已有 cached 配置显示为实时。

目录加载结果携带原始 `storedAt`（内存/磁盘命中和失败回退均不重置），绿色表示新鲜目录而非推理健康。目录数量是过滤后的已登记目录；诊断只接收凭据/地址存在性，不展示密钥、URL 或原始异常。没有后台探测或刷新定时器，在生命周期/模型选择/目录刷新时更新 UI。异步目录刷新使用 revision 避免迟到的旧刷新覆盖新状态，命令收尾不得覆盖 provider 管理的加载状态；跨 await 的命令以生命周期 revision 检查会话是否已替换。`session_shutdown` 断开 UI sink，但保留请求快照。

采用依据：Blinko #856（2026-10-09 核验 Pi Web 0.11.0 源码）；按钮剥离 ANSI，因此第一版用 Emoji/Unicode 体现状态，不假称支持自定义按钮文字颜色。CLI 仍可直接执行命令；非 UI 模式不发布状态。

### Pi 0.82.0 lifecycle compatibility

Pi 0.82.0 can deliver `before_provider_request` and `before_provider_headers` from an old runner after that runner's context has been invalidated. These two handlers therefore never read `ctx` or `pi`. Each loaded extension instance keeps only a private scalar snapshot of the selected provider, model ID, API, base URL, and thinking level.

The snapshot is refreshed from a fresh context at `session_start` and `agent_start`; `model_select` updates its model fields and `thinking_level_select` updates its level. It is deliberately retained on `session_shutdown`, so a late callback from an old instance can safely apply the state it captured. The tracing hook uses that same snapshot and retains the `tsgw.traceHeaders` gate and the configured-root restriction.

### Scope and known limits

Only declared root fields, the three declared Google `config.thinkingConfig` fields, and the dedicated built-in search tool append can change. There is no generic JSON Patch, history/messages rewrite, response parser, auth/header/URL alteration, cache-key alteration, or token-limit alteration.

Reasoning-content replay continues to depend on Pi's adapter. Full MiniMax `reasoning_details` and citation support is outside this extension's scope.

## 继续开发路线（建议顺序）

1. **模型扩充**：按已确认清单（8 家供应商新增约 42 个模型）查证各官网规格/定价，写入 vendors 分片；同步补 thinking 策略与测试。
2. **Grok 支持**：查证 xAI 内置查询工具格式后加入内置查询名单；按需把 Grok 模型加入目录。
3. **本机切换**：在 Pi 中 `pi install git:github.com/tossp/pi-tsgw`（或 npm 源），`/reload` 验证 `tsgw` provider 与模型切换正常；然后在本机 `~/.pi/agent/settings.json` 添加 `"tsgw": { "baseUrl": "https://<你的网关地址>" }`（否则默认占位符不可用）；确认后删除旧目录 `~/.pi/agent/extensions/aih`。
4. **收尾**：README 补 screenshots/用法示例（如需）；考虑 pi 包 gallery 展示（`pi` 字段的 `video` / `image`）。

## 相关外部资料

- Pi 扩展文档：`/root/.pi/pi-web/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi 包文档：同目录 `docs/packages.md`（`pi` 字段声明、npm/git 源、安装管理）
- 凭据机制：同目录 `docs/providers.md`（API key 解析顺序、`/login`）
- 环方法论（多模型协作编排）：`/root/.config/opencode/docs/loop-methodology.md`
