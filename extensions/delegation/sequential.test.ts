import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { deepseekModels } from "#tsgw/models/vendors/deepseek";
import { glmModels } from "#tsgw/models/vendors/glm";
import { hunyuanModels } from "#tsgw/models/vendors/hunyuan";
import { registerDelegation } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
type AnyRecord = Record<string, any>;
const USAGE: Usage = { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 } };
const IDS = ["hy4-flash", "deepseek-flash", "glm-5.3-flash"] as const;
type SelectionId = (typeof IDS)[number];
function model(id: SelectionId): Model<Api> {
	const source = id === "hy4-flash" ? hunyuanModels("https://models.example.test/v1") :
		id === "deepseek-flash" ? deepseekModels("https://models.example.test/v1") : glmModels("https://models.example.test/v1");
	return { ...source.find(item => item.id === id)!, provider: "tsgw" } as Model<Api>;
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
function waitTurn() { return new Promise(resolve => setImmediate(resolve)); }
function selectedText(context: Context, preferredModel = "hy4-flash"): string {
	const material = JSON.parse(String(context.messages[0]?.content)) as AnyRecord;
	const criteria = material.questions.selection.criteria as Record<string, string>;
	const key = Object.entries(criteria).find(([candidateKey, description]) =>
		candidateKey !== "unresolved" && description.includes(preferredModel))?.[0];
	assert.ok(key, `本次候选中应有 ${preferredModel}`);
	return JSON.stringify({ kind: "implement", selection: key });
}
function reply(id: string, text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", api: id === "hy4-flash" ? "openai-completions" : id === "glm-5.3-flash" ? "anthropic-messages" : "openai-responses",
		provider: "tsgw", model: id, content: [{ type: "text", text }], stopReason: "stop", usage: USAGE, timestamp: 0, ...overrides };
}
class Registry {
	models: Model<Api>[] = IDS.map(model);
	requests: Array<{ model: Model<Api>; context: Context; options: SimpleStreamOptions }> = [];
	implementations = new Map<string, (context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>>();
	async getAvailableOfType(type: string) { return type === "chat" ? [...this.models] : []; }
	streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
		this.requests.push({ model, context, options });
		const implementation = this.implementations.get(model.id);
		return { result: () => implementation ? implementation(context, options) :
			Promise.resolve(reply(model.id, selectedText(context, model.id))) };
	}
}
class TestPi {
	private readonly handlers = new Map<string, Handler[]>();
	on(name: string, handler: Handler) { const list = this.handlers.get(name) ?? []; list.push(handler); this.handlers.set(name, list); return () => {}; }
	getActiveTools = () => ["Agent"];
	getAllTools = () => [{ name: "Agent", parameters: { type: "object", properties: {
		prompt: { type: "string" }, model: { type: "string" }, resume: { type: "string" },
	} } }];
	async emit(name: string, event: unknown, ctx?: unknown) { let result: any; for (const handler of this.handlers.get(name) ?? []) result = await handler(event, ctx); return result; }
}
async function harness(registry = new Registry(), options: { signal?: AbortSignal; scopedModels?: unknown[] } = {}) {
	const pi = new TestPi();
	registerDelegation(pi as unknown as ExtensionAPI);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	const ctx = { modelRegistry: registry, scopedModels: options.scopedModels ?? [], signal: options.signal } as unknown as ExtensionContext;
	const event = { type: "tool_call", toolCallId: "selection", toolName: "Agent", input: { prompt: "范围明确的代码任务" } } as unknown as ToolCallEvent;
	return { pi, registry, ctx, event };
}
function assertStartOrder(registry: Registry, ids: string[]) {
	assert.deepEqual(registry.requests.map(request => request.model.id), ids);
}

