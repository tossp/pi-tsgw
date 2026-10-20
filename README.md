# pi-tsgw

面向 TOSSP AIH gateway 的 Pi 扩展。注册 `tsgw` 提供商，其聊天模型涵盖四种通信协议
（openai-completions、openai-responses、anthropic-messages、google-generative-ai），
并按厂商对请求体执行相应操作，使思考级别、推理格式和可选的内置网络搜索在网关上正常工作。
图片模型通过 Pi 原生图片 API 调度，插件适配网关的 Images 接口，不经过 MCP。
分类模型通过 Pi 原生 classifier API 和内置 System One 适配器调度，复用同一 tsgw 认证。

本项目不包含私有 API 密钥或网关端点。静态目录包含模型元数据和公开价格估算；
这些价格并非你的网关计费费率。

## 项目结构

包清单的 `pi.extensions` 指向根 `./index.ts`，作为能力装配总入口；provider 注册与生命周期位于 `extensions/provider/`，模型模块位于 `extensions/models/`，图片协议实现位于该目录下的 `adapter/images/`，分类桥接位于 `adapter/classifiers/`，图片工具、参数 schema 与本地文件仍由 `extensions/images/` 承担。搜索模块及相邻测试位于 `extensions/search/`，提示词由 `extensions/prompts.ts` 的 `registerPrompts` 统一注册，正文位于 `prompts/`。宿主集成总测试为根 `index.test.ts`；provider、模型与搜索的测试与对应模块相邻，图片工具测试与 `extensions/images/` 中的实现相邻，共享测试夹具仍位于 `extensions/`。技能及其测试路径保持在 `skills/` 和 `extensions/`。

跨模块源码引用统一使用 package 子路径别名 `#tsgw/*`（映射到 `extensions/`）与 `#tsgw-prompts/*`（映射到 `prompts/`），别名不带 `.ts` 后缀；模块内部继续用相对 `.ts` 路径，由 tsc 改写为 `.js`。真实入口文件（含各 `index.ts`）继续承担实际装配职责，不为聚合再导出新增 barrel 索引。

```text
index.ts                    # 包总入口
index.test.ts               # 宿主集成总测试
extensions/provider/         # provider 注册、配置、状态与刷新
extensions/models/
  catalog.ts                # 聊天目录与最终混合目录的纯汇总/过滤
  capabilities.ts           # 图片与分类的宿主版本门
  gateway-catalog.ts        # 网关网络/磁盘缓存
  operations.ts             # 聊天请求改写
  web-search.ts             # 内置联网
  vendors/                  # 厂商规格（含 openai 图片、typesafe 分类）
  adapter/
    images/                 # 图片协议实现与对应测试
    classifiers/            # 分类桥接与对应测试
extensions/search/           # 搜索注册、代理与相邻测试
extensions/delegation/        # 子代理创建前分类选型、固定知识与相邻测试
extensions/images/           # 图片工具、schema、本地文件与宿主集成测试
extensions/prompts.ts        # registerPrompts
prompts/memory.ts            # 记忆提示词正文
extensions/upload/           # 本地上传及安全说明
skills/                      # 随包技能
```

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

初始化通过 Pi 的已存储凭据 API 校验并读取本地目录；后续刷新使用宿主提供的凭据。
两条解析路径不保证完全等价：仅通过环境变量认证时，初始化可能先登记零模型，
会话就绪后再由宿主解析凭据并恢复目录，不回退静态模型。

### 选项

| 设置（`settings.json` 中的 `tsgw.*`） | 默认值 | 含义 |
| --- | --- | --- |
| `baseUrl` | 占位地址 | 网关根地址（规范化时去掉 `/v1` 后缀） |
| `tsSearch` | `live` | GPT：`cached` 或 `live`；未设置、旧值 `off` 和无效值均回退到 `live`。受支持的 Grok 模型始终使用实时搜索。 |
| `traceHeaders` | `false` | 添加 `AH-Thread-Id` / `AH-Trace-Id` 请求头，用于网关侧追踪 |
| `includeModels` | 未设置 | 重新纳入的覆盖规则：匹配的模型 ID 即使也被 `excludeModels` 匹配，仍会保留（精确 ID 或 `prefix-*` 通配模式） |
| `excludeModels` | 未设置 | 黑名单：匹配的模型 ID 会被移除，除非通过 `includeModels` 重新纳入（精确 ID 或 `prefix-*` 通配模式） |

## 模型目录

