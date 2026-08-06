/**
 * 网络模块：内置查询（built-in web search）工具注入。
 *
 * 与模型模块平行、互不依赖：这里只维护"哪些模型支持内置查询"及注入
 * 格式，不读取模型目录数据。支持的模型：GPT 系列（OpenAI Responses
 * 协议）与 Grok 系列（xAI）。
 */

import { isPlainObject, PayloadWriter, type WebSearchMode } from "../models/_tools.ts";

const OPENAI_RESPONSES = "openai-responses";

// 支持内置查询的模型名单。Grok 系列的注入格式待 xAI 文档确认后补充。
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
export function applyWebSearchTool(payload: unknown, context: WebSearchContext): unknown {
	if (!isPlainObject(payload) || context.mode === "off") return payload;
	if (context.api !== OPENAI_RESPONSES || !BUILTIN_SEARCH_MODELS.has(context.modelId)) return payload;
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
