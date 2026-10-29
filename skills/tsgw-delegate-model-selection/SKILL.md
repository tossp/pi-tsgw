---
name: tsgw-delegate-model-selection
description: 将适合的任务派给独立子代理。直接调用 Agent 并提供完整任务；未指定模型时由插件自动选型。
license: MIT
compatibility: 自动选型需要 Pi 1.2+ 及参数兼容的 Agent 工具。
---

# 子代理派遣

主代理负责拆分任务，提供目标、必要事实、文件路径、约束和验收标准，并判断依赖、并行方式与权限。委派描述应说明实际输入与工具条件、关键不确定性及结果如何验证；步骤清晰不等于问题简单。概括已查证的相关事实，不复制整段材料或敏感内容；输入未齐备时先查证，不用委派代替授权或依赖验证。

## 调用

- 当前 PiWeb 的 `Agent`、`get_subagent_result`、`steer_subagent` 只能由主模型直接调用，不得放入 codemode 或其他工具包装器。独立派遣可在同一回复中发起多个直接 `Agent` 调用。
- 新建子代理：填写 `prompt`、`description`、适合的 `subagent_type` 和执行选项；未指定模型时省略 `model`，插件自动补入模型与思考档位，原 `Agent` 随即执行。
- 用户或项目指定模型、档位及固定审阅组合时，显式传入 `model`（`provider/modelId:level`）。正式架构／设计文档独立审阅默认 `tsgw/gpt-6-astra:max`；固定双审分别使用 `tsgw/kimi-k3.1-pro:high` 与 `tsgw/gpt-6-astra:max`，不能把两次独立复核交给一次自动选择。
- 续接已有会话时传 `resume`，不传新模型；直接调用 `get_subagent_result` 查询结果、`steer_subagent` 补充指令。

## 后台与依赖

- 独立任务优先 `run_in_background: true`；前置依赖未完成或存在并发修改冲突时，不要假装独立。不要重复派遣已在执行的任务。
- 当前 PiWeb 会在主会话空闲时发送后台结果通知并触发后续处理。派出后继续推进独立工作；没有独立工作时结束当前轮次等待通知，不反复查询，不习惯性调用 `get_subagent_result({ wait: true })` 占用前台。
- 只有查看中间状态、排障或明确需要同步取结果时才主动查询；通知尚未到达不代表任务未完成，不因此重复派遣。