模型规格由厂商分片（`extensions/models/vendors/`）维护。聊天目录涵盖 11 个厂商系列：
DeepSeek、GLM（智谱）、MiMo（小米）、MiniMax、Kimi（Moonshot）、Qwen（阿里巴巴）、
GPT（OpenAI）、Gemini（Google）、Claude（Anthropic）、LongCat 和 Grok（xAI）。
另有厂商 **TypeSafe** 的 **Jev** 分类模型系列，规格位于 `vendors/typesafe.ts`，
由分类能力入口单独组装，不放进聊天目录。
静态目录会持续调整，不代表网关实时可用模型数量。
厂商文件包含文档链接和元数据注意事项。别名映射、输出限制和共享思考策略并未全部
针对网关端点逐项验证；公开价格估算不构成计费保证。
MiMo 使用 `mimo-v2.6-pro` 和 `mimo-v2.6-flash`；不再注册原有 V2.5 ID。
请将显式模型选择或过滤规则更新为新 ID。

精选目录保留 DeepSeek `deepseek-flash` 和 V4 Pro；GLM 5.2+，以及明确例外
`glm-4.5-air`；MiniMax M3+；Kimi K3；GPT 6+；以及 Gemini 3.5+ 和无版本号的
`gemini-flash` / `gemini-pro` 别名。当前裁剪移除了 Qwen `qwen3.7-max`、`qwen3.6-plus`、
`qwen3.5-plus`，Claude `claude-fable-5`，以及 Grok `grok-4.20`、`grok-4.20-fast`、
`grok-4.3-low`、`grok-4.3-medium`、`grok-4.3-high`。Qwen 仅保留 `qwen3.7-plus` 及其
完整请求策略，作为厂商最后一个接入参考；它仍须命中网关目录才会登记，并非可绕过网关
交集的默认模型。Grok 保留 `grok-4.5` 并新增 `grok-4.7`；Claude 当前仅保留 Opus 和 Sonnet。
其他已移除的 ID 及其专用请求策略不再注册；即使网关仍列出这些 ID，纳入规则也无法恢复它们。
现有显式模型选择若引用了已移除的 ID，需要更新。

新增 `grok-4.7`、`gemini-3.5-flash-lite`、`gemini-3.8-flash-high` 和 `longcat-2.5-preview`：

| ID | 协议与端点后缀 | 思考映射 | 2026-10-17 最小真实验收 |
| --- | --- | --- | --- |
| `grok-4.7` | Responses，`/v1` | low/medium/high/xhigh；不支持 off，max→xhigh | 文本通过；函数调用未通过；原生搜索无事件/来源，故不加入搜索支持名单 |
| `gemini-3.5-flash-lite` | Completions，`/v1` | minimal/low/medium/high；off→minimal，xhigh/max→high | 文本、函数调用与默认工具选择下的结果往返通过；显式 tool_choice:none 的结果轮曾超时 |
| `gemini-3.8-flash-high` | Google，`/gemini/v1beta` | low/medium/high；off/minimal→low，xhigh/max→high | 文本、函数调用与工具结果往返通过 |
| `longcat-2.5-preview` | Completions，`/v1` | off 关闭，其他档开启；无已确认深度映射 | 上游额度耗尽，推理及工具验收阻塞 |

上述验收仅覆盖短文本与最小工具夹具，不代表全部模态、上下文容量或七档已逐项验证。
两款 Gemini 的旧 `/gemini` 路径均不可用；仅新型号按实测选择协议与版本路径，不修改旧型号。
3.8 的网关 ID 后缀 `high` 不作为已确认的固定档位契约；规格/价格继承官方基础型号。
3.8 采用截至 2026-12-31 的介绍价，2027-01-01 起应复核更新；Grok 4.7 采用输入少于
200K 的公开价，达到 200K 后输入、缓存与输出均加倍。LongCat 使用国内限时价并按
固定 0.1475 USD/CNY 折算；公开价格只用于估算，不代表网关实际计费。
Grok 4.7 的官方文本输出不设独立上限，目录以 500K 上下文作为输出容量上界，
不代表可同时填满输入与输出。LongCat 2.5 输出上限按逐型号参数页采用 256K；
官方快速开始仍写 128K，图像更新说明也与纯文本 API schema 存在差异，当前保守登记文本输入。

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

插件初始化只读取本地缓存、完成 provider 注册，**不等待网络**：有可用缓存就先加载，
包括过期缓存；无有效缓存则先登记零个模型，不回退静态目录，也不阻塞宿主启动。
所有入口统一使用 **24 小时**新鲜窗口；内存与磁盘同时存在时选择获取时间更新的快照，
命中缓存和失败回退均不更新原始获取时间。

