import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { applyEnabledThinking, type ThinkingApplier } from "../_tools.ts";

/**
 * 美团 LongCat（龙猫）系列。
 * 官方中文文档（2026-10-17 核实）：https://longcat.ai/platform/docs/zh/
 * 网关目录 ID 为小写 longcat-*；上游 API 模型名保留大小写
 * （LongCat-2.5-Preview / LongCat-2.0）。
 */
export function longcatModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "longcat-2.0",
			name: "LongCat-2.0",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.295, output: 1.18, cacheRead: 0.0059, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			// LongCat-2.5-Preview（2026-09-25 上线）。依据官方中文文档：
			// - 输入模态：模型详情 /api/model 示例 input_modalities 为 ["text"]、
			//   modality "text->text"，OpenAI/Anthropic 两套消息 schema 的 content
			//   均为“纯文本字符串”；更新日志宣称新增图片理解能力，但当前 API
			//   契约未提供图像入参，按 API 契约登记为纯文本输入（冲突见更新日志）。
			// - 定价（国内 chat 版，限时折扣价）/pricing/longcat-2.5：
			//   输入未命中缓存 ¥2、命中缓存 ¥0.04、输出 ¥8 每百万词元，无缓存写计费；
			//   按既有固定 0.1475 USD/CNY 折算为 0.295 / 0.0059 / 1.18 USD。
			// - 参数 /api/model-params：上下文 1,048,576、max_tokens 上限
			//   262,144（256K）。快速开始页仍写最大输出 128K 且两型号相同，
			//   与逐型号对照的参数参考页冲突；以参数参考页为准（thinking_budget
			//   上限同为 262,144 可互证）。
			id: "longcat-2.5-preview",
			name: "LongCat-2.5-Preview",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.295, output: 1.18, cacheRead: 0.0059, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 262144,
			// 官方协议字段为 max_tokens，由宿主 compat 映射，不自行改写 token 上限。
			compat: { ...OPENAI_COMPLETIONS_COMPAT, maxTokensField: "max_tokens" },
		},
	];
}

// 2.5 的 /api/chat 与 /api/model-params 已确认 thinking.type enabled/disabled；
// 独立核对后可复用通用开关式，不支持 reasoning_effort。预算没有逐档依据，不臆造映射。
// 可关闭思考，故不设 off:null；采样温度由服务端按思考开关覆盖。

// OC/网关兼容策略：longcat-2.0 的公开 HTTP thinking 结构定义未验证，沿用通用开关式；
// longcat-2.5-preview 经独立核对后复用相同的开关形状（见上方依据）。
export const longcatThinking: Record<string, ThinkingApplier> = {
	"longcat-2.0": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"longcat-2.5-preview": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
};
