[
  {
    "id": "qwen3.6-plus",
    "name": "千问3.6 Plus",
    "contextWindow": 1000000,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 2,
      "output": 12,
      "cacheRead": 0.2,
      "cacheWrite": 2.5,
      "currency": "CNY"
    },
    "source": "https://help.aliyun.com/zh/model-studio/qwen3-6-plus"
  },
  {
    "id": "qwen3.5-plus",
    "name": "千问3.5 Plus",
    "contextWindow": 1000000,
    "maxTokens": 65536,
    "input": ["text", "image"],
    "cost": {
      "input": 0.8,
      "output": 4.8,
      "cacheRead": 0.08,
      "cacheWrite": 1,
      "currency": "CNY"
    },
    "source": "https://help.aliyun.com/zh/model-studio/qwen3-5-plus"
  }
]

说明：以上价格均为阿里云百炼官方模型卡中“华北2（北京）”实时推理的最低输入阶梯原价，单位为 CNY/百万 token；`qwen3.6-plus` 对应单次输入不超过 256K，`qwen3.5-plus` 对应单次输入不超过 128K。两者均实行阶梯计费，输入更长时 input、output、cacheRead、cacheWrite 均会上调，因此无法用题定单一数值结构完整表达全部阶梯。`cacheRead` 映射官方“显式缓存命中”，`cacheWrite` 映射“显式缓存创建”。官方还确认两者支持 video 输入，但题目要求的输入模态范围为 text/image，故数组仅列这两项。没有字段因官方资料缺失而置为 null。

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "review-findings: 已在 /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/cc6c959c/research.md 给出两款模型的官方规格、北京地域基础阶梯定价和官方模型卡 URL；residual-risks: 单值 cost 无法承载官方阶梯价格，已明确适用阶梯。"
    }
  ],
  "changedFiles": [
    "/root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/cc6c959c/research.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "官方网页检索与模型卡抓取（web_search/fetch_content）",
      "result": "passed",
      "summary": "核对 qwen3.6-plus、qwen3.5-plus 官方模型卡、模型规格、区域阶梯价格及缓存价格。"
    }
  ],
  "validationOutput": [
    "qwen3.6-plus 官方模型卡确认 context=1,000,000、max output=65,536、Text/Image 输入；北京 <=256K 价格为 input 2、output 12、显式缓存命中 0.2、创建 2.5 CNY/百万 token。",
    "qwen3.5-plus 官方模型卡确认 context=1,000,000、max output=65,536、Text/Image 输入；北京 <=128K 价格为 input 0.8、output 4.8、显式缓存命中 0.08、创建 1 CNY/百万 token。"
  ],
  "residualRisks": [
    "官方采用按地域、按单次输入长度阶梯计费；题定 JSON cost 仅允许单个数字，本文件采用华北2（北京）的最低输入阶梯，不能代表长输入或新加坡等地域价格。",
    "官方模型卡同时列出 video 输入，但题目限定 text/image，因此未写入 input 数组。"
  ],
  "noStagedFiles": true,
  "diffSummary": "新增研究产物 research.md，包含两款千问 Plus 模型的官方 JSON 数据、阶梯定价说明和验收报告。",
  "reviewFindings": [
    "warning: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/cc6c959c/research.md - cost 单值只能表示一个价格阶梯；已采用北京最低阶梯并显式披露。",
    "no blockers"
  ],
  "manualNotes": "主要来源均为阿里云百炼官方独立模型卡；另以官方模型调用价格和上下文缓存文档交叉核验阶梯规则及缓存语义。"
}
```
