```json
[
  {
    "id": "kimi-k2.7-code",
    "name": "Kimi K2.7 Code",
    "contextWindow": 262144,
    "maxTokens": null,
    "input": ["text", "image"],
    "cost": {
      "input": 0.95,
      "output": 4.0,
      "cacheRead": 0.19,
      "cacheWrite": null
    },
    "source": "https://platform.kimi.ai/docs/pricing/chat-k27-code.md"
  },
  {
    "id": "kimi-k2.7-code-highspeed",
    "name": "Kimi K2.7 Code HighSpeed",
    "contextWindow": 262144,
    "maxTokens": null,
    "input": ["text", "image"],
    "cost": {
      "input": 1.9,
      "output": 8.0,
      "cacheRead": 0.38,
      "cacheWrite": null
    },
    "source": "https://platform.kimi.ai/docs/pricing/chat-k27-code.md"
  },
  {
    "id": "kimi-k2.6",
    "name": "Kimi K2.6",
    "contextWindow": 262144,
    "maxTokens": null,
    "input": ["text", "image"],
    "cost": {
      "input": 0.95,
      "output": 4.0,
      "cacheRead": 0.16,
      "cacheWrite": null
    },
    "source": "https://platform.kimi.ai/docs/pricing/chat-k26.md"
  },
  {
    "id": "kimi-k2.5",
    "name": "Kimi K2.5",
    "contextWindow": 262144,
    "maxTokens": null,
    "input": ["text", "image"],
    "cost": {
      "input": 0.6,
      "output": 3.0,
      "cacheRead": 0.1,
      "cacheWrite": null
    },
    "source": "https://platform.kimi.ai/docs/pricing/chat-k25.md"
  },
  {
    "id": "kimi-for-coding-highspeed",
    "name": null,
    "contextWindow": null,
    "maxTokens": null,
    "input": null,
    "cost": {
      "input": null,
      "output": null,
      "cacheRead": null,
      "cacheWrite": null
    },
    "source": null
  }
]
```

说明：

- 官方国际站定价页以 USD/1M tokens 明确公开了 `kimi-k2.7-code`、`kimi-k2.7-code-highspeed`、`kimi-k2.6`、`kimi-k2.5` 的缓存命中输入价、缓存未命中输入价和输出价；上方分别映射为 `cacheRead`、`input`、`output`。
- 官方文档说明这些模型支持文本、图片和视频输入；因任务的目标字段仅要求 `text/image`，数组仅列入 `text`、`image`。
- 官方页面仅说明 `max_tokens`/`max_completion_tokens` 是生成上限参数，并提到 K2.7 Code、K2.6 的默认值为 32K；未确认这些模型的“最大可输出 token 数”，故所有 `maxTokens` 均为 `null`，没有把默认值臆作硬上限。
- 自动 Context Caching 文档未公开独立的缓存写入计费，因此 `cacheWrite` 均为 `null`。
- 当前官方模型列表、文档索引及定价页均未发现 `kimi-for-coding-highspeed` 这一 API 模型 ID，因此其字段均无法从官方确认，标为 `null`。
- `kimi-k2.5` 官方文档注明已停止向新注册用户开放，并计划全平台下线；价格仍可在官方独立定价页查到。

## Sources

- Kept: [Kimi K2.7 Code Pricing](https://platform.kimi.ai/docs/pricing/chat-k27-code.md) — 官方 USD 定价、262,144 上下文、模态及高速版关系。
- Kept: [Kimi K2.6 Pricing](https://platform.kimi.ai/docs/pricing/chat-k26.md) — 官方 USD 定价、262,144 上下文和模态。
- Kept: [Kimi K2.5 Pricing](https://platform.kimi.ai/docs/pricing/chat-k25.md) — 官方 USD 定价、262,144 上下文和模态。
- Kept: [Model List](https://platform.kimi.ai/docs/models.md) — 核验当前正式模型 ID、名称和 K2.5 可用性状态。
- Kept: [Model Parameter Reference](https://platform.kimi.ai/docs/api/models-overview.md) — 核验 K2.7 高速版与标准版参数相同、各模型 256K 上下文。
- Kept: [Context Caching](https://platform.kimi.com/docs/guide/use-context-caching-feature-of-kimi-api.md) — 核验缓存自动启用，未列独立写入价格。
- Dropped: 搜索结果中的非官方聚合页与博客 — 不满足“官方来源”要求。

## Gaps / residual risks

- `maxTokens` 的硬上限没有在所查官方 K2.x 文档中明确公布。
- `kimi-for-coding-highspeed` 可能是网关别名、Coding 产品内部别名或历史名称，但不能据此映射到某个官方 API 模型。
- 官方页面内容和价格可能随下线计划更新，集成前宜再次核验上述 URL。