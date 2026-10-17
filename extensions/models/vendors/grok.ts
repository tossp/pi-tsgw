import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isPlainObject, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * xAI Grok 系列：4.5 使用 Completions，4.7 使用 Responses。
 * 官方文档：https://docs.x.ai/developers/models
 * 定价（docs.x.ai/developers/pricing，提示词 <200k 档）：
 *   grok-4.5：每百万词元输入 $2.00 / 缓存命中 $0.30 / 输出 $6.00
 */
export function grokModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "grok-4.7",
			name: "Grok 4.7",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			// 2026-10-17：https://docs.x.ai/developers/models/grok-4.7
			// <200K 官方参考价；≥200K 输入/缓存/输出均 ×2，cacheWrite=0 表示未单列。
			cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 500000,
			// 官方不设独立文本输出上限；此值取上下文容量上界，不宣称可同时填满输入与输出。
			maxTokens: 500000,
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" },
		},
		{
			id: "grok-4.5",
			name: "Grok 4.5",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 0 },
			contextWindow: 500000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// 官方：https://docs.x.ai/developers/model-capabilities/text/reasoning
// grok-4.5 支持 low/medium/high，不支持禁用 reasoning，off 映射到 low。
function applyGrok(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("thinking");
	if (level === "off") {
		writer.set("reasoning_effort", "low");
		return;
	}
	const effort =
		level === "minimal" || level === "low"
			? "low"
			: level === "medium"
				? "medium"
				: "high";
	writer.set("reasoning_effort", effort);
}

// Responses 保留宿主的 encrypted reasoning/include 与其他 reasoning 字段，
// 仅归一化不受支持的档位；off 不关闭思考，遗留会话回退 low。
function applyGrok47(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("thinking");
	writer.remove("reasoning_effort");
	const current = writer.get("reasoning");
	if (current !== undefined && !isPlainObject(current)) return;
	const reasoning = isPlainObject(current) ? current : {};
	const effort = level === "off" || level === "minimal" ? "low" : level === "max" ? "xhigh" : level;
	if (reasoning.effort !== effort) writer.set("reasoning", { ...reasoning, effort });
}

export const grokThinking: Record<string, ThinkingApplier> = {
	"grok-4.7": (w, c) => applyGrok47(w, c.thinkingLevel),
	"grok-4.5": (w, c) => applyGrok(w, c.thinkingLevel),
};
