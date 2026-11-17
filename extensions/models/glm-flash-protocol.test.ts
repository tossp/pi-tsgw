import assert from "node:assert/strict";
import test from "node:test";
import type { Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyModelOperations } from "./operations.ts";
import type { Payload, ThinkingLevel } from "./_tools.ts";
import { glmModels } from "./vendors/glm.ts";

const root = "https://gateway.invalid";
const config = glmModels(root).find(model => model.id === "glm-5.3-flash")!;
const cases = [
	["off", "low"], ["minimal", "low"], ["low", "low"],
	["medium", "high"], ["high", "high"], ["xhigh", "max"], ["max", "max"],
] as const;

function apply(payload: Payload, thinkingLevel: ThinkingLevel): Payload {
	return applyModelOperations(payload, {
		provider: "tsgw", modelId: config.id, api: config.api!, thinkingLevel, tsSearchMode: "live",
	}) as Payload;
}

test("GLM Flash：Anthropic 档位、移除 Chat 字段及写时复制", () => {
	assert.equal(config.api, "anthropic-messages");
	assert.equal(config.baseUrl, root);
	assert.equal(config.thinkingLevelMap?.off, null);
	for (const [level, effort] of cases) {
		const messages = Object.freeze([{ role: "user", content: "保留原消息" }]);
		const tools = Object.freeze([{ name: "probe", input_schema: { type: "object" } }]);
		const format = Object.freeze({ type: "json_schema" });
		const output = Object.freeze({ effort: "none", format });
		const thinking = Object.freeze({ type: "disabled", retained: true });
		const input = Object.freeze({
			messages, tools, thinking, output_config: output,
			reasoning_effort: "none", tool_stream: true, stream: true, max_tokens: 512,
		});
		const result = apply(input, level);
		assert.deepEqual(result.thinking, { type: "adaptive", retained: true });
		assert.deepEqual(result.output_config, { effort, format });
		assert.equal(result.messages, messages);
		assert.equal(result.tools, tools);
		assert.equal((result.output_config as Payload).format, format);
		assert.equal(result.max_tokens, 512);
		assert.equal(result.stream, true);
		assert.equal(Object.hasOwn(result, "reasoning_effort"), false);
		assert.equal(Object.hasOwn(result, "tool_stream"), false);
		assert.equal(input.thinking.type, "disabled");
		assert.equal(input.output_config.effort, "none");
		assert.equal(apply(result, level), result);
	}
	const stable = { effort: "high", retained: true };
	assert.equal(apply({ output_config: stable }, "high").output_config, stable);
	assert.deepEqual(apply({}, "off"), { thinking: { type: "adaptive" }, output_config: { effort: "low" } });
});

// 只替换 HTTP；路径、鉴权、图片、思考块和工具回传使用宿主真实适配器。
async function fixture() {
	const runtime = await ModelRuntime.create({
		credentials: {
			read: async provider => provider === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
			list: async () => [], modify: async () => undefined, delete: async () => {},
		},
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	runtime.registerProvider("tsgw", { models: [config] });
	const model = runtime.getModel("tsgw", config.id)!;
	const requests: Payload[] = [];
	let fetchError: unknown;
	function events(tool: boolean): Response {
		const blocks: Payload[] = tool ? [
			{ type: "thinking", thinking: "先调用工具确认", signature: "" },
			{ type: "tool_use", id: "call_probe", name: "probe", input: {} },
		] : [{ type: "text", text: "OK" }];
		const all = [
			{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: config.id,
				content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			...blocks.flatMap((block, index) => [
				{ type: "content_block_start", index, content_block: block },
				{ type: "content_block_stop", index },
			]),
			{ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		];
		return new Response(all.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	}
	const fetch: typeof globalThis.fetch = async (url, init) => {
		try {
			const request = new Request(url, init);
			const endpoint = new URL(request.url);
			assert.equal(`${endpoint.origin}${endpoint.pathname}`, `${root}/v1/messages`);
			assert.equal(request.headers.get("x-api-key"), "fixture-key");
			const body = await request.json() as Payload;
			requests.push(body);
			assert.equal(body.model, config.id);
			assert.equal(body.max_tokens, 512);
			assert.equal((body.thinking as Payload).type, "adaptive");
			for (const key of ["budget_tokens", "clear_thinking"]) assert.equal(Object.hasOwn(body.thinking!, key), false);
			assert.equal(Object.hasOwn(body, "reasoning_effort"), false);
			assert.equal(Object.hasOwn(body, "tool_stream"), false);
			return events(requests.length === 1);
		} catch (error) {
			fetchError = error;
			throw error;
		}
	};
	const context: Context = {
		messages: [{ role: "user", content: [
			{ type: "text", text: "检查图片并调用 probe。" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		], timestamp: 0 }],
		tools: [{ name: "probe", description: "测试工具", parameters: { type: "object", properties: {} } }],
	};
	return { context, requests,
		run: async (level: ThinkingLevel, next = context) => {
			const result = await runtime.streamSimple(model, next, {
				reasoning: level === "off" ? undefined : level, maxTokens: 512, maxRetries: 0, cacheRetention: "none", fetch,
				onPayload: payload => apply(payload as Payload, level),
			}).result();
			if (fetchError) throw fetchError;
			return result;
		},
	};
}

test("GLM Flash：宿主 Messages 路径、图片、无签名 thinking 与工具续轮", async () => {
	const f = await fixture();
	const first = await f.run("high");
	assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "首轮工具调用失败");
	const call = first.content.find(part => part.type === "toolCall")!;
	assert.equal(call.name, "probe");
	assert.equal(first.content.find(part => part.type === "thinking")?.thinking, "先调用工具确认");
	const second = await f.run("high", { ...f.context, messages: [...f.context.messages, first, {
		role: "toolResult", toolCallId: call.id, toolName: call.name,
		content: [{ type: "text", text: "PONG" }], isError: false, timestamp: 1,
	}] });
	assert.equal(second.stopReason, "stop", second.errorMessage ?? "工具续轮失败");
	assert.deepEqual(second.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
	const replay = f.requests[1]!.messages as { role: string; content: Payload[] }[];
	assert.deepEqual(replay[0]!.content.find(part => part.type === "image"), {
		type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" },
	});
	const assistant = replay.find(message => message.role === "assistant")!;
	assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "先调用工具确认", signature: "" });
	assert.equal(assistant.content[1]!.type, "tool_use");
	assert.ok(replay.some(message => message.content.some(block => block.type === "tool_result" && block.tool_use_id === call.id)));
	for (const [level, effort] of cases) {
		const result = await f.run(level);
		assert.equal(result.stopReason, "stop", result.errorMessage ?? "档位请求失败");
		assert.deepEqual(f.requests.at(-1)!.output_config, { effort });
	}
	assert.equal(f.requests.length, 9);
});
