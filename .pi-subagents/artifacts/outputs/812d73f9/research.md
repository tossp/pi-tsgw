# Research: 智谱 GLM 官方定价与模型规格

## Summary

以下数据来自 Z.AI 官方开发文档（USD 定价）。官方模型总览将 `200K`、`128K` 分别作为上下文窗口标称值，JSON 中按项目现有十进制约定展开为 `200000`、`128000`；最大输出值则采用官方参数表给出的精确整数。

```json
[
  {
    "id": "glm-5",
    "name": "GLM-5",
    "contextWindow": 200000,
    "maxTokens": 131072,
    "input": ["text"],
    "cost": {
      "input": 1,
      "output": 3.2,
      "cacheRead": 0.2,
      "cacheWrite": 0
    },
    "source": "https://docs.z.ai/guides/llm/glm-5"
  },
  {
    "id": "glm-5-turbo",
    "name": "GLM-5-Turbo",
    "contextWindow": 200000,
    "maxTokens": 131072,
    "input": ["text"],
    "cost": {
      "input": 1.2,
      "output": 4,
      "cacheRead": 0.24,
      "cacheWrite": 0
    },
    "source": "https://docs.z.ai/guides/llm/glm-5-turbo"
  },
  {
    "id": "glm-4.7",
    "name": "GLM-4.7",
    "contextWindow": 200000,
    "maxTokens": 131072,
    "input": ["text"],
    "cost": {
      "input": 0.6,
      "output": 2.2,
      "cacheRead": 0.11,
      "cacheWrite": 0
    },
    "source": "https://docs.z.ai/guides/llm/glm-4.7"
  },
  {
    "id": "glm-4.6",
    "name": "GLM-4.6",
    "contextWindow": 200000,
    "maxTokens": 131072,
    "input": ["text"],
    "cost": {
      "input": 0.6,
      "output": 2.2,
      "cacheRead": 0.11,
      "cacheWrite": 0
    },
    "source": "https://docs.z.ai/guides/llm/glm-4.6"
  },
  {
    "id": "glm-4.5",
    "name": "GLM-4.5",
    "contextWindow": 128000,
    "maxTokens": 98304,
    "input": ["text"],
    "cost": {
      "input": 0.6,
      "output": 2.2,
      "cacheRead": 0.11,
      "cacheWrite": 0
    },
    "source": "https://docs.z.ai/guides/llm/glm-4.5"
  },
  {
    "id": "glm-4.5-air",
    "name": "GLM-4.5-Air",
    "contextWindow": 128000,
    "maxTokens": 98304,
    "input": ["text"],
    "cost": {
      "input": 0.2,
      "output": 1.1,
      "cacheRead": 0.03,
      "cacheWrite": 0
    },
    "source": "https://docs.z.ai/guides/llm/glm-4.5"
  }
]
```

## Findings

1. **官方 USD 定价** — 官方定价页注明所有文本模型价格均为 USD/百万 token。对应列为 Input、Cached Input、Cached Input Storage、Output；上述 JSON 分别映射为 `input`、`cacheRead`、`cacheWrite`、`output`。[Pricing](https://docs.z.ai/guides/overview/pricing)
2. **上下文窗口** — 官方模型总览列出：GLM-5、GLM-5-Turbo、GLM-4.7、GLM-4.6 均为 200K；GLM-4.5、GLM-4.5-Air 均为 128K。它们位于官方 “Text Models” 表，因此输入模态记为 `text`。[Model Overview](https://docs.z.ai/guides/overview/overview)
3. **最大输出** — 官方核心参数表给出 GLM-5、GLM-5-Turbo、GLM-4.7、GLM-4.6 的最大 `max_tokens` 为 131072；GLM-4.5、GLM-4.5-Air 为 98304。[Core Parameters](https://docs.z.ai/guides/overview/concept-param)
4. **缓存写入价格的解释** — 官方没有使用 `cacheWrite` 这一字段名；最接近的公开计费项是 “Cached Input Storage”，六款模型目前均标为 “Limited-time Free”，因此当前价格映射为 `0`。这不是永久免费承诺，后续应复核定价页。[Pricing](https://docs.z.ai/guides/overview/pricing)

## Sources

- Kept: [Pricing - Z.AI Developer Document](https://docs.z.ai/guides/overview/pricing) — 六款模型的官方 USD 输入、输出、缓存命中与缓存存储价格。
- Kept: [Models Overview - Z.AI Developer Document](https://docs.z.ai/guides/overview/overview) — 官方模型类别与上下文窗口矩阵。
- Kept: [Core Parameters - Z.AI Developer Document](https://docs.z.ai/guides/overview/concept-param) — 各模型精确最大输出 token 数。
- Kept: [GLM-5](https://docs.z.ai/guides/llm/glm-5), [GLM-5-Turbo](https://docs.z.ai/guides/llm/glm-5-turbo), [GLM-4.7](https://docs.z.ai/guides/llm/glm-4.7), [GLM-4.6](https://docs.z.ai/guides/llm/glm-4.6), [GLM-4.5](https://docs.z.ai/guides/llm/glm-4.5) — 官方模型命名和产品页面。
- Dropped: `open.bigmodel.cn/pricing` — 国内站依赖 JavaScript，当前抓取无法获得可核验的结构化定价表；USD 需求改用同属官方的 Z.AI 文档。
- Dropped: 搜索结果中的第三方模型聚合与价格比较页 — 非官方来源，不用于承重字段。

## Gaps

官方页面仅以 `200K`、`128K` 展示上下文，而未在同一表中给出精确整数；本结果按仓库现有十进制目录约定展开为 `200000`、`128000`，不是将 K 按 1024 换算。官方也未直接发布名为 `cacheWrite` 的计费字段；这里将当前 “Cached Input Storage: Limited-time Free” 映射为 `0`。除此之外，六款模型的请求字段均已从官方来源确认。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "review-findings: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/812d73f9/research.md 包含 6 款模型的官方规格、USD 定价、来源及字段映射说明；residual-risks: 已明确披露上下文 K 值展开和 cacheWrite 映射风险。"
    }
  ],
  "changedFiles": [
    "/root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/812d73f9/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "官方网页检索与抓取：docs.z.ai pricing / overview / concept-param / model guides",
      "result": "passed",
      "summary": "核验了六款模型的价格、上下文、最大输出、模态和官方命名。"
    }
  ],
  "validationOutput": [
    "六款模型均有具体 JSON 条目。",
    "所有价格均来自官方 USD/百万 token 定价表。",
    "所有最大输出值均来自官方 Core Parameters 精确整数表。"
  ],
  "residualRisks": [
    "官方上下文仅标为 200K/128K，JSON 按项目十进制约定写为 200000/128000。",
    "cacheWrite=0 是对当前 Cached Input Storage（Limited-time Free）的映射，未来价格可能变化。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增官方 GLM 六款模型规格与定价调研报告，无源码或测试改动。",
  "reviewFindings": [
    "no blockers",
    "info: research.md - 国内站价格页依赖 JavaScript，USD 数据改由官方 docs.z.ai 定价页核验。"
  ],
  "manualNotes": "结果严格区分官方明确值与字段映射；未使用第三方价格。"
}
```
