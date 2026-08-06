# Research: OpenAI GPT 官方定价与模型规格

```json
[
  {
    "id": "gpt-5.6",
    "name": "GPT-5.6 Sol",
    "contextWindow": 1050000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 6.25},
    "source": "https://developers.openai.com/api/docs/models/gpt-5.6"
  },
  {
    "id": "gpt-5.4",
    "name": "GPT-5.4",
    "contextWindow": 1050000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 2.5, "output": 15, "cacheRead": 0.25, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models/gpt-5.4"
  },
  {
    "id": "gpt-5.4-mini",
    "name": "GPT-5.4 mini",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 0.75, "output": 4.5, "cacheRead": 0.075, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models/gpt-5.4-mini"
  },
  {
    "id": "gpt-5.3",
    "name": null,
    "contextWindow": null,
    "maxTokens": null,
    "input": null,
    "cost": {"input": null, "output": null, "cacheRead": null, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models"
  },
  {
    "id": "gpt-5.3-flash",
    "name": null,
    "contextWindow": null,
    "maxTokens": null,
    "input": null,
    "cost": {"input": null, "output": null, "cacheRead": null, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models"
  },
  {
    "id": "gpt-5.2",
    "name": "GPT-5.2",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 1.75, "output": 14, "cacheRead": 0.175, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models/gpt-5.2"
  },
  {
    "id": "gpt-5.2-pro",
    "name": "GPT-5.2 Pro",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 21, "output": 168, "cacheRead": null, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models/gpt-5.2-pro"
  },
  {
    "id": "gpt-5.2-flash",
    "name": null,
    "contextWindow": null,
    "maxTokens": null,
    "input": null,
    "cost": {"input": null, "output": null, "cacheRead": null, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models"
  },
  {
    "id": "gpt-5.1",
    "name": "GPT-5.1",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 1.25, "output": 10, "cacheRead": 0.125, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models/gpt-5.1"
  },
  {
    "id": "gpt-5",
    "name": "GPT-5",
    "contextWindow": 400000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {"input": 1.25, "output": 10, "cacheRead": 0.125, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models/gpt-5"
  },
  {
    "id": "gpt-codex",
    "name": null,
    "contextWindow": null,
    "maxTokens": null,
    "input": null,
    "cost": {"input": null, "output": null, "cacheRead": null, "cacheWrite": null},
    "source": "https://developers.openai.com/api/docs/models"
  }
]
```

## 说明

- 官方模型目录及逐模型页面未确认 `gpt-5.3`、`gpt-5.3-flash`、`gpt-5.2-flash`、`gpt-codex` 这四个精确模型 ID；对应字段均为 `null`，没有将相近模型擅自映射过去。
- 官方存在独立模型 **GPT-5.3-Codex**（`gpt-5.3-codex`，400,000 context、128,000 max output、text/image input、$1.75 input、$0.175 cached input、$14 output），但它不是请求中的 `gpt-5.3` 或 `gpt-codex`，因此未用于替代。
- `cacheWrite`：官方明确为 GPT-5.6 提供单独的 cache-write 价格（标准 input 的 1.25 倍，即 $6.25/百万 token）。其余已确认模型的官方页面未列出独立 cache-write 价格，故填 `null`，而不是填 0。
- `gpt-5.2-pro` 官方页面仅公开 input/output 价格，未列 cached-input 或 cache-write 价格，因此对应字段为 `null`。
- 金额单位均为 USD/百万 token，采用标准实时 API token 价格；未混入 Batch API 或长上下文加价档。

## Sources

- Kept: [GPT-5.6 Sol Model](https://developers.openai.com/api/docs/models/gpt-5.6) — 官方规格、模态与四类 token 价格。
- Kept: [GPT-5.4 Model](https://developers.openai.com/api/docs/models/gpt-5.4) — 官方规格、模态与价格。
- Kept: [GPT-5.4 mini Model](https://developers.openai.com/api/docs/models/gpt-5.4-mini) — 官方规格、模态与价格。
- Kept: [GPT-5.2 Model](https://developers.openai.com/api/docs/models/gpt-5.2) — 官方规格、模态与价格。
- Kept: [GPT-5.2 Pro Model](https://developers.openai.com/api/docs/models/gpt-5.2-pro) — 官方规格、模态与 input/output 价格。
- Kept: [GPT-5.1 Model](https://developers.openai.com/api/docs/models/gpt-5.1) — 官方规格、模态与价格。
- Kept: [GPT-5 Model](https://developers.openai.com/api/docs/models/gpt-5) — 官方规格、模态与价格。
- Kept: [GPT-5.3-Codex Model](https://developers.openai.com/api/docs/models/gpt-5.3-codex) — 用于确认存在的是精确 ID `gpt-5.3-codex`，不能替代所请求 ID。
- Dropped: OpenAI Developer Community 帖子 — 非官方模型规格/定价主来源，仅用于发现线索，未作为最终数值依据。
- Dropped: 第三方模型目录与网关目录 — 可能包含自定义别名，不能证明 OpenAI 官方模型 ID 或定价。

## Gaps / residual risks

- OpenAI 文档会动态更新；本结果反映本次核验时官方页面内容。
- `gpt-5.6` 官方别名当前指向 GPT-5.6 Sol；如果网关自行把该 ID 映射到其他 5.6 变体，规格与价格可能不同。
- 未知 ID 可能是 TOSSP AIH 网关自定义别名；若要确定其真实后端模型，需要查询网关模型映射，不能从 OpenAI 官方文档推断。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "review-findings: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/a41c0a4a/research.md contains the requested 11-model JSON array with official URLs and nulls for unconfirmed fields; residual-risks are explicitly listed in the Gaps / residual risks section."
    }
  ],
  "changedFiles": [
    "/root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/a41c0a4a/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Official OpenAI documentation web searches and page fetches",
      "result": "passed",
      "summary": "Verified seven exact model pages; four requested exact IDs were absent/unconfirmed and were left null."
    }
  ],
  "validationOutput": [
    "Confirmed official pages for gpt-5.6, gpt-5.4, gpt-5.4-mini, gpt-5.2, gpt-5.2-pro, gpt-5.1, and gpt-5.",
    "Confirmed gpt-5.3-codex exists separately; did not conflate it with gpt-5.3 or gpt-codex.",
    "JSON contains all 11 requested IDs and all requested fields."
  ],
  "residualRisks": [
    "Four IDs may be gateway-specific aliases whose upstream mappings cannot be established from OpenAI official documentation.",
    "OpenAI pricing and aliases may change after the verification date."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added a research artifact containing official model specifications/pricing, explicit nulls for unconfirmed IDs/fields, sources, and residual risks.",
  "reviewFindings": [
    "no blockers",
    "info: research.md - gpt-5.3, gpt-5.3-flash, gpt-5.2-flash, and gpt-codex are not confirmed exact OpenAI API model IDs.",
    "info: research.md - GPT-5.2 Pro has no officially listed cached-input or cache-write price on its model page."
  ],
  "manualNotes": "No model-ID substitutions were made; unconfirmed values remain null as required."
}
```
