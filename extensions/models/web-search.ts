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
 * 独立的 ts_search 工具（所有模型可用）单独实现，与内置查询注入分离。
 */

import { isPlainObject, PayloadWriter, type WebSearchMode } from "./_tools.ts";

const OPENAI_RESPONSES = "openai-responses";
const OPENAI_COMPLETIONS = "openai-completions";

// 支持内置查询的模型名单（GPT Responses 系列）。
const BUILTIN_SEARCH_MODELS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
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

function isExistingWebSearchTool(tools: readonly unknown[]): boolean {
	return tools.some((tool) => {
		if (!isPlainObject(tool) || typeof tool.type !== "string") return false;
		return tool.type === "web_search" || tool.type.startsWith("web_search_");
	});
}

function hasGrokSearchFields(payload: Record<string, unknown>): boolean {
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
 * Non-plain payloads, `off` mode, and unsupported models are returned
 * unchanged. Existing function tools, `tool_choice`, and `include` are
 * preserved. Pi drops requested sources, so GPT injection deliberately does
 * not request them.
 */
export function applyBuiltinSearchTool(
	payload: unknown,
	modelId: string,
	api: string,
	mode: WebSearchMode,
): unknown {
	if (!isPlainObject(payload) || mode === "off") return payload;
	const writer = new PayloadWriter(payload);

	if (api === OPENAI_RESPONSES && BUILTIN_SEARCH_MODELS.has(modelId)) {
		applyGptSearch(writer, mode);
		return writer.result();
	}
	if (api === OPENAI_COMPLETIONS && GROK_SEARCH_MODELS.has(modelId)) {
		applyGrokSearch(writer);
		return writer.result();
	}
	return payload;
}
