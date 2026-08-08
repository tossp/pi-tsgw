/**
 * 网络模块：内置查询（built-in web search）工具注入。
 *
 * 与模型模块平行、互不依赖：这里只维护"哪些模型支持内置查询"及注入
 * 格式，不读取模型目录数据。支持的模型：GPT 系列（OpenAI Responses
 * 协议）与 Grok 系列（xAI，工具名同为 `web_search`，见
 * https://docs.x.ai/developers/tools/web-search）。Grok 的协议端点与
 * 注入参数待其模型加入目录后按网关实际行为确认。
 */

import {
	isPlainObject,
	PayloadWriter,
	type WebSearchMode,
} from "../models/_tools.ts";

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

export interface WebSearchContext {
	modelId: string;
	api: string;
	mode: WebSearchMode;
}

/**
 * Append-only web_search tool injection for models with built-in search.
 * Non-plain payloads and unsupported models are returned unchanged.
 *
 * `cached` uses `external_web_access: false`; `live` uses `true`. Existing
 * function tools, `tool_choice`, and `include` are preserved. Pi drops
 * requested sources, so this operation deliberately does not request them.
 */
export function applyWebSearchTool(
	payload: unknown,
	context: WebSearchContext,
): unknown {
	if (!isPlainObject(payload) || context.mode === "off") return payload;
	if (
		context.api !== OPENAI_RESPONSES ||
		!BUILTIN_SEARCH_MODELS.has(context.modelId)
	)
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
			external_web_access: context.mode === "live",
		},
	]);
	return writer.result();
}
