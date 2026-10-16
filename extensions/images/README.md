# 原生图片生成

本目录维护 `tsgw` provider 的原生图片生成适配，以及宿主集成测试 `host-integration.test.ts`。
此功能使用 Pi 的 `type: image` 模型与 codemode 图片 API，不是聊天模型、MCP 服务或图片编辑功能。

## 支持范围

- Pi `VERSION` 为 1.2.0 或更高稳定版本时才注册 `gpt-image-2.5-flare` 与 `gpt-image-2.5-sunburst`，类型为 `image`。低于 1.2 时不注册图片模型或 adapter，原有聊天功能保持不变；不提升 provider 最低 peer 版本。此兼容策略不是对真实旧版 Pi 的验收声明。
- 图片模型目录遵循静态目录 ∩ 网关目录，再应用 `includeModels` / `excludeModels`。include 优先于 exclude，但不能突破交集。不会自动登记 `gpt-image-2.5` 裸别名或其他图片模型；用户可用 `gpt-image-2.5*` 前缀规则纳入已在交集中的模型。
- 仅文生图：每次请求生成单张 PNG，不支持编辑或输入图片。图片模型不作为聊天模型提供，也不会被搜索代理选作聊天模型。provider 状态计数统计实际登记的聊天与图片条目。

## 凭据、API 与调用

图片能力沿用 provider 现有 `baseUrl` 和 TSGW 凭据（Pi 已存凭据或 `$TSGW_API_KEY`），宿主负责解析 `options.apiKey`。图片 API 适配仅以最小请求实现 `POST /v1/images/generations`；不新增 HTTP 客户端 SDK 或 MCP 依赖，不改动 `ts_oht` 服务端。请求默认 `quality` 与 `size` 为 `auto`，输出单张 PNG。

在宿主已启用 codemode 的前提下，调用方式为：

```ts
const available = await models.getAvailableOfType("image", "tsgw");
const model = available.find(model => model.id === "gpt-image-2.5-flare");
if (!model) throw new Error("图片模型未登记或 TSGW 凭据不可用");
const result = await models.generateImages(model, {
  input: [{ type: "text", text: "横版水墨山水，远山薄雾，一叶扁舟，不要文字" }],
});
if (result.stopReason !== "stop") throw new Error(result.errorMessage);
const pictures = result.output.filter(block => block.type === "image");
if (pictures.length === 0) throw new Error("没有返回图片，不视为生成成功");
for (const block of pictures) image(block);
```

也可通过 `await models.getModelsOfType("image", "tsgw")` 查看已登记目录，或 `await models.getAvailableOfType("image", "tsgw")` 查询具有可用凭据的图片模型；`generateImages` 的原生调用仅有 `model` 和请求对象两个参数，不提供 `size` / `quality` 选项参数。宿主未启用 codemode 时，本扩展不会自动启用工具；仅在确有需要且 `defaultTools` 未含该工具时，手动为宿主启用 `+codemode`。本说明不要求改写用户配置。

检查返回的 `stopReason` 和 image 内容后，使用 codemode 的 `image(block)` 展示图片并取得生成的临时路径。API 实现默认超时 300 秒，可响应 `signal`，并接受更短的 `options.timeoutMs`。不自动重试，也不自动切换模型。取消请求不保证上游停止处理或停止计费。

响应 JSON 限制 32 MiB，PNG 限制单边 3840、总像素 8294400；校验容器与块 CRC，不声称完成像素解码。
usage 仅包括上游已报告且有效的 tokens；完整 JSON 已返回但图片校验失败时，也保留这些用量。图片价格显示为 0 表示尚未映射准确价格，不表示免费。实现、模拟响应或宿主集成测试均不等于真实网关生成验收；真实上游能力需要另行授权验证。

型号与能力在 `extensions/models/vendors/openai.ts` 维护，接口依据见记忆系统 942；
`models.ts` 汇出图片入口并判断宿主基线，`adapter.ts` / `response.ts` 负责图片请求及结果校验。
