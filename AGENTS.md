# AGENTS.md — pi-tsgw

本文件面向后续在此仓库工作的协作者（人类与 AI 会话），描述项目是什么、当前处于什么状态、以及如何继续开发。

## 项目是什么

`pi-tsgw` 是 [Pi](https://pi.dev)（`@earendil-works/pi-coding-agent`）的扩展包（pi package），用于接入 **TOSSP AIH 网关**（兼容网关实例，地址由用户配置）。它向 Pi 注册 `aih` provider，提供：

- **模型目录**（`models.ts`）：约 20 个模型，横跨四种 wire 协议——`openai-completions`、`openai-responses`、`anthropic`、`gemini`，通过一个 provider id 统一调度；含 `compat`（如 `supportsDeveloperRole: false`）、`thinkingLevelMap`、定价（各官网公开报价）等配置。
- **请求体改写**（`operations.ts`）：`before_provider_request` 钩子按模型族改写 thinking 档位、reasoning 格式、Google thinkingConfig、web_search 工具追加等，纯函数、copy-on-write。
- **网关追踪**（可选）：`AH-Thread-Id` / `AH-Trace-Id` 请求头，供网关侧链路追踪。

定位：**公开项目**（MIT），发布为 pi package，供多台设备统一安装（`pi install git:...` 或 `npm:pi-tsgw`）。

## 当前状态（2026-08）

- 从本机 Pi 全局扩展 `~/.pi/agent/extensions/aih` 抽离而来，已**脱敏**：源码/测试/文档中无真实网关地址（网关地址仅作为用户侧配置值，由用户自行填写），`DEFAULT_ROOT` 为中性占位符 `https://aih.example.com`，无任何密钥。
- 配置机制已改为 Pi 约定：**settings.json 顶层 `aih` 命名空间**（`baseUrl` / `webSearch` / `traceHeaders`）→ 环境变量回退（`AIH_BASE_URL` / `AIH_WEB_SEARCH` / `AIH_TRACE_HEADERS`）→ 内置默认。
- API key 不走插件：由 Pi 凭据机制解析（`/login` 写入 `auth.json`，或 `AIH_API_KEY` 环境变量兜底）。插件**不得**自行读取 `auth.json` 等凭据文件。
- 测试链路已切换为纯 npm 生态：`typescript`（devDependency）编译 + `node` 运行；测试用 `FakePi` / `FakeContext` 模拟宿主，`PI_CODING_AGENT_DIR` 隔离配置目录。`npm run test` 全绿。
- **尚未 git init / 未发布**。本机旧扩展 `~/.pi/agent/extensions/aih` 仍在被 Pi 加载，待发布后切换安装再删除。

## 环境与工具

| 项 | 值 |
| --- | --- |
| Node | v24（含原生 type-stripping，但本仓库用 tsc 编译） |
| npm | v11（**内置默认 `omit=dev`**，项目 `.npmrc` 已用 `omit[]=` 覆盖；npm 会对该空值打无害 warn） |
| 编译器 | `typescript@7`（devDependency），tsconfig 开启 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`（源码 `.ts` 后缀导入编译时改写为 `.js`） |
| 测试 | `npm run test` = `tsc && node dist/test/index.test.js && node dist/test/operations.test.js` |
| 禁止 | 不使用 bun；不引入运行时依赖（当前运行时零依赖，仅 `@earendil-works/pi-coding-agent` 的 `import type` 类型 + `getAgentDir` 运行时导入） |

## 代码结构

```
index.ts        # 唯一 Pi 宿主耦合点：registerProvider + 生命周期钩子 + 配置读取
models.ts       # 静态模型目录 + PROVIDER_ID + normalizeRoot + DEFAULT_ROOT
operations.ts   # 纯函数请求改写（applyModelOperations），无 IO、无 Pi 依赖
README.md       # 用户文档 + 技术细节：thinking 档位矩阵、web_search、生命周期兼容性说明
test/index.test.ts  # 宿主集成测试（FakePi/FakeContext/withAgentDir）
test/operations.test.ts  # 纯函数测试（deepFreeze 输入）
```

## 关键约束（改动前必读）

1. **宿主耦合只允许在 `index.ts`**。`models.ts` / `operations.ts` 保持纯逻辑，保证可在无 Pi 环境直接测试。
2. **生命周期快照模式**：Pi 0.82+ 可能由旧 runner 延迟回调钩子（context 已失效）。`index.ts` 的钩子只读私有快照（provider/modelId/api/baseUrl/thinkingLevel），**不得**读取 `ctx` / `pi`；快照在 `session_start` / `agent_start` / `model_select` / `thinking_level_select` 刷新，`session_shutdown` 后保留。
3. **operations.ts 只做显式命名操作**（声明式、模型特定），不做通用 JSON Patch；不改写 history/messages、不做响应解析、不改 auth/header/URL/cache-key/token 上限。
4. **新增模型**：`models.ts` 加目录项（含 `compat` / `thinkingLevelMap` / 定价，定价用各官网公开报价）；若请求体需要特殊改写，在 `operations.ts` 增加对应命名操作，并在两个测试文件中补覆盖（测试输入用 `deepFreeze` 验证 copy-on-write）。
5. **配置优先级**：settings.json `aih.*` > 环境变量 > 默认值。新增配置项时保持该顺序，并在 `testSettingsConfig` 中补测试。
6. **公开项目红线**：不得提交真实网关地址、内部定价、密钥、令牌或任何 `tossp` 内部信息；环境变量名（`AIH_*`）与 provider id（`aih`）属公开约定，保留。
7. **npm 11 环境**：`npm install` 默认跳过 dev 依赖，本项目 `.npmrc` 的 `omit[]=` 不可删除。

## 继续开发路线（建议顺序）

1. **发布准备**：`git init` → 首次提交 → 创建 GitHub 公开仓库 `pi-tsgw` → 推送。
2. **本机切换**：在 Pi 中 `pi install git:github.com/<owner>/pi-tsgw`（或 npm 源），`/reload` 验证 `aih` provider 与模型切换正常；然后在本机 `~/.pi/agent/settings.json` 添加 `"aih": { "baseUrl": "https://<你的网关地址>" }`（否则默认占位符不可用）；确认后删除旧目录 `~/.pi/agent/extensions/aih`。
3. **收尾**：README 补 screenshots/用法示例（如需）；考虑 pi 包 gallery 展示（`pi` 字段的 `video` / `image`）。
4. **后续演进候选**（未承诺）：`refreshModels` 动态目录、`filterModels`、更多模型族的 thinking 支持。

## 相关外部资料

- Pi 扩展文档：`/root/.pi/pi-web/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi 包文档：同目录 `docs/packages.md`（`pi` 字段声明、npm/git 源、安装管理）
- 凭据机制：同目录 `docs/providers.md`（API key 解析顺序、`/login`）
- 环方法论（多模型协作编排）：`/root/.config/opencode/docs/loop-methodology.md`
