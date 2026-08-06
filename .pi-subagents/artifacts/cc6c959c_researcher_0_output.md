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