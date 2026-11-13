import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { cleanupSessionResources, type Context } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { anthropicModels } from "./vendors/anthropic.ts";
import { minimaxModels } from "./vendors/minimax.ts";

const root = "https://gateway.invalid";
type Config = ReturnType<typeof anthropicModels>[number];
interface RequestBody {
	model: string;
	messages: { role: string; content: unknown }[];
	system?: unknown;
	tools?: unknown;
	thread?: { type: string; previous_message_id?: string };
}

// 仅替换 HTTP；模型登记、请求转换、续接判断与协议回退均使用真实 SDK。
async function fixture(config: Config) {
	const runtime = await ModelRuntime.create({
		credentials: {
			read: async provider => provider === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
			list: async () => [], modify: async () => undefined, delete: async () => {},
		},
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	runtime.registerProvider("tsgw", { models: [config] });
	const model = runtime.getModel("tsgw", config.id)!;
	const sessionId = randomUUID();
	const requests: RequestBody[] = [];
	const headers: Headers[] = [];
	const context: Context = {
		systemPrompt: "仅用于隔离的线程测试。",
		messages: [{ role: "user", content: "调用 probe。", timestamp: 0 }],
		tools: [{ name: "probe", description: "测试工具", parameters: { type: "object", properties: {} } }],
	};
	function events(id: string, tool: boolean): Response {
		const block = tool
			? { type: "tool_use", id: "call_probe", name: "probe", input: {} }
			: { type: "text", text: "OK" };
		const all = [
			{ type: "message_start", message: { id, type: "message", role: "assistant", model: config.id,
				content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: block },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		];
		return new Response(all.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	}
	let rejectThreads = false;
	let expireContinuation = false;
	let toolReply = true;
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const request = new Request(url, init);
		const endpoint = new URL(request.url);
		assert.equal(`${endpoint.origin}${endpoint.pathname}`, `${root}/v1/messages`);
		assert.equal(request.headers.get("x-api-key"), "fixture-key");
		const body = await request.json() as RequestBody;
		requests.push(body);
		headers.push(request.headers);
		if (rejectThreads && body.thread) {
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "thread: Extra inputs are not permitted" } }, { status: 400 });
		}
		if (expireContinuation && body.thread?.type === "continue") {
			return Response.json({ type: "error", error: { type: "invalid_request_error", message: "Thread expired", details: { error_code: "thread_not_found" } } }, { status: 400 });
		}
		return events(`msg_${requests.length}`, toolReply);
	};
	return { context, requests, headers, sessionId,
		rejectThreads: () => { rejectThreads = true; toolReply = false; },
		expireContinuation: () => { expireContinuation = true; },
		textReply: () => { toolReply = false; },
		run: (next = context, cacheRetention: "short" | "none" = "short") => runtime.streamSimple(model, next, {
			sessionId, cacheRetention, reasoning: "high", maxTokens: 512, maxRetries: 0, fetch,
		}).result(),
	};
}

for (const config of anthropicModels(root)) {
	test(`${config.id}：创建线程、增量工具回传、设置变化重建与关闭缓存`, async t => {
		const f = await fixture(config);
		t.after(() => cleanupSessionResources(f.sessionId));
		const first = await f.run();
		assert.equal(first.stopReason, "toolUse", first.errorMessage ?? "首轮未返回工具调用");
		assert.deepEqual(f.requests[0]!.thread, { type: "create" });
		assert.ok(f.requests[0]!.system);
		assert.ok(f.requests[0]!.tools);
		assert.match(f.headers[0]!.get("anthropic-beta")!, /message-threads-/);
		const call = first.content.find(part => part.type === "toolCall")!;
		const continued: Context = { ...f.context, messages: [...f.context.messages, first, {
			role: "toolResult", toolCallId: call.id, toolName: call.name,
			content: [{ type: "text", text: "PONG" }], isError: false, timestamp: 1,
		}] };
		f.textReply();
		const second = await f.run(continued);
		assert.equal(second.stopReason, "stop", second.errorMessage ?? "线程续接失败");
		const body = f.requests[1]!;
		assert.deepEqual(body.thread, { type: "continue", previous_message_id: first.responseId });
		assert.equal(body.system, undefined);
		assert.equal(body.tools, undefined);
		assert.equal(body.messages.length, 1, "续接只传新工具结果，不重复传历史");
		assert.match(JSON.stringify(body.messages), /tool_result/);
		assert.match(JSON.stringify(body.messages), /PONG/);
		const changed: Context = { ...continued, systemPrompt: "系统提示已变化。", messages: [...continued.messages, second,
			{ role: "user", content: "继续。", timestamp: 2 }] };
		const third = await f.run(changed);
		assert.equal(third.stopReason, "stop", third.errorMessage ?? "上下文变化后重建线程失败");
		assert.deepEqual(f.requests[2]!.thread, { type: "create" });
		assert.ok(f.requests[2]!.system);
		assert.ok(f.requests[2]!.tools);
		assert.ok(f.requests[2]!.messages.length > 1);
		assert.equal((await f.run(changed, "none")).stopReason, "stop");
		assert.equal(f.requests[3]!.thread, undefined);
		assert.equal(f.requests.length, 4);
	});
}

