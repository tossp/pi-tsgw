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

生成和编辑统一通过 `codemode` 工具执行脚本，调用 `tools.tsgw_generate_image()` 或 `tools.tsgw_edit_image()`，不要直接发起图片工具调用。检查状态和返回文件后，**按用户意图处理图片，不强制预览或展示**。`codemode` 工具不可用时说明调用条件不足，不改用直接调用或擅自修改配置。

已实测的路径是通过 `codemode` 工具生成后读图并展示；该验证未覆盖编辑或直接调用。这里规定的是技能调用方式，不代表直接调用必然失败，也不代表此前未发出调用的底层原因已修复。

- 读取技能或说“现在生成”不算执行。收到生成任务后，应实际调用工具并检查结果；没有工具结果，不得声称已生成。
- 图片工具有 `outputSchema`，`codemode` 工具内嵌调用返回结构化状态和文件列表。保存、发送或继续编辑可以直接使用返回文件，无需先 `read` 或 `image()`；需要在对话中展示时，才读取文件并显式执行 `image(block)`。`text(result)` 仅报告状态和路径，不等于展示、发送或最终存储已完成；不要打印图片 base64。
- 工具本身直接调用时会返回图片块，但本技能使用 `codemode` 工具的结构化返回与文件处理流程；不要把内嵌调用等同于已向对话输出图片。

完整生成示例（一次请求，默认 Sunburst）：将下方 JavaScript 作为 `code` 参数传给 `codemode` 工具。默认只返回文件；**任务需要在对话中展示时，将 `display` 改为 `true`**。若已有生成结果，只处理已有文件，不要重新运行生图调用。

```js
// @options: {"timeout_ms": 660000, "max_output_tokens": 2000}
const display = false; // 按用户意图设置；仅需要在对话中展示时改为 true。
let result;
try {
  result = await tools.tsgw_generate_image({
    prompt: "横版中国水墨山水画，远山、薄雾、一叶扁舟，不要文字、题款、印章或水印。",
    size: "1536x1024"
  });
} catch {
  text({ error: "图片调用未正常返回；请检查已有工具结果。上游是否已处理或计费可能未知，不自动重试或换模型。" });
  return;
}
text(result);

if (result?.requestStatus !== "succeeded" || result.phase !== "complete") {
  text({ error: result?.requestStatus === "succeeded"
    ? "上游已成功，但结果处理或保存未完成；不要重新生成。"
    : "未确认生成完成；按工具结果说明状态，不自动重试。" });
  return;
}
if (!Array.isArray(result.files) || result.files.length === 0) {
  text({ error: "工具报告完成但没有返回文件，无法继续交付；不要重新生成。" });
  return;
}

if (!display) return; // 返回文件可用于保存、发送或继续编辑，不必读图预览。
let displayed = 0;
for (const file of result.files) {
  try {
    const block = await tools.read({ path: file.path });
    if (block && typeof block === "object" && block.type === "image") {
      image(block);
      displayed++;
    } else {
      text({ error: "文件已生成，但未能读取为图片", path: file.path });
    }
  } catch {
    text({ error: "文件已生成，但读取或展示失败；保留此路径，不要重新生成", path: file.path });
  }
}
text({ generated: true, imagesEmitted: displayed, fileCount: result.files.length });
```

### 按意图处理返回文件

| 用户意图 | 后续操作 |
| --- | --- |
| 展示图片 | 对返回文件执行 `tools.read()`，再 `image(block)`；`imagesEmitted` 只统计已输出的图片块 |
| 保存图片 | 使用原始文件保存到用户要求的位置；工具返回的是临时路径，不等于已完成指定位置的持久保存 |
| 发送或上传 | 将文件交给相应的可用工具，在已有授权范围内执行；依据发送或上传结果确认完成 |
| 继续编辑 | 将原始文件路径用于下一次 `images[].path`，不必先读取预览 |

后续读取、展示、保存或发送失败，与图片生成失败分开报告；保留已生成文件，只处理失败的后续步骤，不重新生图。

## `codemode` 工具内的参数示例

以下是传给 `codemode` 工具脚本中相应 `tools.*` 调用的参数，不是直接工具调用指令，也不要逐个执行。

`tools.tsgw_generate_image()` 的最简参数：

```json
{
  "prompt": "横版水墨山水，远山薄雾，一叶扁舟，不要文字"
}
```

快速草稿：

