---
name: tsgw-image-generation
description: 当用户要求生成图片、生图或画图，以及修改图片、参考图创作或蒙版编辑时使用。使用 tsgw_generate_image 或 tsgw_edit_image，根据草稿或成稿选择模型与参数，并展示图片结果。
license: MIT
compatibility: 需要 Pi 1.2+、pi-tsgw 图片工具及可用的 tsgw 图片模型。
---

# 图片生成与编辑

## 选择工具和模型

- 从文字创建图片：调用 `tsgw_generate_image`，填写 `prompt`。
- 根据一张或多张图片修改、参考创作：调用 `tsgw_edit_image`，填写 `prompt` 和 `images`；局部修改可增加 `mask`。
- **草稿、构图探索、速度优先**：选择 `gpt-image-2.5-flare`，质量可用 `low`。
- **正式成图、精细修改、质量优先**：选择 `gpt-image-2.5-sunburst`，这是工具的默认模型；质量按需求从 `auto` 或 `high` 起选。

按用户任务选择模型和参数。`prompt` 写清主体、构图、风格、尺寸意图，以及需要呈现或保留的文字与细节；编辑时区分“修改什么”和“保留什么”。

## 最简调用

调用 `tsgw_generate_image`：

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

调用 `tsgw_edit_image` 修改本地图片，蒙版对应第一张原图：

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
| `timeout_ms` | `600000` | 单次调用等待时间，单位毫秒；可按任务覆盖。通过 codemode 包装调用时，脚本截止应留余量，例如默认请求配 `660000` |

自定义尺寸：宽高都是 16 的倍数，单边至多 3840，长短边比例至多 3，总像素为 655360–8294400；超过 3686400 像素属于上游实验范围。

## 使用结果

工具返回图片及原始文件的临时路径。根据返回结果展示或交付图片；继续编辑时，可以将该原始文件路径放入下一次 `images[].path`。若结果带 `usage_note`，按其说明报告计量状态；多图流式的逐事件用量可能无法确定汇总值。
