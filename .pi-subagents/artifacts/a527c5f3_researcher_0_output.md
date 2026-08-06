# Research: Google Gemini API 官方定价与模型规格

```json
[
  {
    "id": "gemini-3.5-flash",
    "name": "Gemini 3.5 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 1.5,
      "output": 9,
      "cacheRead": 0.15,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash"
  },
  {
    "id": "gemini-3.5-flash-low",
    "name": "Gemini 3.5 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 1.5,
      "output": 9,
      "cacheRead": 0.15,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash"
  },
  {
    "id": "gemini-3.5-flash-extra-low",
    "name": "Gemini 3.5 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 1.5,
      "output": 9,
      "cacheRead": 0.15,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash"
  },
  {
    "id": "gemini-3.1-pro-low",
    "name": "Gemini 3.1 Pro Preview",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview"
  },
  {
    "id": "gemini-2.5-pro",
    "name": "Gemini 2.5 Pro",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 1.25,
      "output": 10,
      "cacheRead": 0.125,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro"
  },
  {
    "id": "gemini-2.5-flash",
    "name": "Gemini 2.5 Flash",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 0.3,
      "output": 2.5,
      "cacheRead": 0.03,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash"
  },
  {
    "id": "gemini-2.5-flash-lite",
    "name": "Gemini 2.5 Flash-Lite",
    "contextWindow": 1048576,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 0.1,
      "output": 0.4,
      "cacheRead": 0.01,
      "cacheWrite": null
    },
    "source": "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite"
  }
]
```

说明：

- `gemini-3.5-flash-low`、`gemini-3.5-flash-extra-low` 和 `gemini-3.1-pro-low` 不是 Google 模型页公布的独立 model code；它们是项目/网关的思考档位别名，因此分别继承底层 `gemini-3.5-flash` 与 `gemini-3.1-pro-preview` 的规格和定价。
- 定价采用 Gemini Developer API **标准付费层**的 text/image 价格，单位均为 USD/百万 token；output 包含 thinking tokens。[官方定价页](https://ai.google.dev/gemini-api/docs/pricing)
- Gemini 3.1 Pro 与 Gemini 2.5 Pro 是分段定价。JSON 中填写的是 prompt `<= 200k` 的标准价。超过 200k 时：Gemini 3.1 Pro 为 input `$4`、output `$18`、cacheRead `$0.40`；Gemini 2.5 Pro 为 input `$2.50`、output `$15`、cacheRead `$0.25`。
- Google 官方没有公布一个可直接映射为“USD/百万 token 的 cache write 单价”的字段。官方另列显式缓存的**存储费**（Gemini 3.5 Flash、2.5 Flash、2.5 Flash-Lite：`$1.00/百万 token/小时`；3.1 Pro、2.5 Pro：`$4.50/百万 token/小时`），其单位包含时间，不能无损填入题目要求的 `cacheWrite`，故全部标为 `null`。
- 官方模型卡实际还支持 audio/video/PDF 输入；按任务要求的 `text/image` 模态字段，仅列出这两项。

## Sources

- Kept: [Gemini 3.5 Flash model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) — 官方名称、model code、输入类型与 token limits。
- Kept: [Gemini 3.1 Pro Preview model card](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview) — 官方名称、输入类型与 token limits。
- Kept: [Gemini 2.5 Pro model card](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro) — 官方规格。
- Kept: [Gemini 2.5 Flash model card](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash) — 官方规格。
- Kept: [Gemini 2.5 Flash-Lite model card](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite) — 官方规格。
- Kept: [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing) — 官方标准、Batch、缓存读取与存储定价。
- Dropped: Google AI Developers Forum discussions — 仅用于发现官方页面或交叉检查，用户帖子不是定价/规格权威来源。
- Dropped: 第三方定价聚合页 — 与官方页重复，不作为最终证据。

## Gaps

- `cacheWrite` 无法按指定的“USD/百万 token”单位从官方确认；Google 的对应费用是按百万 token **每小时**收取的 cache storage，已保留为说明而未强行转换。
- 三个带 `-low`/`-extra-low` 的 id 无独立 Google model card；其别名到底映射到哪个底层 model code，仍应由项目目录/网关配置验证。