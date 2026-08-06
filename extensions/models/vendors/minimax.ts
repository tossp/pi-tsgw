import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * MiniMax 系列。
 * 官方文档：https://platform.minimaxi.com/（国际站 platform.minimax.io）
 */
export function minimaxModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "minimax-m3",
			name: "Minimax M3",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.30975,
				output: 1.239,
				cacheRead: 0.06195,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 500000,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "minimax-m2.7",
			name: "MiniMax-M2.7",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
			contextWindow: 204800,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 204800,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "minimax-m2.5",
			name: "MiniMax-M2.5",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
			contextWindow: 204800,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 204800,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "minimax-m2.1",
			name: "MiniMax-M2.1",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
			contextWindow: 204800,
			// 官方未公布最大输出上限，保守取上下文窗口。
			maxTokens: 204800,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// MiniMax 思维链：`reasoning_split=true`，档位映射 disabled/adaptive。
// M2.x 沿用 M3 策略（同族，未逐一验证）。
function applyMiniMax(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("reasoning_split", true);
	writer.setThinking({ type: level === "off" ? "disabled" : "adaptive" });
}

export const minimaxThinking: Record<string, ThinkingApplier> = {
	"minimax-m3": (w, c) => applyMiniMax(w, c.thinkingLevel),
	"minimax-m2.7": (w, c) => applyMiniMax(w, c.thinkingLevel),
	"minimax-m2.5": (w, c) => applyMiniMax(w, c.thinkingLevel),
	"minimax-m2.1": (w, c) => applyMiniMax(w, c.thinkingLevel),
};
