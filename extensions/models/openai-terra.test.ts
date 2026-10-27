import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { effectiveModelsForGateway } from "./catalog.ts";
import { applyModelOperations } from "./operations.ts";
import { openaiModels, openaiThinking } from "./vendors/openai.ts";
import { builtinSearchSupport, resolveSearchDelegate } from "./web-search.ts";
import type { Payload, ThinkingLevel } from "./_tools.ts";

const root = "https://gateway.invalid";
const id = "gpt-6.1-terra";
const config = openaiModels(root).find(model => model.id === id)!;
ok(config);
equal(config.api, "openai-responses");
equal(config.baseUrl, `${root}/v1`);
equal(config.reasoning, true);
equal(config.contextWindow, 1050000);
equal(config.maxTokens, 128000);
deepStrictEqual(config.input, ["text", "image"]);
deepStrictEqual(config.cost, { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 });
deepStrictEqual(config.thinkingLevelMap, {
	off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
});
// 厂商策略覆盖当前聊天目录；不引入新图片型号。
deepStrictEqual(Object.keys(openaiThinking).sort(), openaiModels(root).map(model => model.id).sort());
for (const gatewayIds of [undefined, new Set<string>(), new Set(["gpt-6.1-terra-extra"])]) {
	equal(effectiveModelsForGateway(root, undefined, gatewayIds, false, false).some(model => model.id === id), false);
}
for (const gatewayId of [id, `openai/${id}`]) {
	deepStrictEqual(effectiveModelsForGateway(root, undefined, new Set([gatewayId]), false, false), [config]);
}
deepStrictEqual(effectiveModelsForGateway(root, { exclude: [id] }, new Set([id]), false, false), []);
deepStrictEqual(effectiveModelsForGateway(root, { exclude: ["gpt-*"], include: [id] }, new Set([id]), false, false), [config]);
// include 不能绕过网关交集。
deepStrictEqual(effectiveModelsForGateway(root, { include: [id] }, new Set(), false, false), []);

function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
}
function apply(payload: Payload, thinkingLevel: ThinkingLevel): Payload {
	return applyModelOperations(payload, {
		provider: "tsgw", modelId: id, api: config.api!, thinkingLevel, tsSearchMode: "live",
	}) as Payload;
}
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
for (const level of levels) {
	const input = {
		model: id, input: [{ role: "user", content: "保持" }],
		reasoning: { effort: "high", summary: "auto", retained: true },
		text: { format: { type: "text" }, verbosity: "high" },
		tools: [{ type: "function", name: "probe" }], include: ["reasoning.encrypted_content"],
		store: false, max_output_tokens: 512, parallel_tool_calls: false, prompt_cache_key: "keep",
	};
	const before = structuredClone(input);
	freeze(input);
	const result = apply(input, level);
	deepStrictEqual(input, before);
	deepStrictEqual(result, { ...input, text: { ...input.text, verbosity: "low" } });
	strictEqual(result.reasoning, input.reasoning);
	strictEqual(result.input, input.input);
	strictEqual(result.tools, input.tools);
	strictEqual(result.include, input.include);
	strictEqual((result.text as Payload).format, input.text.format);
	strictEqual(apply(result, level), result);
	strictEqual(applyModelOperations(input, {
		provider: "other", modelId: id, api: config.api!, thinkingLevel: level, tsSearchMode: "live",
	}), input);
}
// 官方支持不等于网关原生搜索已验收：本批不自动启用搜索或搜索代理。
for (const api of ["openai-responses", "openai-completions"]) {
	equal(builtinSearchSupport(id, api), undefined);
	equal(resolveSearchDelegate([{ id, api }]), undefined);
}

// 真实宿主 Responses adapter + 隔离 HTTP 夹具；不访问网关或个人凭据。
const runtime = await ModelRuntime.create({
	credentials: {
		read: async provider => provider === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
		list: async () => [], modify: async () => undefined, delete: async () => {},
	},
	modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
});
runtime.registerProvider("tsgw", { models: [config] });
const model = runtime.getModel("tsgw", id)!;
deepStrictEqual(getSupportedThinkingLevels(model), levels);
const requests: Record<string, unknown>[] = [];
function events(output: Record<string, unknown>[], completed: unknown[]): Response {
	const all = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		...output,
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: completed,
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
	];
	return new Response(all.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
let returnTool = false;
const fakeFetch: typeof fetch = async (url, init) => {
	const request = new Request(url, init);
	equal(request.url, `${root}/v1/responses`);
	equal(request.headers.get("authorization"), "Bearer fixture-key");
	requests.push(await request.json() as Record<string, unknown>);
	if (returnTool) {
		const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-encrypted" };
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
	messages: [{ role: "user" as const, content: "调用 probe。", timestamp: 0 }],
	tools: [{ name: "probe", description: "隔离测试函数", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
};
for (const level of levels) {
	const result = await runtime.streamSimple(model, context, {
		reasoning: level === "off" ? undefined : level, maxTokens: 512, maxRetries: 0, fetch: fakeFetch,
		onPayload: payload => apply(payload as Payload, level),
	}).result();
	equal(result.stopReason, "stop", result.errorMessage ?? id);
	deepStrictEqual(result.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
	const body = requests.at(-1)!;
	equal(body.model, id);
	equal((body.reasoning as Payload).effort, config.thinkingLevelMap![level]);
	equal((body.text as Payload).verbosity, "low");
	equal(body.max_output_tokens, 512);
	equal((body.tools as unknown[]).length, 1);
	equal(Object.hasOwn(body, "service_tier"), false);
}
returnTool = true;
const options = { reasoning: "medium" as const, maxTokens: 512, maxRetries: 0, fetch: fakeFetch,
	onPayload: (payload: unknown) => apply(payload as Payload, "medium") };
const first = await runtime.streamSimple(model, context, options).result();
equal(first.stopReason, "toolUse", first.errorMessage ?? id);
const call = first.content.find(part => part.type === "toolCall")!;
equal(call.name, "probe");
deepStrictEqual(call.arguments, { value: "PING" });
returnTool = false;
const second = await runtime.streamSimple(model, { ...context, messages: [...context.messages, first, {
	role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "OK" }], isError: false, timestamp: 1,
}] }, options).result();
equal(second.stopReason, "stop", second.errorMessage ?? id);
deepStrictEqual(second.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
const replay = requests.at(-1)!.input as Record<string, unknown>[];
equal(replay.some(item => item.type === "reasoning" && item.encrypted_content === "fixture-encrypted"), true);
equal(replay.some(item => item.type === "function_call_output" && item.output === "OK"), true);
equal(requests.length, levels.length + 2);
console.log("openai-terra.test.ts：目录过滤、七档请求与 Responses 工具回放夹具通过（非真实网关验收）");
