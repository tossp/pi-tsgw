/**
 * Narrow, declarative request-body operations for the AIH model aliases.
 *
 * This module deliberately does not implement a general JSON patch language:
 * every mutation below is an explicitly named, model-specific operation.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WebSearchMode = "off" | "cached" | "live";

export interface ModelOperationContext {
	provider: string;
	modelId: string;
	api: string;
	thinkingLevel: ThinkingLevel;
	webSearchMode: WebSearchMode;
}

type Payload = Record<string, unknown>;
type GoogleThinkingField = "includeThoughts" | "thinkingLevel" | "thinkingBudget";
type ThinkingUpdate = Partial<Pick<Payload, "type" | "clear_thinking">>;
type GoogleThinkingUpdate = Partial<Pick<Payload, GoogleThinkingField>>;

const AIH_PROVIDER = "aih";
const OPENAI_COMPLETIONS = "openai-completions";
const OPENAI_RESPONSES = "openai-responses";
const GOOGLE_GENERATIVE_AI = "google-generative-ai";

const WEB_SEARCH_MODELS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
const THINKING_FIELDS = ["type", "clear_thinking"] as const;
const GOOGLE_THINKING_FIELDS = ["includeThoughts", "thinkingLevel", "thinkingBudget"] as const;

export function webSearchModeFromEnv(value: string | undefined): WebSearchMode {
	return value === "cached" || value === "live" ? value : "off";
}

export function isPlainObject(value: unknown): value is Payload {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Copy the top level and nested objects only when a declared operation changes them. */
class PayloadWriter {
	private copy: Payload | undefined;

	constructor(private readonly payload: Payload) {}

	get(key: string): unknown {
		return (this.copy ?? this.payload)[key];
	}

	set(key: string, value: unknown): void {
		if (Object.is(this.get(key), value)) return;
		this.mutable()[key] = value;
	}

	remove(key: string): void {
		if (!Object.prototype.hasOwnProperty.call(this.copy ?? this.payload, key)) return;
		delete this.mutable()[key];
	}

	setThinking(values: ThinkingUpdate): void {
		const current = this.get("thinking");
		const thinking = isPlainObject(current) ? current : {};
		const changed = !isPlainObject(current) || THINKING_FIELDS.some((key) => key in values && !Object.is(thinking[key], values[key]));
		if (changed) this.set("thinking", { ...thinking, ...values });
	}

	setGoogleThinking(values: GoogleThinkingUpdate, remove: readonly GoogleThinkingField[] = []): void {
		const currentConfig = this.get("config");
		if (currentConfig !== undefined && !isPlainObject(currentConfig)) return;

		const config = isPlainObject(currentConfig) ? currentConfig : {};
		const currentThinking = config.thinkingConfig;
		const thinking = isPlainObject(currentThinking) ? currentThinking : {};
		const valuesChanged = !isPlainObject(currentThinking) || GOOGLE_THINKING_FIELDS.some((key) => key in values && !Object.is(thinking[key], values[key]));
		const removeChanged = remove.some((key) => Object.prototype.hasOwnProperty.call(thinking, key));
		if (!valuesChanged && !removeChanged) return;

		const nextThinking = { ...thinking, ...values };
		for (const key of remove) delete nextThinking[key];
		this.set("config", { ...config, thinkingConfig: nextThinking });
	}

	setTextVerbosity(verbosity: "low" | "medium"): void {
		const current = this.get("text");
		if (current !== undefined && !isPlainObject(current)) return;
		const text = isPlainObject(current) ? current : {};
		if (text.verbosity === verbosity) return;
		this.set("text", { ...text, verbosity });
	}

	result(): Payload {
		return this.copy ?? this.payload;
	}

	private mutable(): Payload {
		this.copy ??= { ...this.payload };
		return this.copy;
	}
}

function isAtLeastHigh(level: ThinkingLevel): boolean {
	return level === "high" || level === "xhigh" || level === "max";
}

function isMaximum(level: ThinkingLevel): boolean {
	return level === "xhigh" || level === "max";
}

function applyDeepSeek(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	if (level === "off") {
		writer.setThinking({ type: "disabled" });
		return;
	}
	writer.setThinking({ type: "enabled" });
	writer.set("reasoning_effort", isMaximum(level) ? "max" : "high");
}

function applyGlm(writer: PayloadWriter, level: ThinkingLevel): void {
	if (writer.get("stream") === true) writer.set("tool_stream", true);
	if (level === "off") {
		writer.setThinking({ type: "disabled" });
		writer.set("reasoning_effort", "none");
		return;
	}

	writer.setThinking({ type: "enabled" });
	if (level === "high" || isMaximum(level)) {
		writer.setThinking({ clear_thinking: false });
		writer.set("reasoning_effort", isMaximum(level) ? "max" : "high");
	}
}

