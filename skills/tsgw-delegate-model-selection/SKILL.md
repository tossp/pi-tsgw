---
name: tsgw-delegate-model-selection
description: 将任务委派给子代理，或协调多个子代理并行工作时使用。
license: MIT
compatibility: 自动选型需要 Pi 1.2+ 及参数兼容的 Agent 工具。
---

# 子代理派遣

主代理负责拆分任务，核实必要输入、权限与依赖，安排并行工作并验收结果。委派时提供目标、已查证的必要事实、文件路径、实际输入与工具条件、关键难点、约束和验收标准。任务难度按实际推理需求判断。

## 调用

- 由主模型直接调用 `Agent`、`get_subagent_result`、`steer_subagent`。独立派遣可在同一回复中发起多个 `Agent` 调用。
- 新建子代理：填写 `prompt`、`description`、适合的 `subagent_type` 和执行选项；自动选型时省略 `model`，插件补入模型与思考档位，原 `Agent` 随即执行。
- 用户或项目指定模型、档位及固定审阅组合时，显式传入 `model`（`provider/modelId:level`）。正式架构／设计文档独立审阅默认 `tsgw/gpt-6.2-astra:max`；双审由主代理按本次要求分别显式安排两次独立复核。
- 续接已有会话时传 `resume`，沿用原模型；直接调用 `get_subagent_result` 查询结果、`steer_subagent` 补充指令。

## 子代理运行失败时

- 自动选中的子代理运行失败时（如额度不足、厂商异常或模型服务故障），先从工具结果确认实际执行模型和已知错误。
- 主代理根据当前可用候选及任务要求，直接选择能力更强且适合任务的其他型号，显式填写 `Agent.model` 创建新子代理，并交接已有结果和剩余工作。
- 改派遵循用户指定、固定审阅要求和原有授权范围；缺少符合要求的替代模型时，向用户报告阻塞。

## 后台执行

子代理统一使用 `run_in_background: true` 在后台执行。
