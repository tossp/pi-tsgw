import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * MiniMax 系列。
 * 国内官方依据：
 * https://platform.minimaxi.com/docs/api-reference/text-chat （输出上限）
 * https://platform.minimaxi.com/docs/api-reference/text-openai-api （M2.x 强制思考）
 * 2026-10-16 M3.1 依据（不能关闭 thinking，支持五档 effort）：
 * https://platform.minimax.cn/docs/guides/text-generation
 * https://platform.minimax.cn/docs/api-reference/text-openai-api
 * https://platform.minimax.cn/docs/api-reference/text-chat （最大输出 524288）
 * 预览版仅 M Plan / Code 提供；未公布 token 单价，cost=0 是未知占位，不是免费。
 */
export function minimaxModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "MiniMax-M3.1-Flash-Preview",
			name: "MiniMax-M3.1-Flash-Preview",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			// No public per-token price; do not inherit M3 prices.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 524288,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "MiniMax-M3",
			name: "MiniMax-M3",
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
			maxTokens: 524288,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "MiniMax-M2.7",
			name: "MiniMax-M2.7",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: { off: null },
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
			contextWindow: 204800,
			// 官方 max_completion_tokens 上限，并非上下文估算。
			maxTokens: 204800,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "MiniMax-M2.5",
			name: "MiniMax-M2.5",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: { off: null },
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
			contextWindow: 204800,
			// 官方 max_completion_tokens 上限，并非上下文估算。
			maxTokens: 204800,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "MiniMax-M2.1",
			name: "MiniMax-M2.1",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: { off: null },
			input: ["text"],
			cost: { input: 0.3, output: 1.2, cacheRead: 0.03, cacheWrite: 0.375 },
			contextWindow: 204800,
			// 官方 max_completion_tokens 上限，并非上下文估算。
			maxTokens: 204800,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// MiniMax 思维链：`reasoning_split=true`，档位映射 disabled/adaptive。
// 国内 OpenAI SDK 文档明确区分：M3 可关闭；M2.x disabled 被接受但不生效。
function applyMiniMax(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("reasoning_split", true);
	writer.setThinking({ type: level === "off" ? "disabled" : "adaptive" });
}

function applyMiniMax31(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.set("reasoning_split", true);
	writer.setThinking({ type: "adaptive" });
	// Stale off/minimal snapshots must not select unsupported none or default max.
	writer.set("reasoning_effort", level === "off" || level === "minimal" ? "low" : level);
}

export const minimaxThinking = {
	"MiniMax-M3.1-Flash-Preview": (w, c) => applyMiniMax31(w, c.thinkingLevel),
	"MiniMax-M3": (w, c) => applyMiniMax(w, c.thinkingLevel),
	"MiniMax-M2.7": (w) => applyMiniMax(w, "high"),
	"MiniMax-M2.5": (w) => applyMiniMax(w, "high"),
	"MiniMax-M2.1": (w) => applyMiniMax(w, "high"),
} satisfies Record<string, ThinkingApplier>;