function applyEnabledThinking(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.setThinking({ type: level === "off" ? "disabled" : "enabled" });
}

function applyMiniMax(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("reasoning_split", true);
	writer.setThinking({ type: level === "off" ? "disabled" : "adaptive" });
}

function applyKimiK3(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("thinking");
	if (level === "off") {
		writer.remove("reasoning_effort");
		return;
	}
	if (level === "minimal" || level === "low") {
		writer.set("reasoning_effort", "low");
		return;
	}
	writer.set("reasoning_effort", level === "max" ? "max" : "high");
}

function applyLongCat(writer: PayloadWriter, level: ThinkingLevel): void {
	// OC/AIH compatibility policy: LongCat's public HTTP thinking schema is unverified.
	applyEnabledThinking(writer, level);
}

function applyQwen(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("enable_search", true);
	writer.set("parallel_tool_calls", true);
	if (level === "off") {
		writer.set("enable_thinking", false);
		writer.set("preserve_thinking", false);
		writer.remove("thinking_budget");
		writer.remove("search_options");
		writer.remove("enable_code_interpreter");
		return;
	}

	writer.set("enable_thinking", true);
	writer.set("preserve_thinking", true);
	if (isAtLeastHigh(level)) {
		writer.set("thinking_budget", 6000);
		writer.set("search_options", { search_strategy: "agent_max" });
		writer.set("enable_code_interpreter", true);
		return;
	}
	writer.remove("thinking_budget");
	writer.remove("search_options");
	writer.remove("enable_code_interpreter");
}

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

function applyOpenAIResponses(writer: PayloadWriter, modelId: string): void {
	const verbosity = modelId === "gpt-5.6-terra" ? "medium" : "low";
	writer.set("service_tier", "flex");
	writer.setTextVerbosity(verbosity);
}

function applyThinkingProfile(writer: PayloadWriter, context: ModelOperationContext): void {
	const { api, modelId, thinkingLevel } = context;
	if (api === OPENAI_COMPLETIONS) {
		switch (modelId) {
			case "deepseek-v4-flash":
			case "deepseek-v4-pro":
				applyDeepSeek(writer, thinkingLevel);
				return;
			case "glm-5.2":
			case "glm-5.1":
				applyGlm(writer, thinkingLevel);
				return;
			case "mimo-v2.5":
			case "mimo-v2.5-pro":
			case "kimi-for-coding":
				applyEnabledThinking(writer, thinkingLevel);
				return;
			case "minimax-m3":
				applyMiniMax(writer, thinkingLevel);
				return;
			case "kimi-k3":
				applyKimiK3(writer, thinkingLevel);
				return;
			case "longcat-2.0":
				applyLongCat(writer, thinkingLevel);
				return;
			case "qwen3.7-plus":
			case "qwen3.7-max":
				applyQwen(writer, thinkingLevel);
				return;
		}
	}
	if (api === GOOGLE_GENERATIVE_AI) {
		if (modelId === "gemini-flash") applyGeminiFlash(writer, thinkingLevel);
		if (modelId === "gemini-pro") applyGeminiPro(writer, thinkingLevel);
		return;
	}
	if (api === OPENAI_RESPONSES && isOpenAIResponsesModel(modelId)) applyOpenAIResponses(writer, modelId);
}

function isOpenAIResponsesModel(modelId: string): boolean {
	return modelId === "gpt-5.6-sol" || modelId === "gpt-5.6-terra" || modelId === "gpt-5.6-luna" || modelId === "gpt-5.5" || modelId === "gpt-5.3-codex-spark";
}

function isExistingWebSearchTool(tools: readonly unknown[]): boolean {
	return tools.some((tool) => {
		if (!isPlainObject(tool) || typeof tool.type !== "string") return false;
		return tool.type === "web_search" || tool.type.startsWith("web_search_");
	});
}

function applyWebSearch(writer: PayloadWriter, context: ModelOperationContext): void {
	if (context.webSearchMode === "off" || context.api !== OPENAI_RESPONSES || !WEB_SEARCH_MODELS.has(context.modelId)) return;
	const tools = writer.get("tools");
	if (tools !== undefined && !Array.isArray(tools)) return;
	const currentTools = tools ?? [];
	if (isExistingWebSearchTool(currentTools)) return;
	writer.set("tools", [
		...currentTools,
		{ type: "web_search", search_context_size: "medium", external_web_access: context.webSearchMode === "live" },
	]);
}

/**
 * Apply the closed set of AIH request operations without mutating `payload`.
 * Non-plain payloads and all non-AIH requests are returned unchanged.
 */
export function applyModelOperations(payload: unknown, context: ModelOperationContext): unknown {
	if (!isPlainObject(payload) || context.provider !== AIH_PROVIDER) return payload;
	const writer = new PayloadWriter(payload);
	applyThinkingProfile(writer, context);
	applyWebSearch(writer, context);
	return writer.result();
}
