import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { applyEnabledThinking, type ThinkingApplier } from "../_tools.ts";

/**
 * 小米（Xiaomi）MiMo 系列。
 * 官方文档：https://platform.xiaomimimo.com/docs/
 */
export function mimoModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "mimo-v2.5-pro",
			name: "MiMo V2.5 Pro",
			api: "openai-completions",
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
			maxTokens: 131072,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "mimo-v2.5",
			name: "MiMo V2.5",
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
	"mimo-v2.5-pro": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"mimo-v2.5": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
};
