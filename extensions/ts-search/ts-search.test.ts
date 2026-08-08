import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { applyWebSearchTool } from "./ts-search.ts";
import {
	isPlainObject,
	type Payload,
	type WebSearchMode,
} from "../models/_tools.ts";

const OPENAI_RESPONSES = "openai-responses";

function apply(
	payload: unknown,
	modelId: string,
	mode: WebSearchMode,
): Payload {
	const result = applyWebSearchTool(payload, {
		modelId,
		api: OPENAI_RESPONSES,
		mode,
	});
	if (!isPlainObject(result)) throw new Error("expected a plain object result");
	return result;
}

function testBuiltinSearchInjection(): void {
	const functionTool = { type: "function", name: "keep" };
	for (const mode of ["off", "cached", "live"] as const) {
		const input = {
			tools: [functionTool],
			tool_choice: "auto",
			include: ["reasoning.encrypted_content"],
			store: false,
		};
		const result = apply(input, "gpt-5.6-sol", mode);
		const tools = result.tools as unknown[];
		equal(tools.length, mode === "off" ? 1 : 2);
		strictEqual(tools[0], functionTool);
		if (mode !== "off")
			deepStrictEqual(tools[1], {
				type: "web_search",
				search_context_size: "medium",
				external_web_access: mode === "live",
			});
		deepStrictEqual(result.tool_choice, "auto");
		deepStrictEqual(result.include, ["reasoning.encrypted_content"]);
		strictEqual(result.store, false);
	}

	for (const type of [
		"web_search",
		"web_search_preview",
		"web_search_custom",
	]) {
		const existing = { type };
		const result = apply({ tools: [existing] }, "gpt-5.6-terra", "live");
		strictEqual((result.tools as unknown[])[0], existing);
		equal((result.tools as unknown[]).length, 1);
	}

	const undefinedTools = apply({}, "gpt-5.6-luna", "cached");
	deepStrictEqual(undefinedTools.tools, [
		{
			type: "web_search",
			search_context_size: "medium",
			external_web_access: false,
		},
	]);
	const invalidTools = apply({ tools: null }, "gpt-5.5", "live");
	strictEqual(invalidTools.tools, null);
}

function testNoOpsAndScope(): void {
	// 非内置查询名单内的模型不注入。
	const nonSearch = { tools: [functionTool] };
	strictEqual(
		applyWebSearchTool(nonSearch, {
			modelId: "gpt-5.3-codex-spark",
			api: OPENAI_RESPONSES,
			mode: "live",
		}),
		nonSearch,
	);

	// 非 Responses 协议不注入。
	strictEqual(
		applyWebSearchTool(nonSearch, {
			modelId: "gpt-5.6-sol",
			api: "openai-completions",
			mode: "live",
		}),
		nonSearch,
	);

	// 非 plain 对象原样返回。
	const nonPlain = [null, [], new Date()] as const;
	for (const payload of nonPlain)
		strictEqual(
			applyWebSearchTool(payload, {
				modelId: "gpt-5.6-sol",
				api: OPENAI_RESPONSES,
				mode: "live",
			}),
			payload,
		);
}

const functionTool = { type: "function", name: "keep" };

testBuiltinSearchInjection();
testNoOpsAndScope();
console.log("ts-search.test.ts: all assertions passed");
