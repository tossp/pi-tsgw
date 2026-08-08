/**
 * 内置查询注入（Built-in web search tool injection）。
 *
 * 对原生支持内置查询的模型（GPT Responses / Grok，工具名 `web_search`），
 * 在请求改写阶段把该工具追加进工具集。属于模型请求改写的一部分，
 * 与思维链策略一起在 `before_provider_request` 中应用。
 *
 * 独立的 ts_search 工具（所有模型可用）单独实现，与内置查询注入分离。
 */

import {
	isPlainObject,
	PayloadWriter,
	type WebSearchMode,
} from "./_tools.ts";

const OPENAI_RESPONSES = "openai-responses";

// 支持内置查询的模型名单。Grok 系列工具格式已确认（`web_search`），
// 待其协议端点确认后加入。
const BUILTIN_SEARCH_MODELS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
]);

function isExistingWebSearchTool(tools: readonly unknown[]): boolean {
	return tools.some((tool) => {
		if (!isPlainObject(tool) || typeof tool.type !== "string") return false;
		return tool.type === "web_search" || tool.type.startsWith("web_search_");
	});
}

/**
 * Append-only web_search tool injection for models with built-in search.
 * Non-plain payloads and unsupported models are returned unchanged.
 *
 * `cached` uses `external_web_access: false`; `live` uses `true`. Existing
 * function tools, `tool_choice`, and `include` are preserved. Pi drops
 * requested sources, so this operation deliberately does not request them.
 */
export function applyBuiltinSearchTool(
	payload: unknown,
	modelId: string,
	api: string,
	mode: WebSearchMode,
): unknown {
	if (!isPlainObject(payload) || mode === "off") return payload;
	if (api !== OPENAI_RESPONSES || !BUILTIN_SEARCH_MODELS.has(modelId))
		return payload;
	const writer = new PayloadWriter(payload);
	const tools = writer.get("tools");
	if (tools !== undefined && !Array.isArray(tools)) return payload;
	const currentTools = tools ?? [];
	if (isExistingWebSearchTool(currentTools)) return payload;
	writer.set("tools", [
		...currentTools,
		{
			type: "web_search",
			search_context_size: "medium",
			external_web_access: mode === "live",
		},
	]);
	return writer.result();
}
