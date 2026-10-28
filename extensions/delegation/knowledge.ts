import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

interface CandidateKnowledge {
	readonly id: string;
	readonly level: ModelThinkingLevel;
	readonly suitability: string;
	/** 仅描述档位与参考成本特征，不承诺实测延迟。 */
	readonly effort: string;
	readonly inputPrice: string;
	readonly outputPrice: string;
	readonly note: string;
}

// GPT-6 定位与选型依据（2026-10-27）：https://developers.openai.com/api/docs/guides/model-selection
// https://developers.openai.com/api/docs/guides/latest-model
// 官方建议用于任务匹配；保留本项目已选档位，不据此推断网关表现或跨厂商排名。
// 仅登记候选知识与档位；排列顺序不代表能力、推荐或派遣优先级。
export const DELEGATION_KNOWLEDGE: readonly CandidateKnowledge[] = [
	{
		id: "MiniMax-M3.1-Flash", level: "high",
		suitability: "轻量执行，只适合步骤明确的小任务",
		effort: "high 对应 output_config.effort=high",
		// 参考价沿用 vendors/minimax.ts 的国内正式版登记，不代表网关实扣。
		inputPrice: "0.1475", outputPrice: "0.59",
		note: "不承担复杂或长程执行。",
	},
	{
		id: "gpt-6-luna", level: "high",
		suitability: "范围明确的提取、分类、结构化摘要与局部修改",
		effort: "聚焦任务的低成本 high 档",
		inputPrice: "0.10", outputPrice: "0.50",
		note: "要求约束清楚、结果易验证；步骤清晰不代表问题简单，不用于开放式根因调查。",
	},
	{
		id: "glm-5.3", level: "low",
		suitability: "通用工程，范围较清晰的修改",
		effort: "较低思考档",
		inputPrice: "1.18", outputPrice: "4.13",
		note: "结合套餐、成本与任务匹配选择。",
	},
	{
		id: "glm-5.3", level: "high",
		suitability: "通用工程，需要常规工程判断的修改",
		effort: "中等思考档",
		inputPrice: "1.18", outputPrice: "4.13",
		note: "结合套餐、成本与任务匹配选择。",
	},
	{
		id: "glm-5.3", level: "max",
		suitability: "通用工程，需要较深思考的修改",
		effort: "较深思考档",
		inputPrice: "1.18", outputPrice: "4.13",
		note: "仍是工程候选，不自动替代更专门的复杂或审阅选项。",
	},
	{
		id: "gpt-6-luna", level: "max",
		suitability: "费用敏感、范围明确且结果可验证的工程子任务，需要较深推理",
		effort: "聚焦任务的低成本深档",
		inputPrice: "0.10", outputPrice: "0.50",
		note: "不因低价或 max 承担开放式排障、跨模块架构判断；不同模型的思考档位不作等效比较。",
	},
	{
		id: "glm-5.3-flash", level: "max",
		suitability: "范围明确、费用敏感的通用工程",
		effort: "低成本，深思考档",
		inputPrice: "0.118", outputPrice: "0.413",
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
		inputPrice: "1.00", outputPrice: "5.00",
		note: "需有清晰输入、要求与验收方法；涉及视觉或界面时须具备实际图片输入或操作工具，不作为开放式复杂编程默认。",
	},
	{
		id: "gpt-6.1-sol", level: "medium",
		suitability: "复杂编码与跨步骤专业交付，范围较清楚且允许迭代修订",
		effort: "平衡成本与推理投入的 medium 档",
		inputPrice: "2.00", outputPrice: "10.00",
		note: "按实际推理需求选择，不因任务包含复杂工作就自动提高档位。",
	},
	{
		id: "deepseek-flash", level: "high",
		suitability: "常规实现、代码修改与补充测试",
		effort: "常规工程 high 档，参考成本较低",
		inputPrice: "0.1475–0.295", outputPrice: "0.59–1.18",
		note: "需要常规工程判断；价格区间为低谷／高峰参考价。",
	},
	{
		id: "deepseek-flash", level: "max",
		suitability: "需要较深推理的复杂实现与问题调查",
		effort: "复杂实现 max 档，比 high 思考更深",
		inputPrice: "0.1475–0.295", outputPrice: "0.59–1.18",
		note: "按实际推理需求选择，不把提升档位当作必然提升。",
	},
	{
		id: "gpt-6.1-sol", level: "high",
		suitability: "复杂编码、电脑操作与跨步骤专业交付，需要较深工程判断",
		effort: "较深思考档",
		inputPrice: "2.00", outputPrice: "10.00",
		note: "兼顾复杂工作与成本；需比 medium 更深推理时选 high，不仅按步骤数判断。",
	},
	{
		id: "gpt-6.1-sol", level: "xhigh",
		suitability: "复杂项目中需综合冲突证据、协调关联交付物的高难工作",
		effort: "更深思考档",
		inputPrice: "2.00", outputPrice: "10.00",
		note: "仅在高难任务确需更深推理时使用。",
	},
	{
		id: "kimi-k3.1-pro", level: "high",
		suitability: "资料核对、局部检查与独立定向复核",
		effort: "high 对应原生 high，按任务需要使用",
		// 国内标准版参考价与折算依据见 vendors/kimi.ts；不是高速版或网关实扣。
		inputPrice: "1.9175", outputPrice: "10.03",
		note: "不承担长程执行；真实工具往返尚未验收。",
	},
	{
		id: "gpt-6-astra", level: "high",
		suitability: "跨领域判断、较大不确定性或严格质量要求的工作，以及局部检查与定向复审",
		effort: "高成本参考价的高思考档",
		inputPrice: "10.00", outputPrice: "50.00",
		note: "正式设计审阅默认使用 max，不因材料短或范围明确自动降档。",
	},
	{
		id: "gpt-6-astra", level: "xhigh",
		suitability: "多源证据冲突、跨领域复杂分析与严格交付，以及定向复审",
		effort: "高成本参考价的深思考档",
		inputPrice: "10.00", outputPrice: "50.00",
		note: "正式设计审阅默认使用 max，不因材料短或范围明确自动降档。",
	},
	{
		id: "gpt-6.1-sol", level: "max",
		suitability: "复杂编码与专业项目中确需最深推理的高难交付",
		effort: "最高思考档",
		inputPrice: "2.00", outputPrice: "10.00",
		note: "仅在极难任务确需最深推理时使用。",
	},
	{
		id: "gpt-6-astra", level: "max",
		suitability: "高不确定性、跨领域且确需最深推理的严格交付，以及正式架构方案或设计文档的独立审阅",
		effort: "最高思考档、最高参考成本档",
		inputPrice: "10.00", outputPrice: "50.00",
		note: "formal design review 的默认档位。",
	},
];