test("Claude 端点明确拒绝线程：完整补发一次，当前会话后续不再尝试线程", async t => {
	const f = await fixture(anthropicModels(root)[0]!);
	t.after(() => cleanupSessionResources(f.sessionId));
	f.rejectThreads();
	const first = await f.run();
	assert.equal(first.stopReason, "stop", first.errorMessage ?? "线程不支持时回退失败");
	assert.deepEqual(f.requests[0]!.thread, { type: "create" });
	assert.equal(f.requests[1]!.thread, undefined);
	assert.deepEqual(f.requests[1]!.messages, f.requests[0]!.messages);
	assert.deepEqual(f.requests[1]!.system, f.requests[0]!.system);
	assert.deepEqual(f.requests[1]!.tools, f.requests[0]!.tools);
	assert.equal((await f.run()).stopReason, "stop");
	assert.equal(f.requests[2]!.thread, undefined);
	assert.equal(f.requests.length, 3, "协议回退不依赖通用 maxRetries，也不应重复尝试已拒绝的线程");
});

test("Claude 续接时线程失效：只重建一次，并恢复完整历史与 system/tools", async t => {
	const f = await fixture(anthropicModels(root)[0]!);
	t.after(() => cleanupSessionResources(f.sessionId));
	f.textReply();
	const first = await f.run();
	assert.equal(first.stopReason, "stop");
	f.expireContinuation();
	const result = await f.run({ ...f.context, messages: [...f.context.messages, first,
		{ role: "user", content: "这是新问题。", timestamp: 1 }] });
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "线程失效后重建失败");
	assert.deepEqual(f.requests[1]!.thread, { type: "continue", previous_message_id: first.responseId });
	assert.equal(f.requests[1]!.messages.length, 1);
	assert.equal(f.requests[1]!.system, undefined);
	assert.equal(f.requests[1]!.tools, undefined);
	const rebuilt = f.requests[2]!;
	assert.deepEqual(rebuilt.thread, { type: "create" });
	assert.deepEqual(rebuilt.messages.map(message => message.role), ["user", "assistant", "user"]);
	assert.match(JSON.stringify(rebuilt.messages), /调用 probe。/);
	assert.match(JSON.stringify(rebuilt.messages), /这是新问题。/);
	assert.deepEqual(rebuilt.system, f.requests[0]!.system);
	assert.deepEqual(rebuilt.tools, f.requests[0]!.tools);
	assert.equal(f.requests.length, 3, "失效续接仅以完整上下文补发一次");
});

test("MiniMax 复用 Anthropic 协议但不启用 Claude 线程", async t => {
	const f = await fixture(minimaxModels(root)[0]!);
	t.after(() => cleanupSessionResources(f.sessionId));
	f.textReply();
	const result = await f.run();
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "MiniMax 请求失败");
	assert.equal(f.requests[0]!.thread, undefined);
	assert.doesNotMatch(f.headers[0]!.get("anthropic-beta") ?? "", /message-threads-/);
});
