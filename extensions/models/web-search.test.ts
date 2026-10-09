import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { applyBuiltinSearchTool } from "./web-search.ts";
import { isPlainObject, type Payload, type WebSearchMode } from "./_tools.ts";

const OPENAI_RESPONSES = "openai-responses";

function apply(
	payload: unknown,
	modelId: string,
	mode: WebSearchMode,
): Payload {
	const result = applyBuiltinSearchTool(
		payload,
		modelId,
		OPENAI_RESPONSES,
		mode,
	);
	if (!isPlainObject(result)) throw new Error("expected a plain object result");
	return result;
}

function testBuiltinSearchInjection(): void {
	const functionTool = { type: "function", name: "keep" };
	for (const mode of ["cached", "live"] as const) {
		const input = {
			tools: [functionTool],
			tool_choice: "auto",
			include: ["reasoning.encrypted_content"],
			store: false,
		};
		const result = apply(input, "gpt-6-astra", mode);
		const tools = result.tools as unknown[];
		equal(tools.length, 2);
		strictEqual(tools[0], functionTool);
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

function testGpt6SearchInjection(): void {
	for (const modelId of ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"]) {
		for (const mode of ["cached", "live"] as const) {
			const input = { tools: [functionTool], tool_choice: "auto" };
			const result = apply(input, modelId, mode);
			deepStrictEqual(result.tools, [functionTool, {
				type: "web_search",
				search_context_size: "medium",
				external_web_access: mode === "live",
			}]);
			strictEqual(result.tool_choice, "auto");
			strictEqual(apply(result, modelId, mode), result);
			deepStrictEqual(input.tools, [functionTool]);
		}
	}
}

function testNoOpsAndScope(): void {
	// 非内置查询名单内的模型不注入。
	const nonSearch = { tools: [functionTool] };
	strictEqual(
		applyBuiltinSearchTool(
			nonSearch,
			"gpt-5.6-k3",
			OPENAI_RESPONSES,
			"live",
		),
		nonSearch,
	);

	// 非 Responses 协议不注入。
	strictEqual(
		applyBuiltinSearchTool(
			nonSearch,
			"gpt-5.6-sol",
			"openai-completions",
			"live",
		),
		nonSearch,
	);

	// 非 plain 对象原样返回。
	const nonPlain = [null, [], new Date()] as const;
	for (const payload of nonPlain)
		strictEqual(
			applyBuiltinSearchTool(payload, "gpt-5.6-sol", OPENAI_RESPONSES, "live"),
			payload,
		);
}

function testGrokSearchInjection(): void {
	// Grok（openai-completions）注入 search_parameters: { mode: "on" }。
	for (const modelId of [
		"grok-4.20",
		"grok-4.5",
		"grok-4.3-low",
		"grok-4.3-medium",
		"grok-4.3-high",
		"grok-4.20-fast",
	]) {
		const result = applyBuiltinSearchTool(
			{ messages: [{ role: "user", content: "hi" }] },
			modelId,
			"openai-completions",
			"cached",
		);
		if (!isPlainObject(result)) throw new Error("expected plain object");
		deepStrictEqual((result as Payload).search_parameters, { mode: "on" });
	}

	// 两种 GPT 会话模式下 Grok 均固定实时，保留现有搜索字段。
	for (const mode of ["cached", "live"] as const) {
		deepStrictEqual(applyBuiltinSearchTool({}, "grok-4.20", "openai-completions", mode),
			{ search_parameters: { mode: "on" } });
		for (const input of [{ search_parameters: { mode: "off" } }, { web_search_options: {} }]) {
			Object.freeze(input);
			strictEqual(applyBuiltinSearchTool(input, "grok-4.20", "openai-completions", mode), input);
		}
	}

	// 已有 search_parameters 不重复注入。
	const existing = { search_parameters: { mode: "off" } };
	strictEqual(
		applyBuiltinSearchTool(existing, "grok-4.20", "openai-completions", "live"),
		existing,
	);
}

const functionTool = { type: "function", name: "keep" };

testBuiltinSearchInjection();
testGpt6SearchInjection();
testNoOpsAndScope();
testGrokSearchInjection();
console.log("web-search.test.ts: all assertions passed");
