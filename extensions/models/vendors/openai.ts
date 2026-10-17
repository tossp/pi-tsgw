import type { ProviderModelConfig as AnyModelConfig } from "@earendil-works/pi-coding-agent";
import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { type PayloadWriter, type ThinkingApplier } from "../_tools.ts";

/**
 * OpenAI GPT 系列（Responses 协议）。
 * 官方文档：https://platform.openai.com/docs/models
 * GPT-6.1 Sol：https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * 标准档 ≤272K：输入 $2 / 缓存命中 $0.1 / 缓存写入 $2.5 / 输出 $10（2026-09-30）。
 * GPT-6 Sol：https://developers.openai.com/api/docs/models/gpt-6-sol
 * GPT-6 Luna：https://developers.openai.com/api/docs/models/gpt-6-luna
 * 两款价格为标准档 ≤272K 输入费率（2026-09-23 核验）。
 */
export function openaiModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				// Pi 会将省略的较低档位视为受支持；需显式禁用。
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
		{
			id: "gpt-6.1-sol",
			name: "GPT 6.1 Sol",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				// 将最低可用档位保持为 low，自动生成标题时也如此。
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-sol",
			name: "GPT 6 Sol",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-luna",
			name: "GPT 6 Luna",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
	];
}

// GPT Responses 思维链：保留 Pi 的 `reasoning`，文本 verbosity 固定为 low。
// 不写 service_tier：flex 仅在测试阶段有限支持（受模型/账号限制），会被 OpenAI 上游以
// 400 "Unsupported service_tier: flex" 拒绝，让请求走项目默认服务档位。
function applyOpenAIResponses(writer: PayloadWriter): void {
	writer.setTextVerbosity("low");
}

export const openaiThinking = {
	"gpt-6-astra": (w, _c) => applyOpenAIResponses(w),
	"gpt-6.1-sol": (w, _c) => applyOpenAIResponses(w),
	"gpt-6-sol": (w, _c) => applyOpenAIResponses(w),
	"gpt-6-luna": (w, _c) => applyOpenAIResponses(w),
} satisfies Record<string, ThinkingApplier>;

export const OPENAI_IMAGE_API = "tsgw-openai-images";
export const OPENAI_IMAGE_MODEL_IDS = ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;
export type OpenAIImageModelConfig = Extract<AnyModelConfig, { type: "image" }>;

/**
 * 图片接口依据见记忆系统 942；两款模型共用生成与编辑适配。
 * 价格暂未纳入计费映射，0 表示未知而非免费；不混入 openaiModels 的聊天目录。
 */
export function openaiImageModels(root: string): OpenAIImageModelConfig[] {
	return OPENAI_IMAGE_MODEL_IDS.map((id, index) => ({
		type: "image", id,
		name: index === 0 ? "GPT Image 2.5 Flare" : "GPT Image 2.5 Sunburst",
		api: OPENAI_IMAGE_API, baseUrl: `${root}/v1`,
		input: ["text", "image"], output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	}));
}