test("混元首路成功后不启动 DeepSeek 或 GLM；请求一次且使用 Chat Completions 约束", async () => {
	const { pi, registry, ctx, event } = await harness();
	assert.equal(await pi.emit("tool_call", event, ctx), undefined);
	assert.equal((event.input as AnyRecord).model, "tsgw/hy4-flash:high");
	assertStartOrder(registry, ["hy4-flash"]);
	const { options, model: selected } = registry.requests[0]!;
	assert.equal(options.maxRetries, 0);
	assert.ok(options.timeoutMs! > 0 && options.timeoutMs! <= 7_000);
	const body = options.onPayload!({ model: selected.id, messages: [] }, selected) as AnyRecord;
	assert.equal(body.reasoning_effort, "no_think");
	assert.equal(body.response_format.type, "json_schema");
	assert.equal(body.response_format.json_schema.strict, true);
	assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties).sort(), ["kind", "selection"]);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("混元失败后 DeepSeek 与 GLM 并发；首个有效结果生效并取消败路", async () => {
	const { pi, registry, ctx, event } = await harness();
	const primary = deferred<AssistantMessage>();
	const deepseek = deferred<AssistantMessage>();
	const glm = deferred<AssistantMessage>();
	registry.implementations.set("hy4-flash", () => primary.promise);
	registry.implementations.set("deepseek-flash", () => deepseek.promise);
	registry.implementations.set("glm-5.3-flash", () => glm.promise);
	const pending = pi.emit("tool_call", event, ctx);
	await waitTurn();
	assertStartOrder(registry, ["hy4-flash"]);
	assert.equal(registry.requests[0]!.options.timeoutMs, 7_000);
	primary.resolve(reply("hy4-flash", "", { stopReason: "error", errorMessage: "HTTP 503 primary secret" }));
	await waitTurn();
	await waitTurn();
	assertStartOrder(registry, [...IDS]);
	const deepOptions = registry.requests[1]!.options;
	const glmOptions = registry.requests[2]!.options;
	assert.equal(deepOptions.maxRetries, 0);
	assert.equal(glmOptions.maxRetries, 0);
	assert.ok(deepOptions.timeoutMs! > 0 && deepOptions.timeoutMs! <= 15_000);
	assert.equal(deepOptions.reasoning, "low");
	const deepBody = deepOptions.onPayload!({ model: "deepseek-flash", messages: [] }, registry.requests[1]!.model) as AnyRecord;
	assert.equal(deepBody.text.format.type, "json_schema");
	assert.equal(deepBody.text.format.strict, true);
	assert.deepEqual(Object.keys(deepBody.text.format.schema.properties).sort(), ["kind", "selection"]);
	assert.equal(glmOptions.reasoning, "low");
	const glmBody = glmOptions.onPayload!({ model: "glm-5.3-flash", messages: [] }, registry.requests[2]!.model) as AnyRecord;
	assert.deepEqual(glmBody.thinking, { type: "adaptive" });
	assert.equal(glmBody.output_config.effort, "low");
	assert.equal(glmBody.response_format, undefined);
	assert.equal(glmBody.text, undefined);
	deepseek.resolve(reply("deepseek-flash", selectedText(registry.requests[1]!.context, "deepseek-flash")));
	assert.equal(await pending, undefined);
	assert.equal((event.input as AnyRecord).model, "tsgw/deepseek-flash:max");
	assert.equal(registry.requests[2]!.options.signal?.aborted, true);
	glm.resolve(reply("glm-5.3-flash", selectedText(registry.requests[2]!.context)));
	await waitTurn();
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("混元缺席时直接并发启动两个后备；DeepSeek 胜出后不等待 GLM", async () => {
	const { pi, registry, ctx, event } = await harness();
	registry.models = registry.models.filter(item => item.id !== "hy4-flash");
	const glm = deferred<AssistantMessage>();
	registry.implementations.set("glm-5.3-flash", () => glm.promise);
	assert.equal(await pi.emit("tool_call", event, ctx), undefined);
	assertStartOrder(registry, ["deepseek-flash", "glm-5.3-flash"]);
	assert.equal((event.input as AnyRecord).model, "tsgw/deepseek-flash:max");
	assert.equal(registry.requests[1]!.options.signal?.aborted, true);
	glm.resolve(reply("glm-5.3-flash", "{}"));
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("真实触发 7 秒 AbortSignal 后切换；混元忽略 signal 的迟到成功不能覆盖后备胜者", async () => {
	const originalNow = Date.now;
	const originalTimeout = AbortSignal.timeout;
	let now = 0;
	const primaryTimeout = new AbortController();
	Date.now = () => now;
	AbortSignal.timeout = ((ms: number) => ms === 7_000 ? primaryTimeout.signal : originalTimeout(ms)) as typeof AbortSignal.timeout;
	try {
		const { pi, registry, ctx, event } = await harness();
		const primary = deferred<AssistantMessage>();
		const deepseek = deferred<AssistantMessage>();
		const glm = deferred<AssistantMessage>();
		registry.implementations.set("hy4-flash", () => primary.promise);
		registry.implementations.set("deepseek-flash", () => deepseek.promise);
		registry.implementations.set("glm-5.3-flash", () => glm.promise);
		const pending = pi.emit("tool_call", event, ctx);
		await waitTurn();
		assertStartOrder(registry, ["hy4-flash"]);
		assert.ok(registry.requests[0]!.options.timeoutMs! <= 7_000);
		now = 7_000;
		primaryTimeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		await waitTurn();
		await waitTurn();
		assertStartOrder(registry, [...IDS]);
		for (const request of registry.requests.slice(1)) assert.ok(request.options.timeoutMs! > 0 && request.options.timeoutMs! <= 8_000);
		deepseek.resolve(reply("deepseek-flash", selectedText(registry.requests[1]!.context, "deepseek-flash")));
		assert.equal(await pending, undefined);
		assert.equal((event.input as AnyRecord).model, "tsgw/deepseek-flash:max");
		primary.resolve(reply("hy4-flash", selectedText(registry.requests[0]!.context, "hy4-flash")));
		glm.resolve(reply("glm-5.3-flash", selectedText(registry.requests[2]!.context, "deepseek-flash")));
		await waitTurn();
		assert.equal((event.input as AnyRecord).model, "tsgw/deepseek-flash:max");
		await pi.emit("session_shutdown", { type: "session_shutdown" });
	} finally {
		Date.now = originalNow;
		AbortSignal.timeout = originalTimeout;
	}
});

test("整体取消时不启动后备；忽略 signal 的迟到混元成功不可采纳", async () => {
	const controller = new AbortController();
	const { pi, registry, ctx, event } = await harness(new Registry(), { signal: controller.signal });
	const primary = deferred<AssistantMessage>();
	registry.implementations.set("hy4-flash", () => primary.promise);
	const pending = pi.emit("tool_call", event, ctx);
	await waitTurn();
	controller.abort(new Error("caller cancelled"));
	assert.equal((await pending).block, true);
	assertStartOrder(registry, ["hy4-flash"]);
	primary.resolve(reply("hy4-flash", selectedText(registry.requests[0]!.context)));
	await waitTurn();
	assert.equal((event.input as AnyRecord).model, undefined);
	assertStartOrder(registry, ["hy4-flash"]);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("两路后备均失败时安全汇总已发起通道错误且不写入 model", async () => {
	const { pi, registry, ctx, event } = await harness();
	registry.implementations.set("hy4-flash", async () => reply("hy4-flash", "", { stopReason: "error", errorMessage: "HTTP 500 primary-secret" }));
	registry.implementations.set("deepseek-flash", async () => reply("deepseek-flash", "", { stopReason: "error", errorMessage: "HTTP 429 secondary-secret" }));
	registry.implementations.set("glm-5.3-flash", async () => reply("glm-5.3-flash", "", { stopReason: "error", errorMessage: "HTTP 503 glm-secret" }));
	assert.equal((await pi.emit("tool_call", event, ctx)).block, true);
	assertStartOrder(registry, [...IDS]);
	assert.equal((event.input as AnyRecord).model, undefined);
	const final = await pi.emit("message_end", { message: { role: "toolResult", toolCallId: "selection", toolName: "Agent", content: [], isError: true } });
	const serialized = JSON.stringify(final);
	assert.match(serialized, /HTTP 500/);
	assert.match(serialized, /HTTP 429/);
	assert.match(serialized, /HTTP 503/);
	assert.doesNotMatch(serialized, /primary-secret|secondary-secret|glm-secret/);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("选定候选仍受宿主目录与会话 scope 约束", async () => {
	const allowed = model("deepseek-flash");
	const { pi, registry, ctx, event } = await harness(new Registry(), { scopedModels: [{ model: allowed }] });
	registry.implementations.set("hy4-flash", async () => reply("hy4-flash", selectedText(registry.requests[0]!.context, "deepseek-flash")));
	assert.equal(await pi.emit("tool_call", event, ctx), undefined);
	assert.equal((event.input as AnyRecord).model, "tsgw/deepseek-flash:max");
	assert.equal(registry.requests.length, 1, "混元只负责选型，不受输出模型 scope 限制");
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});
