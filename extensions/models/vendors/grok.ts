import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * xAI Grok 系列（openai-completions 协议）。
 * 官方文档：https://docs.x.ai/developers/models
 * 定价（docs.x.ai/developers/pricing，<200k prompt 档）：
 *   grok-4.20 / grok-4.3：input $1.25 / cached $0.20 / output $2.50 per 1M
 *   grok-4.5：input $2.00 / cached $0.30 / output $6.00 per 1M
 */
export function grokModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "grok-4.20",
			name: "Grok 4.20",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
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
		{
			id: "grok-4.3-low",
			name: "Grok 4.3",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			// 网关思考档位别名，规格继承 grok-4.3。
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "grok-4.3-medium",
			name: "Grok 4.3",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			// 网关思考档位别名，规格继承 grok-4.3。
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "grok-4.3-high",
			name: "Grok 4.3",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			// 网关思考档位别名，规格继承 grok-4.3。
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "grok-4.20-fast",
			name: "Grok 4.20 Fast",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			// 网关快速档别名，规格继承 grok-4.20。
			cost: { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// Grok 思维链：`reasoning_effort`（none/low/medium/high）。
// 注意：grok-4.5 不支持禁用 reasoning（none），off 档映射到最小 effort "low"。
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

export const grokThinking: Record<string, ThinkingApplier> = {
	"grok-4.20": (w, c) => applyGrok(w, c.thinkingLevel),
	"grok-4.5": (w, c) => applyGrok(w, c.thinkingLevel),
	"grok-4.3-low": (w, c) => applyGrok(w, c.thinkingLevel),
	"grok-4.3-medium": (w, c) => applyGrok(w, c.thinkingLevel),
	"grok-4.3-high": (w, c) => applyGrok(w, c.thinkingLevel),
	"grok-4.20-fast": (w, c) => applyGrok(w, c.thinkingLevel),
};
