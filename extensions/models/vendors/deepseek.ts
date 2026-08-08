import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isMaximum, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

// DeepSeek 在 openai-completions 协议基础上，要求 DeepSeek 特有 thinking 格式，
// 且多轮（尤其工具调用）必须保留 reasoning_content。
const DEEPSEEK_COMPAT = {
	...OPENAI_COMPLETIONS_COMPAT,
	thinkingFormat: "deepseek" as const,
	requiresReasoningContentOnAssistantMessages: true,
};

/**
 * DeepSeek（深度求索）V4 系列。
 * 官方文档：https://api-docs.deepseek.com/
 */
export function deepseekModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_COMPAT,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: "max",
				max: "max",
			},
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
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
			maxTokens: 384000,
			compat: DEEPSEEK_COMPAT,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: "max",
				max: "max",
			},
		},
	];
}

// DeepSeek 思维链：`thinking.type` + `reasoning_effort`（high/max 两档）。
function applyDeepSeek(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	if (level === "off") {
		writer.setThinking({ type: "disabled" });
		return;
	}
	writer.setThinking({ type: "enabled" });
	writer.set("reasoning_effort", isMaximum(level) ? "max" : "high");
}

export const deepseekThinking: Record<string, ThinkingApplier> = {
	"deepseek-v4-flash": (w, c) => applyDeepSeek(w, c.thinkingLevel),
	"deepseek-v4-pro": (w, c) => applyDeepSeek(w, c.thinkingLevel),
};
