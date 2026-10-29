---
name: tsgw-image-generation
description: 生成、绘制或编辑图片时使用，包括参考图创作与蒙版编辑。
license: MIT
compatibility: 需要 Pi 1.2+、`codemode` 工具、pi-tsgw 图片工具及可用的 tsgw 图片模型。
---

# 图片生成与编辑

## 选择工具和模型

- 从文字创建图片：在 `codemode` 工具的脚本中调用 `tools.tsgw_generate_image()`，填写 `prompt`。
- 根据一张或多张图片修改、参考创作：在 `codemode` 工具的脚本中调用 `tools.tsgw_edit_image()`，填写 `prompt` 和 `images`；局部修改可增加 `mask`。
- **草稿、构图探索、速度优先**：选择 `gpt-image-2.5-flare`，质量可用 `low`。
- **正式成图、精细修改、质量优先**：选择 `gpt-image-2.5-sunburst`，这是工具的默认模型；质量按需求从 `auto` 或 `high` 起选。

按用户任务选择模型和参数。`prompt` 写清主体、构图、风格、尺寸意图，以及需要呈现或保留的文字与细节；编辑时区分“修改什么”和“保留什么”。

## 通过 `codemode` 工具调用

生成和编辑都通过 `codemode` 工具脚本调用 `tools.tsgw_generate_image()` 或 `tools.tsgw_edit_image()`；不要直接调用图片工具。检查调用状态与返回文件，按用户意图保存、发送、继续编辑或展示，不强制预览。保存、发送或编辑直接使用返回文件；仅需在对话中展示时，才用 `tools.read()` 读取并调用 `image(block)`。`text(result)` 只报告状态和路径，不代表后续交付已完成；不要打印图片 base64。工具不可用时说明条件不足，不改用其他调用方式或擅自修改配置。

收到生成任务后实际调用并检查结果；没有工具结果不得声称已生成。生成完成以 `requestStatus: succeeded`、`phase: complete` 和返回文件为依据；展示、保存或发送等后续步骤分别核实，失败时保留已有文件，只处理失败步骤，不重新生图。读取、保存与外传受图片工具及宿主权限控制，不绕过限制。

生成示例（默认参数）：

```js
// @options: {"timeout_ms": 660000, "max_output_tokens": 2000}
const result = await tools.tsgw_generate_image({
  prompt: "横版水墨山水，远山薄雾，一叶扁舟，不要文字"
});
text(result);
// 核对状态与 files；再按用户意图处理返回文件。
```

### 按意图处理返回文件

| 用户意图 | 后续操作 |
| --- | --- |
| 展示图片 | 对返回文件执行 `tools.read()`，再 `image(block)` |
| 保存图片 | 将原始文件保存到用户要求的位置；临时路径不等于已持久保存到指定位置 |
| 发送或上传 | 在已有授权范围内交给相应工具，并依据结果确认完成 |
| 继续编辑 | 将原始文件路径用于下一次 `images[].path`，无需先读预览 |

## 编辑参考图

编辑时传入修改要求与 `images`；局部编辑可加 `mask`：

```js
// @options: {"timeout_ms": 660000, "max_output_tokens": 2000}
const result = await tools.tsgw_edit_image({
  prompt: "把蒙版区域改为盛开的荷花，保留原图其余构图和水墨风格",
  images: [{ path: "source.png" }],
  mask: { path: "mask.png" }
});
text(result);
```

`images` 保留参考图顺序，每个来源选择 `path`、`image_url`、`file_id` 其中之一。`path` 是 Pi 运行主机上的文件路径，相对路径以会话工作目录为准；`image_url` 接受 HTTP(S) URL 或图片 data URI，`file_id` 使用上游已有文件 ID。蒙版可省略；提供时，与第一张原图保持格式及尺寸一致，并带透明通道，用透明区域指示编辑范围。继续编辑应使用原始文件而非可能缩放或转码的预览。

## 参数选择与结果边界

只填写任务需要覆盖的参数。按画面需要选择 `size`、`background`、`output_format`、图片数量等；透明背景使用支持透明的 PNG 或 WebP。尺寸限制及所有默认值、上下限以图片工具字段说明为准。

- 生成耗时较长时，脚本截止时间应比请求的 `timeout_ms` 留有处理余量；超时或结果未知时先核对已有结果，不自动重试或换模型。
- 以工具返回的 `files[].mimeType/width/height` 判断实际格式和尺寸，不将请求的 `size` 当作最终结果。生成成功不代表展示、发送或指定位置保存也成功；只有任务要求的后续操作实际完成，才能相应声明。没有展示要求时，不把未展示视为失败。
- 若结果带 `usage_note`，按其说明报告计量状态；多图流式的逐事件用量可能无法确定汇总值。
