# Research: MiniMax M2.7 / M2.5 / M2.1 官方规格与定价

## Summary

MiniMax 国际站官方文档确认：三款模型上下文窗口均为 204,800 tokens，且 M2.x 系列只支持文本输入（不支持图片或视频输入）。国际站按量定价页与 Anthropic 主动缓存页给出了 USD 定价；但官方公开文档未明确给出三款模型各自的最大输出 token 上限，因此 `maxTokens` 按要求填 `null`。

```json
[
  {
    "id": "minimax-m2.7",
    "name": "MiniMax-M2.7",
    "contextWindow": 204800,
    "maxTokens": null,
    "input": ["text"],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.06,
      "cacheWrite": 0.375
    },
    "source": "https://platform.minimax.io/docs/guides/pricing-paygo"
  },
  {
    "id": "minimax-m2.5",
    "name": "MiniMax-M2.5",
    "contextWindow": 204800,
    "maxTokens": null,
    "input": ["text"],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.03,
      "cacheWrite": 0.375
    },
    "source": "https://platform.minimax.io/docs/guides/pricing-paygo"
  },
  {
    "id": "minimax-m2.1",
    "name": "MiniMax-M2.1",
    "contextWindow": 204800,
    "maxTokens": null,
    "input": ["text"],
    "cost": {
      "input": 0.3,
      "output": 1.2,
      "cacheRead": 0.03,
      "cacheWrite": 0.375
    },
    "source": "https://platform.minimax.io/docs/guides/pricing-paygo"
  }
]
```

## Findings

1. **上下文窗口** — MiniMax 官方 OpenAI SDK 与 Anthropic SDK 文档均列出 MiniMax-M2.7、MiniMax-M2.5、MiniMax-M2.1 的 Context Window 为 `204,800`。[OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api) [Anthropic SDK](https://platform.minimax.io/docs/api-reference/text-anthropic-api)
2. **输入模态** — 官方 Anthropic SDK 文档明确说明 M2.7、M2.5、M2.1、M2 系列仅支持 text 与 tool-call content blocks，不支持 image 或 video input；按本任务的模态枚举记为 `["text"]`。[Anthropic SDK](https://platform.minimax.io/docs/api-reference/text-anthropic-api)
3. **USD 标准定价** — 三款标准模型输入均为 `$0.3/M tokens`、输出均为 `$1.2/M tokens`；M2.7 缓存读取为 `$0.06/M`，M2.5/M2.1 为 `$0.03/M`，三者主动缓存写入均为 `$0.375/M`。[按量计费](https://platform.minimax.io/docs/guides/pricing-paygo) [主动缓存](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache)
4. **最大输出未公开确认** — 官方 API 文档说明 `max_tokens` 表示最大生成 token 数，但在已核验页面中没有给出 M2.7、M2.5、M2.1 的允许上限，因此不能把上下文窗口或第三方目录值当作 `maxTokens`。[Text Generation API](https://platform.minimax.io/docs/api-reference/text-post)

## Sources

- Kept: [API Pricing](https://platform.minimax.io/docs/guides/pricing-paygo) — 官方国际站 USD 输入、输出、缓存读取和缓存写入价格。
- Kept: [Anthropic SDK](https://platform.minimax.io/docs/api-reference/text-anthropic-api) — 官方模型名称、204,800 上下文窗口及 M2.x 文本输入限制。
- Kept: [OpenAI SDK](https://platform.minimax.io/docs/api-reference/text-openai-api) — 独立交叉确认模型名称与 204,800 上下文窗口。
- Kept: [Explicit Prompt Caching](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache) — 独立交叉确认四项 USD token 定价。
- Dropped: MiniMax 新闻稿 — 未提供所需的完整 API 规格和四项定价。
- Dropped: 搜索结果中的第三方模型目录 — 非官方来源，且可能把上下文窗口误作最大输出上限。

## Gaps

`maxTokens` 未能从 MiniMax 官方公开文档确认，故三款模型均填 `null`。另外，`cacheWrite` 是官方 Anthropic 主动缓存的写入价格；官方被动 Prompt Caching 不额外收取写入费，但任务字段要求单一 `cacheWrite` 数值，因此采用官方定价表中明确列出的主动缓存写入价。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "review-findings: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/5d844067/research.md contains concrete per-model JSON findings, official source URLs, and an explicit residual-risk/gaps section."
    }
  ],
  "changedFiles": [
    "/root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/5d844067/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "fetch official MiniMax international pricing and API documentation",
      "result": "passed",
      "summary": "Verified USD pricing, context windows, model names, and supported input modality from platform.minimax.io."
    }
  ],
  "validationOutput": [
    "All three models have official contextWindow=204800 and text-only M2.x input support.",
    "Official standard USD/M token costs: input 0.3, output 1.2; cacheRead 0.06 for M2.7 and 0.03 for M2.5/M2.1; cacheWrite 0.375 for all three.",
    "No official per-model maximum output-token ceiling was found; maxTokens remains null."
  ],
  "residualRisks": [
    "MiniMax may document a maximum output-token ceiling elsewhere or update its live documentation after this verification.",
    "cacheWrite refers to Anthropic explicit prompt caching; passive prompt caching has no additional cache-write charge."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a sourced research artifact containing the requested JSON model data and uncertainty notes; no project source code was modified.",
  "reviewFindings": [
    "no blockers",
    "info: research.md - maxTokens is intentionally null because no official upper bound was found.",
    "info: research.md - cacheWrite is the explicit Anthropic-compatible cache-write price, not passive caching."
  ],
  "manualNotes": "Pricing is standard pay-as-you-go, excluding highspeed and priority service tiers."
}
```
