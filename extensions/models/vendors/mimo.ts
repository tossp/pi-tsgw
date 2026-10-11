import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { applyEnabledThinking, type ThinkingApplier } from "../_tools.ts";

/**
 * 小米（Xiaomi）MiMo 系列。
 * 2026-10-10：直接迁移至 V2.6，不保留待下线的 V2.5 ID。
 * 规格：https://mimo.mi.com/docs/zh-CN/quick-start/summary/model
 * 思考：https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/text-generation/deep-thinking
 * 定价：https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go
 * 国内 CNY/百万 tokens 按既有 0.1475 USD/CNY 估算；缓存写入限时免费。
 */
export function mimoModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "mimo-v2.6-pro",
			name: "MiMo V2.6 Pro",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.4425,
				output: 0.885,
				cacheRead: 0.0036875,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "mimo-v2.6-flash",
			name: "MiMo V2.6 Flash",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

export const mimoThinking: Record<string, ThinkingApplier> = {
	"mimo-v2.6-pro": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"mimo-v2.6-flash": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
};
