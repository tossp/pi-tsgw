import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const PROVIDER_ID = "aih";

/**
 * Neutral placeholder root. Point the extension at your gateway through
 * settings.json (`"aih": { "baseUrl": ... }`) or the `AIH_BASE_URL`
 * environment variable; this default only applies when neither is set.
 */
export const DEFAULT_ROOT = "https://aih.example.com";

// The AIH Chat Completions gateway accepts `system`, but not OpenAI's newer
// `developer` role. Pi otherwise assumes a custom reasoning provider supports it.
const AIH_CHAT_COMPLETIONS_COMPAT = { supportsDeveloperRole: false };

// DeepSeek models require DeepSeek-specific thinking format and must preserve
// reasoning_content across multi-turn requests, especially with tool calls.
const AIH_DEEPSEEK_COMPAT = {
	supportsDeveloperRole: false,
	thinkingFormat: "deepseek" as const,
	requiresReasoningContentOnAssistantMessages: true,
};

/** Normalize a gateway root, including the common accidental `/v1` suffix. */
export function normalizeRoot(
	value = process.env.AIH_BASE_URL?.trim() || DEFAULT_ROOT,
): string {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("AIH_BASE_URL must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	if (url.pathname === "/v1") url.pathname = "";
	else if (url.pathname.endsWith("/v1"))
		url.pathname = url.pathname.slice(0, -3);
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

/**
 * The authoritative static AIH catalog. API and endpoint are model-level so
 * Pi can dispatch the four wire protocols through one provider ID.
 */
export function modelsForRoot(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	const anthropic = `${root}/anthropic`;
	const gemini = `${root}/gemini`;

	return [
		{
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: AIH_DEEPSEEK_COMPAT,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: "max",
				max: "max",
			},
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.4425,
				output: 0.885,
				cacheRead: 0.0036875,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: AIH_DEEPSEEK_COMPAT,
			thinkingLevelMap: {
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: "max",
				max: "max",
			},
		},
		{
			id: "glm-5.2",
			name: "GLM 5.2",
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
			input: ["text"],
			cost: { input: 1.18, output: 4.13, cacheRead: 0.295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "glm-5.1",
			name: "GLM 5.1",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.885, output: 3.54, cacheRead: 0.19175, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 65536,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "mimo-v2.5-pro",
			name: "MiMo V2.5 Pro",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: {
				input: 0.4425,
				output: 0.885,
				cacheRead: 0.0036875,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "mimo-v2.5",
			name: "MiMo V2.5",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
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
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
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
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
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
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "longcat-2.0",
			name: "LongCat-2.0",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.295, output: 1.18, cacheRead: 0.0059, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "qwen3.7-plus",
			name: "Qwen3.7 Plus",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.295,
				output: 1.18,
				cacheRead: 0.059,
				cacheWrite: 0.36875,
			},
			contextWindow: 1000000,
			maxTokens: 64000,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "qwen3.7-max",
			name: "Qwen3.7 Max",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 1.77, output: 5.31, cacheRead: 0.354, cacheWrite: 2.2125 },
			contextWindow: 1000000,
			maxTokens: 64000,
			compat: AIH_CHAT_COMPLETIONS_COMPAT,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT 5.6 Sol",
			api: "openai-responses",
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
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
			contextWindow: 372000,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT 5.6 Terra",
			api: "openai-responses",
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
			cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
			contextWindow: 372000,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT 5.6 Luna",
			api: "openai-responses",
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
			cost: { input: 1, output: 6, cacheRead: 0.01, cacheWrite: 1.25 },
			contextWindow: 372000,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
			input: ["text", "image"],
			cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
			contextWindow: 272000,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
			},
			input: ["text"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 32000,
		},
		{
			id: "gemini-flash",
			name: "Gemini 3 Flash",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-pro",
			name: "Gemini 3.1 Pro",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
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
			compat: { forceAdaptiveThinking: true },
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
			compat: { forceAdaptiveThinking: true },
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
			compat: { forceAdaptiveThinking: true },
		},
	];
}
