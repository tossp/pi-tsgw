import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type PayloadWriter, type ThinkingApplier } from "../_tools.ts";

/**
 * OpenAI GPT 系列（Responses 协议）。
 * 官方文档：https://platform.openai.com/docs/models
 * GPT-6.1 Sol：https://developers.openai.com/api/docs/models/gpt-6.1-sol
 * Standard ≤272K：$2 input / $0.1 cached / $2.5 cache write / $10 output（2026-09-30）。
 * GPT-6 Sol：https://developers.openai.com/api/docs/models/gpt-6-sol
 * GPT-6 Luna：https://developers.openai.com/api/docs/models/gpt-6-luna
 * 两款价格为 Standard ≤272K 输入费率（2026-09-23 核验）。
 */
export function openaiModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
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
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
		{
			id: "gpt-6.1-sol",
			name: "GPT 6.1 Sol",
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
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-sol",
			name: "GPT 6 Sol",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
			contextWindow: 1050000,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-luna",
			name: "GPT 6 Luna",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
			contextWindow: 1050000,
			maxTokens: 128000,
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
	];
}

// GPT Responses 思维链：保留 Pi 的 `reasoning`，按别名调文本 verbosity。
// 不写 service_tier：flex 为 beta 有限支持（受模型/账号限制），会被 OpenAI upstream 以
// 400 "Unsupported service_tier: flex" 拒绝，让请求走项目默认 tier。
function applyOpenAIResponses(writer: PayloadWriter, modelId: string): void {
	const verbosity = modelId === "gpt-5.6-terra" ? "medium" : "low";
	writer.setTextVerbosity(verbosity);
}

export const openaiThinking = {
	"gpt-6-astra": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-6.1-sol": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-6-sol": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-6-luna": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.6-sol": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.6-terra": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.6-luna": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.5": (w, c) => applyOpenAIResponses(w, c.modelId),
} satisfies Record<string, ThinkingApplier>;