会话就绪且宿主允许联网后，缺少缓存或缓存过期时后台获取目录。单次请求超时 **5 秒**，
失败后间隔 **5 秒**重试；整轮请求与等待合计最多 **60 秒**。同进程的实例共用恢复轮次与重试序列，
后来加入不延长共享截止；每个实例仍以自身启动的一分钟窗口约束本地准备、等待与登记。
获取始终通过仍活跃实例的宿主服务执行，以保留联网许可和凭据解析。成功后各实例通过宿主同步自己的模型登记，
停止重试并清除异常状态。缺少凭据或认证失败直接提示，不等待一分钟；宿主禁止联网时不绕过许可。
一分钟内仍未获取成功则停止自动请求，通过 `ui.notify(..., "error")` 发出红色 Pi Web Toast，
同时保留红色异常状态。有旧目录时提示正在沿用缓存，无缓存时提示当前无可用模型。
同一轮失败只提醒一次；Toast 不代表用户已读，非 UI 模式使用安全日志提示。
会话退出或实例替换时取消恢复；不建立常驻轮询，不自动重试推理。

运行 `/tsgw-refresh` 可绕过缓存强制刷新，无需重启或重新加载 Pi；手动刷新不自动重试。
单个插件实例发起的后台恢复、命令和工具刷新共用一个登记调度器：同类请求合并；普通获取已经联网时，
后来的强制刷新复用同一请求，不再重复 GET；尚未决定读取缓存时，强制意图提升本轮网络阶段。
已命中缓存并完成的普通获取不能满足新的强制刷新。实际获取层也合并已进入插件的宿主回调，
一个调用方取消只退出自己的等待，仍有其他调用方等待时不取消共享任务。
Pi Web 多会话和后台 runtime 可分别加载插件；同一 JS 全局环境、同一 agent-dir 的实例
通过进程级服务共用原始目录与实际 GET，即使模块被重新导入也不重复建立获取任务。
各实例仍分别应用模型过滤与宿主能力、同步自己的登记和 UI；退出一个实例不取消其他实例的等待。
仅共享获取不代表所有宿主登记入口已全局串行。宿主在首次回调之前
自行进行的刷新重组不属于插件可观察的队列。
Pi Web 的目录刷新入口与聊天会话使用独立 runtime；并发获取在共享服务合并，
结果分别登记到对应 runtime，不把两者假设成同一个宿主刷新队列。
动态刷新失败保留原目录。旧版宿主若不转发强制刷新参数，未确认实际联网时只提示未完成刷新，
不误报成功；不提高聊天最低宿主版本。另一个会话更新缓存后，当前会话在下次目录检查时吸收更新，
不提供跨会话实时广播。

模型可通过 codemode 调用 `tools.tsgw_refresh_models({})` 自动获取，
或 `tools.tsgw_refresh_models({ force: true })` 强制刷新。
工具返回 `cacheFilePath`、`count` 与 `storedAt`，随后读取该文件的 `ids` 即为完整网关列表，
包括尚未静态登记的型号；不会把完整列表重复塞入工具返回值，也不会自动登记未知型号。
工具每次都经宿主刷新流程同步当前目录，缓存是否可用统一由 provider 判断。
返回的文件必须属于当前配置且对应已应用的完整快照；强制刷新时要求本次写入。
取消、获取失败或未确认落盘时，不会把旧文件报成本次刷新成功。

插件仅注册一个 `tsgw` provider，使用一个当前密钥。缓存文件固定为
`<agent-dir>/tsgw/models-cache.json`，不提供多配置或多槽位管理。
网关地址与密钥仅以 SHA-256 摘要校验，避免更换配置后误用旧缓存，不存储明文凭据。
旧版无摘要缓存会被忽略，并在获取成功后替换。
进程内请求排序可防止较晚返回的结果覆盖更新的缓存写入；这不是跨进程锁机制。

## 原生图片生成

Pi 1.2+ 可在现有 `tsgw` provider 中注册 `gpt-image-2.5-flare` 和
`gpt-image-2.5-sunburst` 两个 `type: image` 模型。它们复用相同的 `baseUrl`、TSGW
凭据及 `$TSGW_API_KEY`；由 Pi 宿主解析 `options.apiKey`。图片目录受静态目录、网关目录
与 `includeModels` / `excludeModels` 的交集及过滤规则约束；不会自动登记裸别名
`gpt-image-2.5` 或其他图片模型。需要按前缀纳入时可用 `"includeModels": ["gpt-image-2.5*"]`，
但 include 不能突破目录交集。

