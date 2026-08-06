```json
[
  {
    "id": "claude-opus-4",
    "name": "Claude Opus 4",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "input": ["text", "image"],
    "cost": {
      "input": 15,
      "output": 75,
      "cacheRead": 1.5,
      "cacheWrite": 18.75
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-opus-4.1",
    "name": "Claude Opus 4.1",
    "contextWindow": 200000,
    "maxTokens": 32000,
    "input": ["text", "image"],
    "cost": {
      "input": 15,
      "output": 75,
      "cacheRead": 1.5,
      "cacheWrite": 18.75
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-opus-4.5",
    "name": "Claude Opus 4.5",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": ["text", "image"],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-opus-4.6",
    "name": "Claude Opus 4.6",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-opus-4.7",
    "name": "Claude Opus 4.7",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {
      "input": 5,
      "output": 25,
      "cacheRead": 0.5,
      "cacheWrite": 6.25
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-sonnet-4",
    "name": "Claude Sonnet 4",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": ["text", "image"],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-sonnet-4.5",
    "name": "Claude Sonnet 4.5",
    "contextWindow": 200000,
    "maxTokens": 64000,
    "input": ["text", "image"],
    "cost": {
      "input": 3,
      "output": 15,
      "cacheRead": 0.3,
      "cacheWrite": 3.75
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  },
  {
    "id": "claude-sonnet-5",
    "name": "Claude Sonnet 5",
    "contextWindow": 1000000,
    "maxTokens": 128000,
    "input": ["text", "image"],
    "cost": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5
    },
    "source": "https://platform.claude.com/docs/en/about-claude/models/overview"
  }
]
```

说明：上述价格均为 Claude Platform 标准实时 API、USD/百万 token；`cacheWrite` 采用官方价格页所示的 **5 分钟 TTL**（基础 input 的 1.25 倍），`cacheRead` 为基础 input 的 10%。定价来源为 <https://platform.claude.com/docs/en/about-claude/pricing> （当前页面也由 <https://claude.com/pricing> 的 API 区域公开展示）。Claude Sonnet 5 的 `$2/$10` 是截至 2026-08-31 的官方 introductory pricing；其后标准价为 `$3/$15`，相应 5 分钟 cache read/write 为 `$0.30/$3.75`。Claude Sonnet 4 曾官方提供 1M long-context beta，但常规模型规格为 200K；超过 200K 的 beta 请求曾采用 `$6/$22.50` 长上下文价，因此这里按可直接映射到单一价格对象的 200K 标准规格记录。未发现需要置为 `null` 的字段。

核验辅助官方来源：

- Claude 4 发布与 Opus 4/Sonnet 4 定价：<https://www.anthropic.com/news/claude-4>
- Opus 4.1（定价同 Opus 4）：<https://www.anthropic.com/news/claude-opus-4-1>
- Opus 4.5：<https://www.anthropic.com/news/claude-opus-4-5>
- Opus 4.6 与 Sonnet 4.6 的 1M GA：<https://claude.com/blog/1m-context-ga>
- Opus 4.7：<https://www.anthropic.com/news/claude-opus-4-7>
- Sonnet 4.5：<https://www.anthropic.com/news/claude-sonnet-4-5>
- Sonnet 5：<https://www.anthropic.com/news/claude-sonnet-5>
- 输出上限官方文档：<https://platform.claude.com/docs/en/build-with-claude/thinking>

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "review-findings: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/33f32f98/research.md contains the requested eight-model JSON array with official-source URLs and qualification notes; residual-risks are explicitly recorded below."
    }
  ],
  "changedFiles": [
    "/root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/33f32f98/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Focused web research and direct fetches of Anthropic/Claude official model, pricing, launch, context-window, and thinking-limit pages",
      "result": "passed",
      "summary": "Cross-checked names, modalities, context/output limits, base token prices, and 5-minute prompt-cache multipliers."
    }
  ],
  "validationOutput": [
    "Eight requested IDs are present exactly once.",
    "All cost figures are USD per million tokens and cacheWrite uses the official 5-minute TTL rate.",
    "Sonnet 5 introductory-price expiry and Sonnet 4 long-context pricing qualification are documented."
  ],
  "residualRisks": [
    "Anthropic's live documentation is time-sensitive; Sonnet 5 pricing changes after 2026-08-31.",
    "Sonnet 4 had an optional 1M beta tier with different prices; the scalar JSON records its standard 200K tier because the requested schema cannot represent tiered context pricing."
  ],
  "noStagedFiles": true,
  "diffSummary": "Added the requested official Claude model-specification and pricing research artifact only.",
  "reviewFindings": [
    "no blockers",
    "info: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/33f32f98/research.md - Sonnet 5 uses temporary introductory pricing through 2026-08-31.",
    "info: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/33f32f98/research.md - Sonnet 4 standard 200K tier is used; its separate 1M beta tier is explained outside the scalar JSON."
  ],
  "manualNotes": "The source field remains a single URL as requested; additional official pricing and launch URLs are listed immediately after the JSON."
}
```
