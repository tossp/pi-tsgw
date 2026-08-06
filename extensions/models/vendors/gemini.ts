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
	"gemini-pro": (w, c) => applyGeminiPro(w, c.thinkingLevel),
};
