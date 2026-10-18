# 图片生成与编辑

本目录维护 `tsgw` 的两个直接图片工具、参数 schema 与本地文件处理。工具通过 Pi 模型注册表和供应商认证，调用 `extensions/models/adapter/images/` 的同一套请求/响应实现，不另建凭据解析或 HTTP SDK。

## 入口与模型

- `tsgw_generate_image`：从文字生成图片，只有 `prompt` 必填。
- `tsgw_edit_image`：根据 `prompt` 和 `images` 编辑图片，`mask` 可选且对应第一张参考图。
- 两个工具默认直接向模型声明，不要求启用 codemode；仅 Pi 1.2.0 或更高稳定版登记，旧宿主保持聊天能力，不提高最低 peer。
- 只登记 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst` 两款 `type: image` 模型，输入为文本/图片，输出为图片。草稿/速度优先选 Flare，成稿/质量优先选 Sunburst；工具默认 Sunburst，不自动选择另一型号重试。
- 图片目录仍取静态目录与网关目录的交集，再应用 include/exclude。`includeModels: ["gpt-image-2.5*"]` 不能突破交集；图片不进入聊天模型选择器或联网代理候选。

工具输入示例及完整可选参数表见随包[图片技能](../../skills/tsgw-image-generation/SKILL.md)。技能用于任务选型与参数使用，不代替实际工具执行；图片目录是否登记由 `extensions/models/capabilities.ts` 的版本门判定。

## 请求与参数

生成使用 `POST /v1/images/generations`；编辑使用 `POST /v1/images/edits` 的 JSON `images[]` / `mask` 引用形式。不创建上游 Files 对象，不自动改用 multipart 重试。两种请求沿用 provider 的 `baseUrl`，由宿主解析现有 TSGW 认证并传入 `options.apiKey`。

默认值是使用便利，不是功能限制：

- `quality`、`size`、`background`、`moderation` 默认 `auto`；`n` 默认 1，可选 1–10。
- `output_format` 默认 `png`，也支持 `jpeg` / `webp`；JPEG/WebP 可用 `output_compression: 0..100`，省略采用上游默认 100。PNG 不发送压缩参数，透明背景不能配 JPEG。
- `quality` 支持 `auto/low/medium/high/xhigh/max`。尺寸支持 auto 或符合上游边长、像素、16 倍数和宽高比条件的 `宽x高`；超过 3686400 像素为上游实验范围。
- `stream` 默认 false；`partial_images` 默认 0，仅流式时可指定 0–3。流式响应中的过程图不计作额外生成图；当前接口返回最终图片，不承诺 Pi Web 渐进预览。
- `safety_identifier` 默认省略，最多 128 字符；`user` 仅为上游废弃字段兼容保留。不自动采集或生成用户身份。
- `response_format`、`style`、`standard/hd` 是旧模型字段或取值，不混入这两款能力；`input_fidelity` 没有两款 2.5 的明确支持证据，不据共享 schema 自动开放。

未知参数、无效取值和冲突组合在请求前报错。`onPayload` 可改变有效参数，序列化后仍核对实际发送内容和端点边界，不允许换模型、把生成悄悄变成编辑或绕过验证。

## 原图、蒙版与本地权限

每个 `images[]` 或 `mask` 来源必须且只能选择一种：

- `{ path: "source.png" }`：Pi 主机本地普通文件，相对路径按 `ctx.cwd` 解析；直接读取原始字节，不经内置 `read` 的缩放或转码。
- `{ image_url: "https://…" }`：无用户名密码的 HTTP(S) URL，或 PNG/JPEG/WebP 的 base64 data URI。
- `{ file_id: "file-…" }`：调用方已有的上游图片文件 ID。

参考图 1–16 张，保持顺序。蒙版不占参考图张数；可读取的蒙版须有 alpha 通道，并与第一张图的尺寸、格式匹配。

本地文件和内联图片每个严格小于 50 MB，参考图与蒙版合计不超过 100 MB；这是插件资源预算，不代表上游最大业务容量。只读普通文件，核对读取前后身份与大小；不修改输入、不转码或丢弃透明通道。URL/file_id 交上游解析，不在插件内下载，无法本地检查的尺寸/蒙版条件由上游验证。

文件读取及外传由图片工具整体和宿主工具钩子控制，使用 Pi 进程的操作系统权限，**不等于内置 read 的审批或文件沙箱**。输入引用可能含临时签名，结果和普通错误不复述这些值。

## 原生程序化入口

原生 `models.generateImages(model, context)` 仍可用，只有两个参数。`context.tsgw` 是本插件增加的供应商参数，不是 Pi 通用 ImagesContext 的标准字段；TypeScript 调用方可使用 `TsgwImagesContext` 类型。

```js
// @options: {"timeout_ms": 660000}
const model = await models.getModelOfType("image", "tsgw", "gpt-image-2.5-sunburst");
const result = await models.generateImages(model, {
  input: [{ type: "text", text: "横版水墨山水，远山薄雾，一叶扁舟，不要文字" }],
  tsgw: { quality: "high", size: "1536x1024", output_format: "webp", output_compression: 85 },
});
if (result.stopReason !== "stop") throw new Error(result.errorMessage);
for (const block of result.output) if (block.type === "image") image(block);
```

原生 `input` 的图片块用于参考图编辑，也可使用 `tsgw.images` 的上游引用；两者不能同时提供。显式 `tsgw.operation` 为 `generate` / `edit`，省略时按是否有参考图决定；工具始终明确指定操作。蒙版通过 `tsgw.mask` 提供。原生调用不直接读取本地 path，读取原文件由工具层负责。

codemode 原生桥接不传第三参数，不会通过修改 model 对象转发参数。宿主 SDK 的 `ctx.modelRegistry.generateImages()` 仍可在 options 中传 `timeoutMs`、signal 和钩子。

## 超时、输出与用量

请求默认 600000ms，可通过工具的 `timeout_ms` 或 SDK 的 `options.timeoutMs` 显式缩短或延长，最大不超过 Node timer 范围。codemode 包装脚本应留余量，例如默认请求配 660000ms；它不是请求超时参数。取消、超时或失败都不自动重试或改用其他模型，也不保证上游停止处理或计费。

成功结果包含实际图片块和原始文件临时路径。原始文件以唯一临时目录、排他创建写入，不覆盖用户文件；保存失败保留上游用量及可用图片，明确区别“生成成功但保存失败”。预览进入会话后可能由宿主缩放/转码；后续精确编辑应使用保存的原始文件。

响应读取有界：普通 JSON 按每张 32 MiB 预算扩展，流式按单事件 32 MiB 及总流预算控制。返回图片单边不超过 3840，总像素不超过 8294400。PNG/JPEG/WebP 校验容器、必要头、尺寸等；PNG 保留 CRC 验证，不声称完整解码压缩像素流。JPEG 接受常见 Huffman 顺序/渐进编码，WebP 不接受动画容器。

usage 仅取上游报告的有效 tokens；坏图、断流等失败路径仍尽量保留已报告用量。多图 SSE 的逐事件用量是否共享、累计或重复汇总尚无明确契约，工具以 `usage_reports` 保留有效报告并标注 `usage_note`，不相加、不当作请求总量计入会话，也不因计量不明而丢弃有效图片；原生结果以 `tsgwUsage` 携带此扩展信息。图片价格 0 表示未映射准确价格，不表示免费。模型登记、参数注入和合成 SDK 测试都不等于真实端点、全部组合或 UI 行为验收。

## 维护与验证

- 本目录只承担图片工具与文件处理：`tools.ts` / `tool-schema.ts` / `tool-files.ts` 与对应 `tools.test.ts` / `tool-files.test.ts` / `tools-host.test.ts` / `host-integration.test.ts`。
- 图片协议实现位于 `extensions/models/adapter/images/`：`adapter.ts`（宿主凭据、HTTP、钩子与取消/超时）、`parameters.ts` / `request.ts`（参数、引用、生成/编辑请求及序列化）、`response.ts` / `image-data.ts` / `stream-response.ts`（用量、格式校验、普通/流式响应）及对应单测；共享原图夹具 `image-fixtures.test.ts` 随协议层迁移，工具层继续跨目录复用而不复制数据。
- `extensions/models/capabilities.ts` 提供纯版本判断，由根入口和 provider 决定图片工具、模型与适配器是否登记；它不读 `VERSION` 全局，不将模块加载与能力登记混为一谈。

接口与模型证据见记忆系统 942；用户确认网关编辑端点兼容，不替代本插件新组合的独立验收。测试不读取个人配置或请求真实网关，真实推理另需授权。
