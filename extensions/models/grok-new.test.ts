import { deepStrictEqual, equal, strictEqual } from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyModelOperations } from "./operations.ts";
import { grokModels } from "./vendors/grok.ts";
import { builtinSearchSupport, resolveSearchDelegate } from "./web-search.ts";
import type { Payload, ThinkingLevel } from "./_tools.ts";

const root = "https://gateway.invalid";
const config = grokModels(root).find(model => model.id === "grok-4.7")!;
equal(config.api, "openai-responses");
equal(config.baseUrl, `${root}/v1`);
equal(config.contextWindow, 500000);
equal(config.maxTokens, 500000);
deepStrictEqual(config.input, ["text", "image"]);
deepStrictEqual(config.cost, { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 });
deepStrictEqual(config.thinkingLevelMap, {
	off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh",
});
function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
}
function apply(payload: Payload, thinkingLevel: ThinkingLevel): Payload {
	return applyModelOperations(payload, {
		provider: "tsgw", modelId: config.id, api: config.api!, thinkingLevel, tsSearchMode: "live",
	}) as Payload;
}
for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
	const input = {
		reasoning: { effort: "none", summary: "auto", retained: true }, reasoning_effort: "none",
		thinking: { type: "disabled" }, include: ["reasoning.encrypted_content"],
		input: [{ role: "user", content: "test" }], tools: [{ type: "function", name: "probe" }],
		store: false, max_output_tokens: 512,
	};
	const before = structuredClone(input);
	freeze(input);
	const result = apply(input, level);
	deepStrictEqual(input, before);
	deepStrictEqual(result.reasoning, { effort: ["off", "minimal"].includes(level) ? "low" : level === "max" ? "xhigh" : level, summary: "auto", retained: true });
	equal(Object.hasOwn(result, "reasoning_effort"), false);
	equal(Object.hasOwn(result, "thinking"), false);
	strictEqual(result.input, input.input);
	strictEqual(result.tools, input.tools);
	strictEqual(result.include, input.include);
	equal(result.max_output_tokens, 512);
	equal(result.store, false);
	strictEqual(apply(result, level), result);
}
// 网关实测只通过文本，未证明原生联网；不能因官方支持或 HTTP 200 激活搜索。
for (const api of ["openai-responses", "openai-completions"]) {
	equal(builtinSearchSupport(config.id, api), undefined);
	equal(resolveSearchDelegate([{ id: config.id, api }]), undefined);
}

// 真宿主认证与 Responses 适配器，受控 HTTP 夹具；不访问生产或个人配置。
const runtime = await ModelRuntime.create({
	credentials: {
		read: async provider => provider === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
		list: async () => [], modify: async () => undefined, delete: async () => {},
	},
	modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
});
runtime.registerProvider("tsgw", { models: [config] });
const model = runtime.getModel("tsgw", config.id)!;
let requests = 0;
const fetched: Record<string, unknown>[] = [];
const events = (output: Record<string, unknown>[], completed: unknown[]) => {
	const all = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		...output,
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: completed,
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
	];
	return new Response(all.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
};
const fakeFetch: typeof fetch = async (url, init) => {
	const request = new Request(url, init);
	equal(request.url, `${root}/v1/responses`);
	equal(request.headers.get("authorization"), "Bearer fixture-key");
	fetched.push(await request.json() as Record<string, unknown>);
	requests++;
	if (requests === 1) {
		const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "encrypted-fixture" };
		const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "probe", arguments: '{"value":"PING"}', status: "completed" };
		return events([
			{ type: "response.output_item.added", output_index: 0, item: reasoning },
			{ type: "response.output_item.done", output_index: 0, item: reasoning },
			{ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
			{ type: "response.function_call_arguments.delta", output_index: 1, delta: call.arguments },
			{ type: "response.output_item.done", output_index: 1, item: call },
		], [reasoning, call]);
	}
	const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
	return events([
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
		{ type: "response.output_item.done", output_index: 0, item },
	], [item]);
};
const context = {
	messages: [{ role: "user" as const, content: "Call probe.", timestamp: 0 }],
	tools: [{ name: "probe", description: "验收函数", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
};
const options = { reasoning: "low" as const, maxTokens: 512, maxRetries: 0, fetch: fakeFetch,
	onPayload: (payload: unknown) => apply(payload as Payload, "low") };
const first = await runtime.streamSimple(model, context, options).result();
equal(first.stopReason, "toolUse");
const call = first.content.find(part => part.type === "toolCall")!;
equal(call.name, "probe");
deepStrictEqual(call.arguments, { value: "PING" });
const second = await runtime.streamSimple(model, { ...context, messages: [...context.messages, first, {
	role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "OK" }], isError: false, timestamp: 1,
}] }, options).result();
equal(second.stopReason, "stop");
deepStrictEqual(second.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
const replay = fetched[1]!.input as Record<string, unknown>[];
equal(replay.some(item => item.type === "reasoning" && item.encrypted_content === "encrypted-fixture"), true);
equal(replay.some(item => item.type === "function_call_output" && item.output === "OK"), true);
equal(requests, 2);
console.log("grok-new.test.ts：档位、过滤及宿主 encrypted reasoning 工具回放夹具通过（不代表真实端点工具可用）");
