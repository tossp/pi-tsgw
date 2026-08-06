import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_COMPAT } from "./_protocols.ts";

/**
 * Anthropic Claude 系列（anthropic-messages 协议）。
 * 官方文档：https://docs.claude.com/en/docs/about-claude/models/
 */
export function anthropicModels(root: string): ProviderModelConfig[] {
	const anthropic = `${root}/anthropic`;
	return [
		{
			id: "claude-fable-5",
			name: "Claude Fable 5",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.3 },
			contextWindow: 1000000,
			maxTokens: 128000,
			compat: ANTHROPIC_COMPAT,
		},
		{
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 200000,
			maxTokens: 128000,
			compat: ANTHROPIC_COMPAT,
		},
		{
			id: "claude-sonnet",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200000,
			maxTokens: 64000,
			compat: ANTHROPIC_COMPAT,
		},
	];
}
