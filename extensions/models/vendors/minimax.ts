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
	];
}

// MiniMax 思维链：`reasoning_split=true`，档位映射 disabled/adaptive。
function applyMiniMax(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("reasoning_split", true);
	writer.setThinking({ type: level === "off" ? "disabled" : "adaptive" });
}

export const minimaxThinking: Record<string, ThinkingApplier> = {
	"minimax-m3": (w, c) => applyMiniMax(w, c.thinkingLevel),
};
