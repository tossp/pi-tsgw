import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface CandidateKnowledge {
	readonly id: string;
	readonly level: ModelThinkingLevel;
	readonly suitability: string;
	/** 仅描述档位与参考成本特征，不承诺实测延迟。 */
	readonly effort: string;

	readonly note: string;
}

export const DESIGN_REVIEW_TARGET = { id: "gpt-6.2-astra", level: "max" } as const;

type AihotDomainScores = readonly [
	coding: number, research: number, professional: number, knowledge: number, blindPreference?: number,
];

export interface ModelReference {
	readonly prices: readonly [input: string, output: string];
	readonly scores?: AihotDomainScores;
}

// AIHOT 模型详情 Markdown，快照 2026-11-18 14:08（北京时间）。
// https://aihot.news/leaderboard.md · https://aihot.news/leaderboard/rules
// 分数取各来源的代表配置。价格为参考价，单位是美元／百万 tokens。
export const DELEGATION_MODEL_REFERENCES: Readonly<Partial<Record<string, ModelReference>>> = {
	// MiniMax 与 Qwen 的国内参考价取自对应 vendors 源码。
	"MiniMax-M3.1-Flash": { prices: ["0.1475", "0.59"], scores: [59.8, 60.5, 64.1, 53.0, 59.7] },
	"gpt-6-luna": { prices: ["0.10", "0.50"], scores: [59.0, 58.9, 60.7, 55.9, 55.6] },
	// qwen3.8-flash 是托管版，榜单 Flash Next 的成绩归属于榜单所列型号。
	"qwen3.8-flash": { prices: ["0.118", "0.39825"] },
	"qwen4-max": { prices: ["1.475", "4.425"], scores: [68.3, 66.8, 71.1, 67.0, 71.7] },
	"glm-5.3": { prices: ["1.18", "4.13"], scores: [62.9, 61.5, 66.5, 61.5, 63.3] },
	"glm-5.3-flash": { prices: ["0.118", "0.413"], scores: [58.7, 56.5, 63.3, 54.1, 60.2] },
	"gpt-6.1-terra": { prices: ["1.00", "5.00"], scores: [70.3, 73.2, 64.1, 66.5, 69.1] },
	"gpt-6.2-sol": { prices: ["2.00", "10.00"], scores: [73.3, 74.9, 70.1, 76.9] },
	// 官方 deepseek-flash 已指向 V4.1 Flash 1017：https://api-docs.deepseek.com/updates/#deepseek-v41-flash-1017-update
	"deepseek-flash": { prices: ["0.1475–0.295", "0.59–1.18"], scores: [64.3, 64.6, 69.3, 65.9, 66.8] },
	"gpt-6.2-astra": { prices: ["8.00", "40.00"], scores: [74.6, 81.3, 73.2, 82.3] },
};

