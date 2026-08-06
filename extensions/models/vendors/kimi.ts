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
};
