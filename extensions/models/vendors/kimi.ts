import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { applyEnabledThinking, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 月之暗面（Moonshot）Kimi 系列。
 * 官方文档：https://platform.moonshot.cn/docs
 */
export function kimiModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "kimi-for-coding",
			name: "Kimi K2.7 Code",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.95875,
				output: 3.9825,
				cacheRead: 0.19175,
				cacheWrite: 0,
			},
			contextWindow: 262144,
			maxTokens: 32768,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "kimi-k3",
			name: "Kimi K3",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "kimi-k2.7-code",
			name: "Kimi K2.7 Code",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
			contextWindow: 262144,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 262144,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "kimi-k2.7-code-highspeed",
			name: "Kimi K2.7 Code HighSpeed",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
			contextWindow: 262144,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 262144,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "kimi-k2.6",
			name: "Kimi K2.6",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
			contextWindow: 262144,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 262144,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
			contextWindow: 262144,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 262144,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// Kimi K3 思维链：移除 `thinking` 字段，改用 `reasoning_effort` 表达深度。
function applyKimiK3(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("thinking");
	if (level === "off") {
		writer.remove("reasoning_effort");
		return;
	}
	if (level === "minimal" || level === "low") {
		writer.set("reasoning_effort", "low");
		return;
	}
	writer.set("reasoning_effort", level === "max" ? "max" : "high");
}

export const kimiThinking: Record<string, ThinkingApplier> = {
	"kimi-for-coding": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"kimi-k3": (w, c) => applyKimiK3(w, c.thinkingLevel),
	"kimi-k2.7-code": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"kimi-k2.7-code-highspeed": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"kimi-k2.6": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
	"kimi-k2.5": (w, c) => applyEnabledThinking(w, c.thinkingLevel),
};