// GPT-6 定位与选型依据（2026-10-27）：https://developers.openai.com/api/docs/guides/model-selection
// https://developers.openai.com/api/docs/guides/latest-model
// GPT-6.2 Astra/Sol 接替同系列旧候选，档位与标准参考价依据 vendors/openai.ts 的登记。
// 任务定位沿用同系列分工，不据此推断网关表现或跨厂商排名。
// 仅登记候选知识与档位；排列顺序不代表能力、推荐或派遣优先级。
export const DELEGATION_KNOWLEDGE: readonly CandidateKnowledge[] = [
	{
		id: "MiniMax-M3.1-Flash", level: "high",
		suitability: "轻量执行，步骤明确的小任务",
		effort: "high 对应 output_config.effort=high",
		note: "适用范围为轻量、短程执行。",
	},
	{
		id: "gpt-6-luna", level: "high",
		suitability: "范围明确的提取、分类、结构化摘要与局部修改",
		effort: "聚焦任务的低成本 high 档",
		note: "适用于约束清楚、结果易验证的局部工作；开放式根因调查选择具备相应工程判断能力的候选。",
	},
	{
		id: "qwen3.8-flash", level: "medium",
		suitability: "范围明确的资料提取、图文理解、代码修补与工具子任务",
		effort: "原生 medium 档，较低公开参考价",
		note: "官方定位支持编码与 Agent；medium 档已通过一次最小文本回复与真实本地工具往返验收，长程工程能力尚未验证，任务仍需明确验收。",
	},
	{
		id: "qwen4-max", level: "high",
		suitability: "需要工程判断的编程、前端实现与图文结合的多步骤任务",
		effort: "原生 high 档",
		note: "旗舰工程候选，尚未验证真实工具往返；正式设计审阅沿用指定模型与档位。",
	},
	{
		id: "glm-5.3", level: "low",
		suitability: "通用工程，范围较清晰的修改",
		effort: "较低思考档",
		note: "结合套餐、成本与任务匹配选择。",
	},
	{
		id: "glm-5.3", level: "high",
		suitability: "通用工程，需要常规工程判断的修改",
		effort: "中等思考档",
		note: "结合套餐、成本与任务匹配选择。",
	},
	{
		id: "glm-5.3", level: "max",
		suitability: "通用工程，需要较深思考的修改",
		effort: "较深思考档",
		note: "用于通用工程的较深推理；复杂专项工作与正式审阅按各自要求选择。",
	},
	{
		id: "gpt-6-luna", level: "max",
		suitability: "费用敏感、范围明确且结果可验证的工程子任务，需要较深推理",
		effort: "聚焦任务的低成本深档",
		note: "适用于范围明确的聚焦任务；开放式排障与跨模块架构判断选择具备相应能力的候选，档位按各型号含义评估。",
	},
	{
		id: "glm-5.3-flash", level: "max",
		suitability: "范围明确、费用敏感的通用工程",
		effort: "低成本，深思考档",
		note: "工程候选，限已登记的 max 档。",
	},
	{
		// GPT 6.1 Terra：https://developers.openai.com/api/docs/models/gpt-6.1-terra
		// 官方页 2026-10-27 核验：reasoning 支持 none/low/medium(默认)/high/xhigh/max；
		// 标准档 ≤272K 输入 $1 / 输出 $5，>272K 输入缓存 x2、输出 x1.5。价格为官方标准档登记，
		// 不代表网关实扣；官方规格与定位未经网关实测，不据此承诺延迟或长期工程能力。
		id: "gpt-6.1-terra", level: "medium",
		suitability: "视觉资料核对、界面操作、自然写作，以及范围明确的代码修复",
		effort: "medium 思考档",
		note: "适用于输入、要求与验收方法清晰的任务；视觉或界面任务配备实际图片输入或操作工具，开放式复杂编程按专门候选的适用条件选择。",
	},
	{
		id: "gpt-6.2-sol", level: "medium",
		suitability: "复杂编码与跨步骤专业交付，范围较清楚且允许迭代修订",
		effort: "平衡成本与推理投入的 medium 档",
		note: "适用于复杂工作中 medium 档可满足实际推理需求的任务。",
	},
	{
		id: "deepseek-flash", level: "max",
		suitability: "实现、代码修改、补充测试与问题调查",
		effort: "工程任务统一使用 max 档",
		note: "按任务适用性选择，并通过实际验收判断结果质量。",
	},
	{
		id: "gpt-6.2-sol", level: "high",
		suitability: "复杂编码、电脑操作与跨步骤专业交付，需要较深工程判断",
		effort: "较深思考档",
		note: "兼顾复杂工作与成本；需比 medium 更深推理时选 high，档位依据实际推理难度选择。",
	},
	{
		id: "gpt-6.2-sol", level: "xhigh",
		suitability: "复杂项目中需综合冲突证据、协调关联交付物的高难工作",
		effort: "更深思考档",
		note: "仅在高难任务确需更深推理时使用。",
	},
	{
		id: "gpt-6.2-astra", level: "high",
		suitability: "跨领域判断、较大不确定性或严格质量要求的工作，以及局部检查与定向复审",
		effort: "高成本参考价的高思考档",
		note: "此档用于上述任务；正式设计审阅默认使用 max。",
	},
	{
		id: "gpt-6.2-astra", level: "xhigh",
		suitability: "多源证据冲突、跨领域复杂分析与严格交付，以及定向复审",
		effort: "高成本参考价的深思考档",
		note: "此档用于上述任务；正式设计审阅默认使用 max。",
	},
	{
		id: "gpt-6.2-sol", level: "max",
		suitability: "复杂编码与专业项目中确需最深推理的高难交付",
		effort: "最高思考档",
		note: "仅在极难任务确需最深推理时使用。",
	},
	{
		id: "gpt-6.2-astra", level: "max",
		suitability: "高不确定性、跨领域且确需最深推理的严格交付，以及正式架构方案或设计文档的独立审阅",
		effort: "最高思考档、最高参考成本档",
		note: "正式架构或设计文档独立审阅的指定档位。",
	},
];
