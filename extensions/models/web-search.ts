/**
 * 内置查询注入（Built-in web search tool injection）。
 *
 * 对原生支持内置查询的模型（GPT Responses / Grok），在请求改写阶段把
 * 搜索参数追加进请求。属于模型请求改写的一部分，与思维链策略一起在
 * `before_provider_request` 中应用。
 *
 * - GPT（openai-responses）：追加 `tools: [{ type: "web_search", ... }]`
 * - Grok（openai-completions）：追加 `search_parameters: { mode: "on" }`
 *   （xAI 文档：https://docs.x.ai/developers/tools/web-search）
 *
 * 名单外主模型通过 tsgw_search 调用目录内支持模型；注入逻辑保持共用。
 */

import {
	isPlainObject,
	type Payload,
	PayloadWriter,
	type WebSearchMode,
} from "./_tools.ts";

const OPENAI_RESPONSES = "openai-responses";
const OPENAI_COMPLETIONS = "openai-completions";

// 支持内置查询的模型名单（GPT Responses 系列）。
const BUILTIN_SEARCH_MODELS = new Set([
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
]);

// 支持内置查询的 Grok 系列（openai-completions 协议，search_parameters 模式）。
const GROK_SEARCH_MODELS = new Set([
	"grok-4.20",
	"grok-4.5",
	"grok-4.3-low",
	"grok-4.3-medium",
	"grok-4.3-high",
	"grok-4.20-fast",
]);

/** Exact model/protocol support, shared by request injection and display code. */
export function builtinSearchSupport(
	modelId: string,
	api: string,
): "gpt" | "grok" | undefined {
	if (api === OPENAI_RESPONSES && BUILTIN_SEARCH_MODELS.has(modelId))
		return "gpt";
	if (api === OPENAI_COMPLETIONS && GROK_SEARCH_MODELS.has(modelId))
		return "grok";
	return undefined;
}

/** 内置联网搜索代理：主模型不支持原生联网时的代理执行模型。 */
export interface SearchDelegate {
	modelId: string;
	/** 代理协议族；请求和响应处理复用宿主 adapter。 */
	kind: "gpt" | "grok";
}

// 搜索任务优先 Luna；其余仅在优先候选不在生效目录时依序候补。
const DELEGATE_PREFERENCE = [
	"gpt-6-luna",
	"gpt-6-sol",
	"gpt-6.1-sol",
	"gpt-6-astra",
	"grok-4.20",
	"grok-4.20-fast",
	"grok-4.3-low",
	"grok-4.3-medium",
	"grok-4.3-high",
	"grok-4.5",
] as const;

/**
 * Resolve the search-proxy model from the effective (three-layer filtered)
 * catalog, with Luna first and a fixed fallback preference order. Delegates still have to
 * pass `builtinSearchSupport`, so the exact-ID + protocol contract stays the
 * single source of truth. Returns undefined when no supporting model remains.
 */
export function resolveSearchDelegate(
	models: ReadonlyArray<{ id: string; api?: string }>,
): SearchDelegate | undefined {
	for (const id of DELEGATE_PREFERENCE) {
		const model = models.find((candidate) => candidate.id === id);
		if (!model) continue;
		const kind = builtinSearchSupport(model.id, model.api ?? "");
		if (kind) return { modelId: model.id, kind };
	}
	return undefined;
}

function isExistingWebSearchTool(tools: readonly unknown[]): boolean {
	return tools.some((tool) => {
		if (!isPlainObject(tool) || typeof tool.type !== "string") return false;
		return tool.type === "web_search" || tool.type.startsWith("web_search_");
	});
}

function hasGrokSearchFields(payload: Payload): boolean {
	return (
		Object.hasOwn(payload, "search_parameters") ||
		Object.hasOwn(payload, "web_search_options")
	);
}

function applyGptSearch(writer: PayloadWriter, mode: WebSearchMode): void {
	const tools = writer.get("tools");
	if (tools !== undefined && !Array.isArray(tools)) return;
	const currentTools = tools ?? [];
	if (isExistingWebSearchTool(currentTools)) return;
	writer.set("tools", [
		...currentTools,
		{
			type: "web_search",
			search_context_size: "medium",
			external_web_access: mode === "live",
		},
	]);
}

function applyGrokSearch(writer: PayloadWriter): void {
	if (hasGrokSearchFields(writer.result())) return;
	writer.set("search_parameters", { mode: "on" });
}

/**
 * Append-only built-in search injection for models with native search.
 * Non-plain payloads and unsupported models are returned
 * unchanged. Existing function tools, `tool_choice`, and `include` are
 * preserved. Sources are not requested: this conservative policy originated
 * with Pi 0.82.0; source rendering on newer hosts needs separate validation.
 */
export function applyBuiltinSearchTool<T>(
	payload: T,
	modelId: string,
	api: string,
	mode: WebSearchMode,
): T | Payload {
	if (!isPlainObject(payload)) return payload;
	const writer = new PayloadWriter(payload);
	const support = builtinSearchSupport(modelId, api);

	if (support === "gpt") {
		applyGptSearch(writer, mode);
		return writer.result();
	}
	if (support === "grok") {
		applyGrokSearch(writer);
		return writer.result();
	}
	return payload;
}
