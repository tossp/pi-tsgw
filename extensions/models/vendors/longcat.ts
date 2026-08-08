import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { applyEnabledThinking, type ThinkingApplier } from "../_tools.ts";

/**
 * LongCat 2.0（龙猫）。
 * 官方文档：https://longcat.chat/platform/docs/zh/
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
	];
}

// OC/网关兼容策略：LongCat 的公开 HTTP thinking schema 未验证，用通用开关式。
export const longcatThinking: Record<string, ThinkingApplier> = {
	"longcat-2.0": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
};
