import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { isAtLeastHigh, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * Google Gemini 系列（google-generative-ai 协议）。
 * 官方文档：https://ai.google.dev/gemini-api/docs
 */
export function geminiModels(root: string): ProviderModelConfig[] {
	const gemini = `${root}/gemini`;
	return [
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
			id: "gemini-3.5-flash",
			name: "Gemini 3.5 Flash",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			// 官方缓存存储按小时计费，无法映射为单价，置 0。
			cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.5-flash-low",
			name: "Gemini 3.5 Flash",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			// 网关思考档位别名，规格继承 gemini-3.5-flash。
			cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.5-flash-extra-low",
			name: "Gemini 3.5 Flash",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			// 网关思考档位别名，规格继承 gemini-3.5-flash。
			cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.1-pro-low",
			name: "Gemini 3.1 Pro Preview",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			// 网关思考档位别名（low），规格继承 gemini-3.1-pro-preview。
			cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash",
			name: "Gemini 2.5 Flash",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-2.5-flash-lite",
			name: "Gemini 2.5 Flash-Lite",
			api: "google-generative-ai",
			baseUrl: gemini,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
	];
}

// Gemini 思维链：`config.thinkingConfig`（includeThoughts/thinkingLevel/thinkingBudget）。
function applyGeminiFlash(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	if (level === "off") {
		writer.setGoogleThinking({ includeThoughts: false, thinkingBudget: 0 }, ["thinkingLevel"]);
		return;
	}
	const budget = level === "max" ? 24576 : 16000;
	writer.setGoogleThinking({ includeThoughts: true, thinkingBudget: budget }, ["thinkingLevel"]);
}

function applyGeminiPro(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	const thinkingLevel = level === "off" || level === "minimal" || level === "low"
		? "LOW"
		: level === "medium"
			? "MEDIUM"
			: "HIGH";
	writer.setGoogleThinking({ includeThoughts: level !== "off", thinkingLevel }, ["thinkingBudget"]);
}

export const geminiThinking: Record<string, ThinkingApplier> = {
	"gemini-flash": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-3.5-flash": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-3.5-flash-low": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-3.5-flash-extra-low": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-2.5-flash": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-2.5-flash-lite": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-pro": (w, c) => applyGeminiPro(w, c.thinkingLevel),
	"gemini-3.1-pro-low": (w, c) => applyGeminiPro(w, c.thinkingLevel),
	"gemini-2.5-pro": (w, c) => applyGeminiPro(w, c.thinkingLevel),
};
