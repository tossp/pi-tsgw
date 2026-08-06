import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { type PayloadWriter, type ThinkingApplier } from "../_tools.ts";

/**
 * OpenAI GPT 系列（Responses 协议）。
 * 官方文档：https://platform.openai.com/docs/models
 */
export function openaiModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
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
	];
}

// GPT Responses 思维链：保留 Pi 的 `reasoning`，固定 `service_tier=flex`，按别名调文本 verbosity。
function applyOpenAIResponses(writer: PayloadWriter, modelId: string): void {
	const verbosity = modelId === "gpt-5.6-terra" ? "medium" : "low";
	writer.set("service_tier", "flex");
	writer.setTextVerbosity(verbosity);
}

export const openaiThinking: Record<string, ThinkingApplier> = {
	"gpt-5.6-sol": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.6-terra": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.6-luna": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.5": (w, c) => applyOpenAIResponses(w, c.modelId),
	"gpt-5.3-codex-spark": (w, c) => applyOpenAIResponses(w, c.modelId),
};
