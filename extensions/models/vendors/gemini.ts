import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";

/**
 * Google Gemini 系列（原生 Google 协议；3.5 Flash-Lite 使用网关 Completions 路由）。
 * 官方文档：https://ai.google.dev/gemini-api/docs
 * GenerateContent 档位/预算：https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thinking
 * gemini-flash 别名保留预算策略，其他保留型号使用档位策略。网关别名的路由仍需网关侧验证。
 *
 * 新增型号依据（2026-10-17 核查）：
 * - gemini-3.5-flash-lite：模型页 input 1,048,576 / output 65,536；思考档
 *   minimal/low/medium/high（默认 minimal，无 off），见
 *   https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite 与
 *   https://ai.google.dev/gemini-api/docs/thinking 的逐型号表。
 * - gemini-3.8-flash-high：网关精确 ID。官方无该后缀型号，规格（input
 *   1,048,576 / output 65,536；思考 low/medium/high，默认 medium，minimal
 *   会报错）继承基础型号 gemini-3.8-flash，实际别名路由未验证；不登记
 *   裸 ID gemini-3.8-flash，也不把 high 后缀当作固定思考档位。
 *   https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
 *   https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.8
 * - 3.5 Flash-Lite 与 3.8 起废弃采样参数（temperature/top_p/top_k 被忽略，
 *   未来版本报错）并改用 thinking_level 枚举，见
 *   https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.6。
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
			id: "gemini-3.5-flash-lite",
			name: "Gemini 3.5 Flash-Lite",
			// 2026-10-17：原生 Google 路由 404；此 Completions 路由文本/函数通过，
			// 默认工具选择下结果往返通过；显式 tool_choice:none 的结果轮曾超时。
			api: "openai-completions",
			baseUrl: `${root}/v1`,
			compat: OPENAI_COMPLETIONS_COMPAT,
			thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
			reasoning: true,
			input: ["text", "image"],
			// 标准层公开价（2026-10-17）：输入 $0.30、输出 $2.50（含思考）；
			// 缓存读取 $0.03，存储 $1/1M tokens/小时按小时计费，无法映射为单价，置 0。
			cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 65536,
		},
		{
			id: "gemini-3.8-flash-high",
			name: "Gemini 3.8 Flash",
			api: "google-generative-ai",
			// 宿主指定 baseUrl 时不追加版本路径；此路由已通过文本/工具往返。
			baseUrl: `${gemini}/v1beta`,
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" },
			reasoning: true,
			input: ["text", "image"],
			// 网关精确 ID，规格与价格继承官方基础型号 gemini-3.8-flash（别名路由
			// 未验证）。标准层介绍价：输入 $0.75、输出 $3.75（含思考）、缓存读取
			// $0.075，优惠截止 2026-12-31；2027-01-01 起为 $1.50/$7.50/$0.15。
			// 缓存存储 $0.50/1M tokens/小时（介绍价）按小时计费，无法映射为单价，置 0。
			cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
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

// 3.5 Flash 支持 MINIMAL/LOW/MEDIUM/HIGH，不使用词元预算。
function applyGemini35Flash(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	const thinkingLevel = level === "off" || level === "minimal" ? "MINIMAL"
		: level === "low" ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH";
	writer.setGoogleThinking({ includeThoughts: level !== "off", thinkingLevel }, ["thinkingBudget"]);
}

// 3.5 Flash-Lite 官方档位同为 minimal/low/medium/high 且默认 minimal，无 off：
// 网关 Completions 使用 reasoning_effort；off 就近 minimal，xhigh/max 收敛 high。
function applyGemini35FlashLite(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("thinking");
	const effort = level === "off" ? "minimal" : level === "xhigh" || level === "max" ? "high" : level;
	writer.set("reasoning_effort", effort);
}

// 3.8 Flash 仅支持 low/medium/high（minimal 会报错，无 off）；off/minimal
// 就近落到 LOW，xhigh/max 收敛到 HIGH；后缀 high 不锁定档位。
function applyGemini38Flash(writer: PayloadWriter, level: ThinkingLevel): void {
	applyGeminiPro(writer, level);
}

export const geminiThinking: Record<string, ThinkingApplier> = {
	"gemini-flash": (w, c) => applyGeminiFlash(w, c.thinkingLevel),
	"gemini-3.5-flash": (w, c) => applyGemini35Flash(w, c.thinkingLevel),
	"gemini-3.5-flash-low": (w, c) => applyGemini35Flash(w, c.thinkingLevel),
	"gemini-3.5-flash-extra-low": (w, c) => applyGemini35Flash(w, c.thinkingLevel),
	"gemini-3.5-flash-lite": (w, c) => applyGemini35FlashLite(w, c.thinkingLevel),
	"gemini-pro": (w, c) => applyGeminiPro(w, c.thinkingLevel),
	"gemini-3.8-flash-high": (w, c) => applyGemini38Flash(w, c.thinkingLevel),
};
