import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";

// DeepSeek Responses 将 developer role 当作 user，且不支持 OpenAI 的
// prompt_cache_retention；其余 reasoning 字段交给 Pi 的 Responses adapter。
const DEEPSEEK_RESPONSES_COMPAT = {
	supportsDeveloperRole: false,
	supportsLongCacheRetention: false,
};

/**
 * DeepSeek（深度求索）V4 系列。
 * 官方文档：https://api-docs.deepseek.com/guides/responses_api
 */
export function deepseekModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_RESPONSES_COMPAT,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
		},
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash (Legacy Alias)",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_RESPONSES_COMPAT,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.4425,
				output: 0.885,
				cacheRead: 0.0036875,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_RESPONSES_COMPAT,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
		},
	];
}
