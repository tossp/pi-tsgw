import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * MiniMax 系列。
 * 国内官方依据：
 * https://platform.minimaxi.com/docs/api-reference/text-chat （输出上限）
 * 2026-10-20 正式版 M3.1 核验（不能关闭思考，支持五档思考深度）：
 * https://platform.minimax.cn/docs/guides/text-generation
 * https://platform.minimax.cn/docs/api-reference/text-openai-api
 * https://platform.minimax.cn/docs/api-reference/text-chat （最大输出 524288）
 * https://platform.minimax.cn/docs/pricing/overview （正式版输入/输出/缓存读取 ¥1/4/0.1 每百万词元）
 * 按项目固定 0.1475 USD/CNY 折算，公开估价不代表网关实扣；未列缓存写入价用零占位。
 * 旧 Preview ID 保留原规格与未知零价，不将正式版价格追溯应用到预览版。
 */
export function minimaxModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		...["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"].map((id): ProviderModelConfig => ({
			id,
			name: id,
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
			cost: id === "MiniMax-M3.1-Flash"
				? { input: 0.1475, output: 0.59, cacheRead: 0.01475, cacheWrite: 0 }
				: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 524288,
			compat: OPENAI_COMPLETIONS_COMPAT,
		})),
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
	];
}

// MiniMax 思维链：`reasoning_split=true`，档位映射 disabled/adaptive。
// 国内 OpenAI SDK 文档：M3 可关闭思考。
function applyMiniMax(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("reasoning_split", true);
	writer.setThinking({ type: level === "off" ? "disabled" : "adaptive" });
}

function applyMiniMax31(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.set("reasoning_split", true);
	writer.setThinking({ type: "adaptive" });
	// 过期的 off/minimal 快照不得选用不受支持的 none，也不得使用默认 max。
	writer.set("reasoning_effort", level === "off" || level === "minimal" ? "low" : level);
}

export const minimaxThinking = {
	"MiniMax-M3.1-Flash": (w, c) => applyMiniMax31(w, c.thinkingLevel),
	"MiniMax-M3.1-Flash-Preview": (w, c) => applyMiniMax31(w, c.thinkingLevel),
	"MiniMax-M3": (w, c) => applyMiniMax(w, c.thinkingLevel),
} satisfies Record<string, ThinkingApplier>;