图片能力提供两个直接工具：`tsgw_generate_image` 从文字生成图片，`tsgw_edit_image` 使用原图和可选蒙版编辑。
它们共用宿主 `modelRegistry.generateImages()` 和同一图片适配器，不要求启用 codemode。
默认使用 Sunburst 生成一张 PNG，草稿任务可选 Flare；质量、尺寸、格式、压缩、数量、背景及流式参数可按需覆盖。
工具返回图片和保存原始字节的临时路径；编辑支持本地文件、图片 URL/data URI 或上游文件 ID。
图片模型不进入聊天选择器或搜索代理。原生 codemode 调用仍可用；调用、文件权限、超时及结果边界见
[图片生成维护与使用说明](extensions/images/README.md)；该说明描述工具与文件层，协议实现位于 `extensions/models/adapter/images/`。

随包 [tsgw-image-generation](skills/tsgw-image-generation/SKILL.md) 技能提供生成、编辑、模型选型和参数示例；
可以直接描述需要的图片，也可使用 `/skill:tsgw-image-generation` 显式加载技能。

图片价格显示为 0 表示尚未映射准确价格，不是免费；usage 只统计上游已报告的有效 tokens。
隔离测试不替代真实网关对各参数、编辑、流式和图片展示的逐项验收。

## 原生分类模型

厂商为 **TypeSafe**，模型系列为 **Jev**。Pi 1.2.0 及以上稳定版本登记
`jev-latest`、`jev-preview` 两个 `type: classifier` 模型，复用现有 `tsgw` provider、网关根地址及宿主认证，端点为 `/v1/systemone`。
旧宿主不登记分类模型，聊天最低兼容版本不变。不将 Jev 放入聊天选择器、图片目录或搜索代理候选；
它们和其他模型一样受静态目录、网关目录交集及 `includeModels` / `excludeModels` 过滤约束。
仅登记这两个已验收 ID，不登记 `Kev-4B`、`SemIf` 或 Luna 的 Decisions 身份。

通过宿主 codemode 调用（需启用 codemode；不需要新增 MCP 服务）：

```javascript
const model = await models.getModelOfType("classifier", "tsgw", "jev-latest");
if (!model) throw new Error("分类模型未登记，请检查网关目录和过滤配置。");
const result = await models.classify(model, {
  state: { message: "订单被重复扣款，请今天处理。" },
  questions: {
    urgent: { type: "bool", instructions: "是否需要今天处理？",
      criteria: { true: "今天处理", false: "可以等待" } },
    department: { type: "choice", instructions: "由哪个团队处理？",
      criteria: { billing: "付款和退款", technical: "故障", other: "其他" } },
    severity: { type: "score", instructions: "严重程度如何？",
      criteria: ["轻微", "有替代方案", "完全阻塞"] },
  },
});
text(result.stopReason === "stop" ? result.answers : { error: result.errorMessage });
```

扩展也可直接调用 `ctx.modelRegistry.classify()`，不依赖 codemode。bool 映射为线上的
`noul` 并返回成立概率；choice 返回选项、概率分布与置信度；score 返回从 0 开始的等级
索引期望值（可以是小数），不是整数标签。分类适配由 `extensions/models/adapter/classifiers/adapter.ts`
桥接宿主内置 SystemOne，登记能力门位于 `extensions/models/capabilities.ts`；适配器不复制 HTTP 或结果解析，
始终禁用自动重试、不自动换模型，错误只输出脱敏摘要，调用者应检查 `stopReason`。

