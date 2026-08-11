import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { ANTHROPIC_COMPAT } from "./_protocols.ts";

/**
 * Anthropic Claude 系列（anthropic-messages 协议）。
 * 官方文档：https://docs.claude.com/en/docs/about-claude/models/
 * 规格/定价以网关目录为准（fable/opus/sonnet 三档）。
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
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: 1000000,
			maxTokens: 128000,
			compat: ANTHROPIC_COMPAT,
		},
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 },
			contextWindow: 1000000,
			maxTokens: 128000,
			compat: ANTHROPIC_COMPAT,
		},
	];
}
