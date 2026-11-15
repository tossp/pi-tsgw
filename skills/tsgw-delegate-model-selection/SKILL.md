---
name: tsgw-delegate-model-selection
description: 将任务委派给子代理，或协调多个子代理并行工作时使用。
license: MIT
compatibility: 自动选型需要 Pi 1.2+ 及参数兼容的 Agent 工具。
---

# 子代理派遣

主代理负责拆分任务，提供目标、必要事实、文件路径、约束和验收标准，并判断依赖、并行方式与权限。委派描述应说明实际输入与工具条件、关键不确定性及结果如何验证；步骤清晰不等于问题简单。概括已查证的相关事实，不复制整段材料或敏感内容；输入未齐备时先查证，不用委派代替授权或依赖验证。

## 调用

- 当前 PiWeb 的 `Agent`、`get_subagent_result`、`steer_subagent` 只能由主模型直接调用，不得放入 codemode 或其他工具包装器。独立派遣可在同一回复中发起多个直接 `Agent` 调用。
- 新建子代理：填写 `prompt`、`description`、适合的 `subagent_type` 和执行选项；除下述可能涉密的任务外，未指定模型时省略 `model`，插件自动补入模型与思考档位，原 `Agent` 随即执行。
- 用户或项目指定模型、档位及固定审阅组合时，显式传入 `model`（`provider/modelId:level`）。正式架构／设计文档独立审阅默认 `tsgw/gpt-6-astra:max`；双审不预设模型组合，由主代理按本次要求分别显式安排，不能把两次独立复核交给一次自动选择。
- 续接已有会话时传 `resume`，不传新模型；直接调用 `get_subagent_result` 查询结果、`steer_subagent` 补充指令。

## 可能涉密的任务

- 可能涉及敏感或隐私信息时，显式指定 `model: "tsgw/deepseek-flash:max"`，不走自动选型。DeepSeek 适合简单明确的代码修改、补充测试与问题调查，能胜任的任务直接交它执行。
- 确需其他模型时，先由同一模型检查敏感信息并提出遮蔽建议，主模型决定处理方式；敏感原文不交给其他模型，后续只传脱敏材料。

## 后台执行

子代理统一使用 `run_in_background: true` 在后台执行。
