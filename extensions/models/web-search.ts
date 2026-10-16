/**
 * 内置网页搜索工具注入。
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

/** 精确判定模型/协议支持性，由请求注入与展示代码共用。 */
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
	/** 代理协议族；请求和响应处理复用宿主适配器。 */
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
 * 从生效目录（三层过滤后）中选择搜索代理模型，优先使用 Luna，
 * 其余候选按固定优先级回退。代理模型仍须通过 `builtinSearchSupport` 检查，
 * 因此精确 ID 与协议契约仍是唯一判定依据。
 * 没有剩余的支持模型时返回 undefined。
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
 * 对支持原生搜索的模型，仅以追加方式注入内置搜索。
 * 非普通对象的请求体与不受支持的模型均原样返回。
 * 保留现有函数工具、`tool_choice` 和 `include`。
 * 不请求来源：这一保守策略始于 Pi 0.82.0；
 * 较新宿主上的来源渲染需要单独验证。
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
