import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { DELEGATION_KNOWLEDGE } from "../delegation/knowledge.ts";
import { buildDelegationCandidates } from "../delegation/policy.ts";
import { effectiveModelsForGateway } from "./catalog.ts";
import { applyModelOperations } from "./operations.ts";
import { builtinSearchSupport, resolveSearchDelegate } from "./web-search.ts";
import { qwenModels } from "./vendors/qwen.ts";
import type { Payload, ThinkingLevel } from "./_tools.ts";

const root = "https://gateway.invalid";
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const cases = [
	{ id: "qwen3.8-flash", api: "openai-completions", efforts: ["none", "low", "low", "medium", "xhigh", "xhigh", "xhigh"] },
	{ id: "qwen4-max", api: "openai-responses", efforts: ["none", "low", "low", "high", "high", "xhigh", "xhigh"] },
] as const;
function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
}
function apply(payload: Payload, id: string, api: string, thinkingLevel: ThinkingLevel): Payload {
	return applyModelOperations(payload, { provider: "tsgw", modelId: id, api, thinkingLevel, tsSearchMode: "live" }) as Payload;
}

for (const entry of cases) {
	test(`${entry.id}：精确／渠道前缀交集与真实候选装配`, async () => {
		const config = qwenModels(root).find(model => model.id === entry.id)!;
		ok(config);
		for (const gatewayId of [entry.id, `auto/${entry.id}`]) {
			deepStrictEqual(effectiveModelsForGateway(root, undefined, new Set([gatewayId]), false, false), [config]);
		}
		for (const ids of [undefined, new Set<string>(), new Set([`${entry.id}-extra`])]) {
			equal(effectiveModelsForGateway(root, { include: [entry.id] }, ids, false, false).length, 0);
		}
		const runtime = await fixtureRuntime();
		const model = runtime.getModel("tsgw", entry.id)!;
		deepStrictEqual(getSupportedThinkingLevels(model), levels);
		const candidates = buildDelegationCandidates(DELEGATION_KNOWLEDGE, [model], getSupportedThinkingLevels);
		ok(candidates.some(candidate => candidate.id === entry.id));
	});

	test(`${entry.id}：请求改写不继承旧搜索与预算策略`, () => {
		for (const [index, level] of levels.entries()) {
			const input: Payload = {
				messages: [{ role: "user", content: "保持" }], tools: [{ type: "function", name: "probe" }],
				max_tokens: 512, parallel_tool_calls: false, temperature: 0.4,
				...(entry.api === "openai-completions"
					? { reasoning_effort: "high", thinking_budget: 6000 }
					: { reasoning: { effort: "high", summary: "auto" } }),
			};
			const before = structuredClone(input);
			freeze(input);
			const result = apply(input, entry.id, entry.api, level);
			deepStrictEqual(input, before);
			if (entry.api === "openai-completions") {
				const { thinking_budget: _budget, ...retained } = input;
				const expected: Payload = { ...retained, reasoning_effort: entry.efforts[index],
					enable_thinking: level !== "off", preserve_thinking: level !== "off" };
				deepStrictEqual(result, expected);
			} else {
				strictEqual(result, input, "Responses 参数由宿主生成，无需额外改写");
			}
			strictEqual(result.messages, input.messages);
			strictEqual(result.tools, input.tools);
			strictEqual(apply(result, entry.id, entry.api, level), result);
			for (const key of ["enable_search", "search_options", "enable_code_interpreter"]) equal(Object.hasOwn(result, key), false);
			strictEqual(applyModelOperations(input, { provider: "other", modelId: entry.id, api: entry.api,
				thinkingLevel: level, tsSearchMode: "live" }), input);
		}
		equal(builtinSearchSupport(entry.id, entry.api), undefined);
		equal(resolveSearchDelegate([entry]), undefined);
	});

	test(`${entry.id}：宿主图文、档位与思考回放工具往返夹具`, async () => {
		const runtime = await fixtureRuntime();
		const model = runtime.getModel("tsgw", entry.id)!;
		const requests: Payload[] = [];
		let returnTool = false;
		const fakeFetch: typeof fetch = async (url, init) => {
			const request = new Request(url, init);
			equal(request.url, `${root}/v1/${entry.api === "openai-completions" ? "chat/completions" : "responses"}`);
			equal(request.headers.get("authorization"), "Bearer fixture-key");
			requests.push(await request.json() as Payload);
			return entry.api === "openai-completions" ? chatEvents(returnTool) : responseEvents(returnTool);
		};
		const context = {
			messages: [{ role: "user" as const, timestamp: 0, content: [
				{ type: "text" as const, text: "查看图片并调用 probe。" },
				{ type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6F8sAAAAASUVORK5CYII=" },
			] }],
			tools: [{ name: "probe", description: "隔离夹具函数", parameters: {
				type: "object", properties: { value: { type: "string" } }, required: ["value"],
			} }],
		};
		for (const [index, level] of levels.entries()) {
			const result = await runtime.streamSimple(model, context, {
				reasoning: level === "off" ? undefined : level, maxTokens: 512, maxRetries: 0, fetch: fakeFetch,
				onPayload: payload => apply(payload as Payload, entry.id, entry.api, level),
			}).result();
			equal(result.stopReason, "stop", result.errorMessage ?? entry.id);
			const body = requests.at(-1)!;
			equal(body.model, entry.id);
			equal(entry.api === "openai-completions" ? body.reasoning_effort : (body.reasoning as Payload).effort, entry.efforts[index]);
			equal(entry.api === "openai-completions" ? body.max_completion_tokens : body.max_output_tokens, 512);
			if (entry.api === "openai-completions") {
				equal(body.enable_thinking, level !== "off");
				equal(body.preserve_thinking, level !== "off");
			}
			ok(JSON.stringify(body).includes(entry.api === "openai-completions" ? "image_url" : "input_image"));
			for (const key of ["enable_search", "enable_code_interpreter", "thinking_budget"]) equal(Object.hasOwn(body, key), false);
		}
		returnTool = true;
		const options = { reasoning: "low" as const, maxTokens: 512, maxRetries: 0, fetch: fakeFetch,
			onPayload: (payload: unknown) => apply(payload as Payload, entry.id, entry.api, "low") };
		const first = await runtime.streamSimple(model, context, options).result();
		equal(first.stopReason, "toolUse", first.errorMessage ?? entry.id);
		const call = first.content.find(part => part.type === "toolCall")!;
		equal(call.name, "probe");
		deepStrictEqual(call.arguments, { value: "PING" });
		returnTool = false;
		const second = await runtime.streamSimple(model, { ...context, messages: [...context.messages, first, {
			role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "OK" }], isError: false, timestamp: 1,
		}] }, options).result();
		equal(second.stopReason, "stop", second.errorMessage ?? entry.id);
		deepStrictEqual(second.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
		const replay = (requests.at(-1)![entry.api === "openai-completions" ? "messages" : "input"]) as Payload[];
		if (entry.api === "openai-completions") {
			ok(replay.some(item => item.role === "assistant" && item.reasoning_content === "fixture-thinking"));
			ok(replay.some(item => item.role === "tool" && item.content === "OK"));
		} else {
			ok(replay.some(item => item.type === "reasoning" && item.encrypted_content === "fixture-encrypted"));
			ok(replay.some(item => item.type === "function_call_output" && item.output === "OK"));
		}
		const cached = await runtime.streamSimple(model, context, {
			...options, cacheRetention: "long", sessionId: "qwen-cache-fixture",
		}).result();
		equal(cached.stopReason, "stop", cached.errorMessage ?? entry.id);
		const cachedBody = requests.at(-1)!;
		// 缓存关联键由宿主按协议决定；此处验证不注入未声明的 24h 参数。
		equal(Object.hasOwn(cachedBody, "prompt_cache_retention"), false);
		equal(Object.hasOwn(cachedBody, "prompt_cache_options"), false);
	});
}

async function fixtureRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: {
			read: async provider => provider === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
			list: async () => [], modify: async () => undefined, delete: async () => {},
		},
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	runtime.registerProvider("tsgw", { models: qwenModels(root) });
	return runtime;
}
function chatEvents(tool: boolean): Response {
	const chunks = tool ? [
		{ choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "fixture-thinking" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_fixture", type: "function",
			function: { name: "probe", arguments: '{"value":"PING"}' } }] }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
	] : [
		{ choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}
function responseEvents(tool: boolean): Response {
	const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-encrypted" };
	const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "probe", arguments: '{"value":"PING"}', status: "completed" };
	const message = { type: "message", id: "msg_fixture", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: "OK", annotations: [] }] };
	const output = tool ? [reasoning, call] : [message];
	const events = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		...output.flatMap((item, output_index) => [
			{ type: "response.output_item.added", output_index, item },
			{ type: "response.output_item.done", output_index, item },
		]),
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output,
			usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
