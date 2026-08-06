# AGENTS.md — pi-tsgw

本文件面向后续在此仓库工作的协作者（人类与 AI 会话），描述项目是什么、当前处于什么状态、以及如何继续开发。用户向的使用说明见根目录 `README.md`；本文件的"技术细节"章节承载请求体改写、生命周期兼容性等实现细节。

## 项目是什么

`pi-tsgw` 是 [Pi](https://pi.dev)（`@earendil-works/pi-coding-agent`）的扩展包（pi package），用于接入 **TOSSP AIH 网关**（兼容网关实例，地址由用户配置）。它向 Pi 注册 `tsgw` provider，提供：

- **模型目录**（`extensions/models/`）：按供应商分片（`vendors/`），由 `catalog.ts` 拼接展开，横跨四种 wire 协议——`openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`；支持 `includeModels` / `excludeModels` 黑白名单过滤。
- **请求体改写**（厂商思维链策略下沉在各 `vendors/*.ts`，`operations.ts` 只做调度）：按厂商改写 thinking 档位、reasoning 格式、Google thinkingConfig 等，纯函数、copy-on-write。
- **内置查询**（`extensions/web-search/`）：独立的网络模块，为支持内置查询的模型（GPT / Grok）追加 `web_search` 工具。
- **网关追踪**（可选）：`AH-Thread-Id` / `AH-Trace-Id` 请求头，供网关侧链路追踪。

定位：**公开项目**（MIT），发布为 pi package，供多台设备统一安装（`pi install git:...` 或 `npm:pi-tsgw`）。

## 当前状态（2026-08）

- 从本机 Pi 全局扩展 `~/.pi/agent/extensions/aih` 抽离而来，已**脱敏**：源码/测试/文档中无真实网关地址（网关地址仅作为用户侧配置值，由用户自行填写），`DEFAULT_ROOT` 为中性占位符 `https://aih.example.com`，无任何密钥。
- 配置机制：**settings.json 顶层 `tsgw` 命名空间**（`baseUrl` / `webSearch` / `traceHeaders` / `includeModels` / `excludeModels`）→ 内置默认。**插件不读任何环境变量**；API key 由 Pi 凭据机制解析（`/login` 写入 `auth.json`，或 `TSGW_API_KEY` 环境变量兜底——后者是 Pi 宿主行为，插件不触碰）。provider id 为 `tsgw`。
- 结构：`extensions/index.ts`（薄入口）组装两个平行模块——`models/`（模型目录 + 思维链调度）与 `web-search/`（内置查询），两模块互不依赖。
- 测试：4 个测试文件（index / models/operations / models/catalog / web-search），纯 npm 生态（tsc 编译 + node 运行），`FakePi` / `FakeContext` 模拟宿主，`PI_CODING_AGENT_DIR` 隔离配置目录。`npm run test` 全绿。
- **模型扩充进行中**：从网关实际目录（173 个）筛选 8 家供应商新增约 42 个对话模型，规格/定价需从各官网查证后写入 vendors 分片。
- **尚未 git init / 未发布**……（已发布至 github.com/tossp/pi-tsgw，main 分支；本机旧扩展 `~/.pi/agent/extensions/aih` 仍在被 Pi 加载，待本机切换后删除）。

## 环境与工具

| 项 | 值 |
| --- | --- |
| Node | v24（含原生 type-stripping，但本仓库用 tsc 编译） |
| npm | v11（**内置默认 `omit=dev`**，项目 `.npmrc` 已用 `omit[]=` 覆盖；npm 会对该空值打无害 warn） |
| 编译器 | `typescript@7`（devDependency），tsconfig 开启 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（源码 `.ts` 后缀导入编译时改写为 `.js`） |
| 测试 | `npm run test` = `tsc && node dist/extensions/index.test.js && node dist/extensions/models/operations.test.js && node dist/extensions/models/catalog.test.js && node dist/extensions/web-search/web-search.test.js` |
| 禁止 | 不使用 bun；不引入运行时依赖（当前运行时零依赖，仅 `@earendil-works/pi-coding-agent` 的 `import type` 类型 + `getAgentDir` 运行时导入） |

## 代码结构

```
extensions/index.ts            # 唯一 Pi 宿主耦合点：配置读取 + registerProvider + 生命周期钩子 + 追踪
extensions/index.test.ts       # 宿主集成测试（FakePi/FakeContext/withAgentDir）
extensions/models/             # 模型模块（平行、独立）
├── catalog.ts                 # 拼接 vendors + include/exclude 黑白名单过滤 + PROVIDER_ID/DEFAULT_ROOT/normalizeRoot
├── catalog.test.ts            # 拼接/过滤/规范化纯函数测试
├── operations.ts              # 思维链调度：汇总 vendors 策略 → 按 modelId 查表应用（薄）
├── operations.test.ts         # 思维链改写测试（deepFreeze 输入）
├── _tools.ts                  # 内部工具层：PayloadWriter / 类型 / 通用 thinking 辅助（下划线 = 内部模块）
└── vendors/                   # 供应商分片（自包含：协议引用 + compat + 思维链策略 + 模型 + 文档 URL）
    ├── _protocols.ts          # 四种 wire 协议的公共 compat（下划线 = 内部模块）
    ├── deepseek.ts / glm.ts / mimo.ts / minimax.ts / kimi.ts
    ├── longcat.ts / qwen.ts / openai.ts / gemini.ts / anthropic.ts
extensions/web-search/         # 网络模块（平行、独立）：内置查询工具注入
├── web-search.ts              # BUILTIN_SEARCH_MODELS 名单 + applyWebSearchTool
└── web-search.test.ts
```

## 关键约束（改动前必读）

1. **宿主耦合只允许在 `extensions/index.ts`**。`models/`、`web-search/` 保持纯逻辑，保证可在无 Pi 环境直接测试。`index.ts` 是唯一的组装点（两模块互不感知）。
2. **生命周期快照模式**：Pi 0.82+ 可能由旧 runner 延迟回调钩子（context 已失效）。`index.ts` 的钩子只读私有快照（provider/modelId/api/baseUrl/thinkingLevel），**不得**读取 `ctx` / `pi`；快照在 `session_start` / `agent_start` / `model_select` / `thinking_level_select` 刷新，`session_shutdown` 后保留。
3. **思维链策略跟厂商走**：各 `vendors/*.ts` 自带该厂商模型的 thinking 策略（导出 `xxxThinking: Record<modelId, ThinkingApplier>`）；`operations.ts` 只汇总调度，**不得**在 operations.ts 里新增模型族 switch。通用工具（`PayloadWriter`、`applyEnabledThinking` 等）在 `_tools.ts`，vendors 与 operations 都从这里引用（避免循环依赖）。
4. **协议定义单一来源**：协议 id 与协议级 compat 在 `vendors/_protocols.ts`；只维护四种主流协议（openai-completions / openai-responses / anthropic-messages / google-generative-ai），其他协议暂不纳入。
5. **新增模型**：改对应 `vendors/*.ts`（模型定义 + 该厂商 thinking 策略 + 头部文档 URL）；新增供应商 → 新建分片 + `catalog.ts` 加一行 import/spread + `catalog.test.ts` 补供应商覆盖断言。模型规格（contextWindow/maxTokens/input）与定价须从各官网公开信息查证，不得臆造；有国内站/国际站的供应商统一用国内站文档。
6. **配置**：settings.json `tsgw.*` > 内置默认。**插件不得读取环境变量**（含 `PI_CODING_AGENT_DIR`——那是测试隔离专用）；新增配置项保持该顺序并在 `testSettingsConfig` 补测试。
7. **公开项目红线**：不得提交真实网关地址、内部定价、密钥、令牌或任何内部信息；provider id `tsgw`、`TSGW_API_KEY`（Pi 宿主凭据变量）、`AH-*` 追踪头名属公开约定，保留。
8. **npm 11 环境**：`npm install` 默认跳过 dev 依赖，本项目 `.npmrc` 的 `omit[]=` 不可删除。

## 技术细节

### 思维链档位矩阵

| 别名族 | `off` | `high` | `xhigh` / `max` |
| --- | --- | --- | --- |
| DeepSeek V4 | `thinking.type=disabled`, remove generic effort | enabled + `reasoning_effort=high` | enabled + `reasoning_effort=max` |
| GLM 5.1 / 5.2 | disabled + `reasoning_effort=none` | enabled + `clear_thinking=false` + `high` | enabled + `clear_thinking=false` + `max` |
| MiMo / Kimi Coding | disabled, remove generic effort | enabled, remove generic effort | enabled, remove generic effort |
| MiniMax M3 | disabled + `reasoning_split=true` | adaptive + split | adaptive + split |
| Kimi K3 | remove `thinking` and effort | remove `thinking`, effort `high` | `xhigh=high`, `max=max` |
| LongCat 2.0 | disabled, remove generic effort | enabled, remove generic effort | enabled, remove generic effort |
| Qwen 3.7 | thinking/preserve false; remove budget options | thinking/preserve true + 6000/agent-max/code-interpreter | same as high |
| Gemini Flash | thoughts false, budget 0 | thoughts true, budget 16000 | `xhigh=16000`, `max=24576` |
| Gemini Pro | thoughts false + `thinkingLevel=LOW` | thoughts true + `HIGH` | `HIGH` |
| GPT Responses | retain Pi's `reasoning`; set `service_tier=flex`, text verbosity by alias | same | same |
| Claude | Pi native adaptive thinking; no operation | no operation | no operation |

For GLM, `tool_stream=true` is added only when the already-built payload has `stream === true`. Lower GLM levels retain Pi's existing native mapping rather than inventing an unverified provider strength. LongCat is explicitly an OC/AIH compatibility policy because its public HTTP thinking schema was not verified. The extension does not tighten `catalog.ts` thinking maps, so no model's current default `medium` level is newly clamped.

For the OpenAI Responses aliases, the installed Pi 0.82.0 implementation and the Responses wire schema use `text: { verbosity: ... }` (not `textVerbosity` or camelCase). Existing `reasoning`, `include`, `store`, and `parallel_tool_calls` remain untouched.

### 内置查询（web-search 模块）

`tsgw.webSearch` accepts only `off` (default), `cached`, and `live`. For models in the `BUILTIN_SEARCH_MODELS` list (GPT Responses aliases today; Grok uses the same `web_search` tool name per xAI docs, pending gateway protocol confirmation) using the AIH/OpenAI Responses API, a missing `tools` field or an existing tools array gets this append-only operation unless any `web_search*` tool is already present:

```json
{
  "type": "web_search",
  "search_context_size": "medium",
  "external_web_access": false
}
```

`cached` uses `false`; `live` uses `true`. Existing function tools, `tool_choice`, and `include` are preserved. Pi 0.82.0 drops requested sources, so this operation deliberately does not request them.

### Pi 0.82.0 lifecycle compatibility

Pi 0.82.0 can deliver `before_provider_request` and `before_provider_headers` from an old runner after that runner's context has been invalidated. These two handlers therefore never read `ctx` or `pi`. Each loaded extension instance keeps only a private scalar snapshot of the selected provider, model ID, API, base URL, and thinking level.

The snapshot is refreshed from a fresh context at `session_start` and `agent_start`; `model_select` updates its model fields and `thinking_level_select` updates its level. It is deliberately retained on `session_shutdown`, so a late callback from an old instance can safely apply the state it captured. The tracing hook uses that same snapshot and retains the `tsgw.traceHeaders` gate and the configured-root restriction.

### Scope and known limits

Only declared root fields, the three declared Google `config.thinkingConfig` fields, and the dedicated web-search append can change. There is no generic JSON Patch, history/messages rewrite, response parser, auth/header/URL alteration, cache-key alteration, or token-limit alteration.

Reasoning-content replay continues to depend on Pi's adapter. Full MiniMax `reasoning_details` and citation support is outside this extension's scope.

## 继续开发路线（建议顺序）

1. **模型扩充**：按已确认清单（8 家供应商新增约 42 个模型）查证各官网规格/定价，写入 vendors 分片；同步补 thinking 策略与测试。
2. **Grok 支持**：查证 xAI 内置查询工具格式后加入 web-search 模块名单；按需把 Grok 模型加入目录。
3. **本机切换**：在 Pi 中 `pi install git:github.com/tossp/pi-tsgw`（或 npm 源），`/reload` 验证 `tsgw` provider 与模型切换正常；然后在本机 `~/.pi/agent/settings.json` 添加 `"tsgw": { "baseUrl": "https://<你的网关地址>" }`（否则默认占位符不可用）；确认后删除旧目录 `~/.pi/agent/extensions/aih`。
4. **收尾**：README 补 screenshots/用法示例（如需）；考虑 pi 包 gallery 展示（`pi` 字段的 `video` / `image`）。

## 相关外部资料

- Pi 扩展文档：`/root/.pi/pi-web/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi 包文档：同目录 `docs/packages.md`（`pi` 字段声明、npm/git 源、安装管理）
- 凭据机制：同目录 `docs/providers.md`（API key 解析顺序、`/login`）
- 环方法论（多模型协作编排）：`/root/.config/opencode/docs/loop-methodology.md`