```json
{
  "prompt": "极简咖啡馆标志草稿，咖啡杯与山峰结合，无文字",
  "model": "gpt-image-2.5-flare",
  "quality": "low",
  "size": "1024x1024"
}
```

在传给 `codemode` 工具的上述脚本中，将生成调用替换为 `tools.tsgw_edit_image()` 并传入以下参数即可编辑本地图片；蒙版对应第一张原图。沿用状态检查，再按用户意图处理返回文件；仅需展示时使用读图和 `image(block)` 步骤。**这是编辑契约示例，本次通过 `codemode` 工具的实测未覆盖编辑。**

```json
{
  "prompt": "把蒙版标出的区域改为盛开的荷花，保留原图其余构图和水墨风格",
  "images": [{ "path": "source.png" }],
  "mask": { "path": "mask.png" }
}
```

`images` 保留参考图顺序，支持 1–16 张；每个来源选择 `path`、`image_url`、`file_id` 其中之一。`path` 是 Pi 运行主机上的文件路径，相对路径以会话工作目录为准；`image_url` 接受 HTTP(S) URL 或图片 data URI，`file_id` 使用上游已有文件 ID。蒙版可省略；提供时，与第一张原图保持格式及尺寸一致，并带透明通道，用透明区域指示编辑范围。

## 可选参数

生成和编辑共用下列可选参数，省略时使用默认值；只填写任务需要覆盖的项。

| 参数 | 默认值 | 用途与取值 |
| --- | --- | --- |
| `model` | `gpt-image-2.5-sunburst` | 草稿用 Flare，正式成图用 Sunburst |
| `quality` | `auto` | `low`、`medium`、`high`、`xhigh`、`max`、`auto`；`xhigh`/`max` 用于确实需要额外细节的任务 |
| `size` | `auto` | `宽x高`；例如 `1024x1024`、`1536x1024`、`1024x1536`、`2048x1152`、`3840x2160` |
| `background` | `auto` | `auto`、`opaque`、`transparent`；透明输出搭配 PNG 或 WebP |
| `output_format` | `png` | `png`、`jpeg`、`webp` |
| `output_compression` | JPEG/WebP 使用 `100` | `0–100` 整数，用于 JPEG/WebP |
| `n` | `1` | 一次请求生成 `1–10` 张图片 |
| `moderation` | `auto` | `auto` 或 `low` |
| `stream` | `false` | 是否使用上游流式响应；工具处理完成后返回最终图片 |
| `partial_images` | `0` | 流式请求中希望收到的过程图数量，`0–3` |
| `safety_identifier` | 省略 | 应用需要时提供稳定的匿名用户标识，最多 128 字符 |
| `user` | 省略 | 上游旧用户标识字段；新接入使用 `safety_identifier` |
| `timeout_ms` | `600000` | 单次调用等待时间，单位毫秒；可按任务覆盖。通过 `codemode` 工具调用时，脚本截止应留余量，例如默认请求配 `660000` |

自定义尺寸：宽高都是 16 的倍数，单边至多 3840，长短边比例至多 3，总像素为 655360–8294400；超过 3686400 像素属于上游实验范围。

## 超时、安全与结果

- 生成可能耗时数分钟。工具请求默认 `600000ms`；`codemode` 工具的示例脚本用 `660000ms` 为调用、读图和输出留余量。延长请求的 `timeout_ms` 时，脚本截止也要相应留余量；脚本超时可能无法进入示例的 catch，仍应核对已有结果而不是再次生图。
- 请求失败、取消或超时不代表上游未处理或未计费；不自动重试或换模型。费用显示为 0 表示尚未映射准确价格，不表示免费。
- `requestStatus: succeeded`、`phase: complete` 和返回文件是生成完成的依据。生成成功不代表展示、发送或指定位置的保存也成功；只有任务要求的后续操作实际完成，才能作相应声明。没有展示要求时，不把未展示视为失败。
- 实际格式及尺寸以工具返回的 `files[].mimeType/width/height` 为准，不把请求的 `size` 直接当作最终尺寸。`read` 预览可能缩放或转码；继续编辑时使用原始文件的 `images[].path`，不要把预览当作原图。
- 本地/内联图片每个小于 50 MB，参考图与蒙版合计不超过 100 MB。原文件读取和外传由图片工具及宿主权限控制，不等于内置 `read` 的审批或沙箱；不绕过宿主对读图或工具的限制。
- 若结果带 `usage_note`，按其说明报告计量状态；多图流式的逐事件用量可能无法确定汇总值。
