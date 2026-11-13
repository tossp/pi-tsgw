import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { ANTHROPIC_COMPAT } from "./_protocols.ts";

/**
 * Anthropic Claude 系列（anthropic-messages 协议）。
 * 官方文档：https://docs.claude.com/en/docs/about-claude/models/
 * 规格/定价以网关目录为准（opus/sonnet 两档）。
 */
export function anthropicModels(root: string): ProviderModelConfig[] {
	// 宿主 SDK 会追加 /v1/messages，基地址不再加厂商路径。
	// 线程续接仅用于 Claude，不放入其他厂商复用的协议配置。
	const compat = { ...ANTHROPIC_COMPAT, supportsMessageThreads: true };
	return [
		{
			id: "claude-opus-5",
			name: "Claude Opus 5",
			api: "anthropic-messages",
			baseUrl: root,
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
			compat,
		},
		{
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "anthropic-messages",
			baseUrl: root,
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
			compat,
		},
	];
}