当前仅声明文本输入，总请求窗口采用官方 64,000 tokens；官方单题窗口为 32K，不能把总窗口
当作每题预算。未开启实验图片或长上下文。输入参考价为 $0.042／百万 tokens、输出参考价
为零（2026-10-18，来源：[TypeSafe Models](https://docs.typesafe.ai/models)，资料见 Blinko 950），
不代表网关实际扣费。usage 保留上游实际报告的 tokens，不因输出参考价为零就抹去输出量。
两 ID 都是可移动别名，不推定网关底层版本。此前短文本 bool/choice/score 已经宿主原生
解析验收；不代表长上下文、中文质量或概率校准已验收。隔离回归不替代真实能力验证。

## 状态栏与会话控制

支持 `command:/…` 状态的 Pi Web 客户端会将其渲染为可点击按钮；终端 CLI 显示状态文本，
并接受相同命令：

- **`TSGW · N`**（`/tsgw`）：在同一菜单中**刷新模型目录**和**查看诊断信息**。
  数量表示过滤后已注册的聊天、图片与分类目录条目数，而非健康推理端点的数量。
  🟢 表示新鲜的目录结果；🟡 表示静态/过期目录；🔴 表示获取失败；⚠️ 表示缺少凭据或网关配置；
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
| [tsgw-image-generation](skills/tsgw-image-generation/SKILL.md) | 通过两个图片工具生成或编辑图片，按草稿/成稿选择模型，并说明默认值和完整可选参数。 |
| [tsgw-git-commit](skills/tsgw-git-commit/SKILL.md) | 暂存内容核验、分批提交与中文提交说明；包含支持 worktree 的只读仓库发现脚本。 |
| [tsgw-github](skills/tsgw-github/SKILL.md) | 使用 gh 查询与维护 issue、PR、CI，安全发布正文并核验 Actions 升级。 |
| [tsgw-mk-docs](skills/tsgw-mk-docs/SKILL.md) | 需求、设计、执行计划、术语和状态证据的文档治理，含参考清单与模板，不依赖审阅插件。 |
| [tsgw-programmer-go](skills/tsgw-programmer-go/SKILL.md) | Go 编码与审查；自产 JSON 使用 PascalCase、零值省略优先 omitzero，真实变更中同步迁移相关旧标签。 |
| [tsgw-smemo](skills/tsgw-smemo/SKILL.md) | Blinko 共享知识的检索、沉淀与维护，含原有维护授权和操作参考。 |

技能从本地维护的工作流整理并适配 Pi，按本项目 MIT 许可证提供；不包含第三方 gitmoji 数据集。
项目规则和用户授权优先，不安装 Git hook，不自动推送或发布。已有同类用户级技能时，建议择一启用，避免重复指导。

### 子代理编排与模型选型

本包附带精简的 [tsgw-delegate-model-selection](skills/tsgw-delegate-model-selection/SKILL.md)。
Pi 1.2+ 在兼容的 `model-only Agent` 执行前，**只对新建且未指定模型的调用分类一次**：
主代理直接提交任务提示词，插件使用内置选型知识补入 `Agent.model`，随后继续原工具执行。
不需要主代理读取长表、编写分类代码或收到分类结果后再派遣一次。

分类器从生效的 `tsgw` 文本分类目录动态选择，不固定 ID；按已知非零输入＋输出参考价排序，
未知/零价排后，同价按 provider/ID 字典序。聊天候选取已维护模型/档位与生效目录及会话范围的交集，
分类后再次校验。价格只是参考，不是网关实扣价。分类增加一次请求的耗时和费用。

显式 `model`、`resume`、结果查询、补充指令及后续轮次不介入，不运行中换模型。
固定 Kimi＋Astra 双审由主代理分别显式指定 `tsgw/kimi-k3:high`、`tsgw/gpt-6-astra:max`；
正式架构/设计文档独立审阅默认 Astra/max。任务拆分、依赖、并行、权限和验收仍由主代理负责。
分类失败、未决、取消、无候选或选定模型失效时，阻止本次自动创建并提示显式指定模型，
不静默使用父模型、不自动重试或换分类器；分类等待最多 15 秒，材料上限 28 KiB，超限不截断任务。

原 `Agent` 的调用 ID、宿主调度和子会话关联保持不变；工具结果附选型摘要，
`details.tsgwDelegation` 保留追踪信息，已报告分类用量合入原工具 `usage`。
选型知识和原参考表已迁入 [创建前选型维护说明](extensions/delegation/README.md) 与 `policy.ts`，
不要求主代理查榜或读取维护资料。隔离回归不证明真实选型质量或 Pi Web 展示已验收。

安装并执行 `/reload` 后，Pi 会通过包清单发现随包技能，除非宿主/包设置禁用或过滤了技能。
可以使用 `/skill:tsgw-git-commit` 等命令显式加载；仅加载根 `index.ts` 不会加载包内技能。
包设置中的 `skills: []` 可禁用全部技能，`skills: ["skills/tsgw-git-commit"]` 可仅加载指定技能，
或用 `skills: ["!skills/tsgw-git-commit/**"]` 排除该技能；由宿主处理，不是 `tsgw` 配置项。

模型选型需要兼容的子代理工具及可用的 `tsgw` 分类/聊天模型；旧宿主或无兼容工具时不挂接自动选型。
图片生成技能需要 Pi 1.2+、图片工具与可用的 `tsgw` 图片模型。通用开发技能不绑定模型 provider。
禁用随包技能不会关闭扩展中的创建前选型钩子；显式指定 `Agent.model` 可跳过选型。
本包不提供子代理工具，也不改变调度设置、用户规则文件或宿主权限。

### 记忆规则注入

常驻提示词正文集中在 `prompts/`，与扩展注册入口分开维护。提示词由 `extensions/prompts.ts` 的
`registerPrompts` 统一注册；记忆提示词正文位于 `prompts/memory.ts`。

插件在 `before_agent_start` 中注入原用户规则中的记忆体系与既有条目维护授权，
不绑定当前模型 provider，不新增配置，不改写用户规则文件。
详细流程保留在 `tsgw-smemo` 技能及其参考资料中；`ctx_memory` 仍称为“系统记忆”，
smemo／Blinko 仍称为“记忆系统”。技能迁移不操作 Blinko 数据或改变宿主认证与权限。
从本地 `smemo` 迁入时，确认新版本插件与随包技能加载生效后，再移除原技能和用户规则中的重复内容。

## MCP 服务配置

插件不再自动登记 `ts_oht` 或 `ts_tool`，也不会自动写入任何配置。需要使用时，请由用户自行在
`~/.pi/agent/mcp.json` 配置；以下示例保留服务原名、原 URL，并以 `codemode` 暴露：

```json
{
  "mcpServers": {
    "ts_oht": {
      "url": "https://xn--oht.cc/mcp",
      "exposure": "codemode"
    },
    "ts_tool": {
      "url": "https://mcp.tossp.com/mm/ts/mcp",
      "exposure": "codemode"
    }
  }
}
```

Pi 宿主管理 MCP 连接、OAuth 登录和凭据；可通过设置页或 `pi mcp login ts_oht` /
`pi mcp login ts_tool` 完成登录。迁移时保持相同名称和精确 URL 可复用已有认证记录；
记录失效时仍需重新授权。旧的 `tsgw.mcpUrl` 已移除，不再生效。配置变更后请重新加载或重启。
插件不自建 MCP
客户端或认证逻辑，不读写 `mcp.json` / `mcp-auth.json`，也不携带凭据。
上传工具仍复用宿主已连接且可调用的 `ts_oht`，不会自行连接或绕过禁用、权限及认证状态。

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
Pi AI/MCP 显式列为开发依赖，供类型检查和测试使用；分类功能运行时通过 Pi 宿主的
loader 映射复用其内置 AI adapter，不由插件安装或携带第二份实现。未新增运行时依赖，
提供商的对等依赖最低版本保持不变。
测试使用临时代理目录隔离配置和凭据。单元测试使用模拟宿主；宿主集成测试通过真实 Pi SDK
加载扩展并模拟 HTTP 响应，不发起生产请求。它们不验证上游推理、原生搜索结果或 Pi Web
渲染效果。升级 Pi 后请运行完整测试套件。

## 技术细节

- [厂商配置](https://github.com/tossp/pi-tsgw/tree/main/extensions/models/vendors)：模型元数据、兼容性标志和思考映射。
- [请求操作](https://github.com/tossp/pi-tsgw/blob/main/extensions/models/operations.ts)：写时复制分派；DeepSeek/Claude 响应仍由 Pi 的适配器处理。
- [内置搜索](https://github.com/tossp/pi-tsgw/blob/main/extensions/models/web-search.ts)：精确的模型/协议支持范围和仅追加注入。
- [扩展总入口](https://github.com/tossp/pi-tsgw/blob/main/index.ts)：包加载入口；[provider 集成](https://github.com/tossp/pi-tsgw/tree/main/extensions/provider)：注册、配置、刷新、命令和生命周期快照。延迟执行的请求回调不得访问过期的会话上下文。
- [图片协议实现](extensions/models/adapter/images/) 与 [分类桥接](extensions/models/adapter/classifiers/)：图片六个协议文件与分类适配器；工具注册与参数 schema 仍位于 [images](extensions/images/)，[能力门](extensions/models/capabilities.ts) 判定图片与分类各自的宿主最低版本。
- [提示词注册](https://github.com/tossp/pi-tsgw/blob/main/extensions/prompts.ts)：`registerPrompts` 统一入口；记忆正文位于 `prompts/memory.ts`。

这些源码链接描述仓库当前的 main 分支；已安装的发行版可能有所不同。
`AGENTS.md` 中的开发规则仅用于仓库，不属于 npm 包。
