import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { deepseekModels } from "#tsgw/models/vendors/deepseek";
import { hunyuanModels } from "#tsgw/models/vendors/hunyuan";
import { registerDelegation } from "./index.ts";

type Handler = (event: any, ctx: any) => any;
type AnyRecord = Record<string, any>;
const USAGE: Usage = {
	input: 10, output: 4, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, reasoning: 2,
	totalTokens: 19, cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
};
function answer(context: Context): string {
	const material = JSON.parse(String(context.messages[0]?.content)) as AnyRecord;
	const criteria = material.questions.selection.criteria as Record<string, string>;
	const selection = Object.keys(criteria).find(key => key !== "unresolved");
	assert.ok(selection, "测试目录须提供有效候选");
	return JSON.stringify({ kind: "implement", selection });
}
function response(text: string): AssistantMessage {
	return { role: "assistant", api: "openai-completions", provider: "tsgw", model: "hy4-flash",
		content: [{ type: "text", text }], stopReason: "stop", usage: USAGE, timestamp: 0 };
}
function chatModel(id: "hy4-flash" | "deepseek-flash"): Model<Api> {
	const source = id === "hy4-flash" ? hunyuanModels("https://models.example.test/v1") : deepseekModels("https://models.example.test/v1");
	return { ...source.find(model => model.id === id)!, provider: "tsgw" } as Model<Api>;
}
class Registry {
	models: Model<Api>[] = [chatModel("hy4-flash"), chatModel("deepseek-flash")];
	requests: Array<{ model: Model<Api>; context: Context; options: SimpleStreamOptions }> = [];
	getAvailableCalls = 0;
	streamImpl: (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage> =
		async (model, context) => response(answer(context));
	async getAvailableOfType(type: string) {
		this.getAvailableCalls++;
		return type === "chat" ? [...this.models] : [];
	}
	streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
		this.requests.push({ model, context, options });
		return { result: () => this.streamImpl(model, context, options) };
	}
}
class TestPi {
	private readonly handlers = new Map<string, Handler[]>();
	constructor(readonly tools: unknown[] = [agentTool()]) {}
	on(event: string, handler: Handler): () => void {
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => {};
	}
	getActiveTools = () => ["Agent"];
	getAllTools = () => this.tools;
	async emit(event: string, payload: unknown, ctx?: unknown): Promise<any> {
		let result: any;
		for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}
}
function agentTool(overrides: AnyRecord = {}): AnyRecord {
	return { name: "Agent", description: "test Agent", exposure: "model-only", parameters: {
		type: "object", properties: { prompt: { type: "string" }, model: { type: "string" }, resume: { type: "string" } },
	}, ...overrides };
}
function context(registry: Registry, signal?: AbortSignal): ExtensionContext {
	return { modelRegistry: registry, scopedModels: [], signal } as unknown as ExtensionContext;
}
function call(id: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: id, toolName: "Agent", input } as unknown as ToolCallEvent;
}
async function harness(tools?: unknown[]): Promise<TestPi> {
	const pi = new TestPi(tools);
	registerDelegation(pi as unknown as ExtensionAPI);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	return pi;
}

test("新建 Agent 使用混元优先选型，保留宿主调用契约并记录一次用量", async () => {
	const registry = new Registry();
	const pi = await harness();
	const event = call("selected", { prompt: "局部实现", description: "保留参数", run_in_background: true });
	assert.equal(await pi.emit("tool_call", event, context(registry)), undefined);
	assert.equal((event.input as AnyRecord).model, "tsgw/hy4-flash:high");
	assert.deepEqual(registry.requests.map(request => request.model.id), ["hy4-flash"]);
	const request = registry.requests[0]!;
	assert.equal(request.options.maxRetries, 0);
	assert.ok(request.options.timeoutMs! > 0 && request.options.timeoutMs! <= 7_000);
	const original = { model: "hy4-flash", messages: [{ role: "user", content: "unchanged" }], metadata: { keep: true } };
	const snapshot = structuredClone(original);
	const payload = request.options.onPayload!(original, request.model) as AnyRecord;
	assert.deepEqual(original, snapshot, "payload hook 不修改宿主原对象");
	assert.equal(payload.response_format.type, "json_schema");
	assert.equal(payload.response_format.json_schema.name, "delegation_selection");
	assert.equal(payload.response_format.json_schema.strict, true);
	assert.deepEqual(Object.keys(payload.response_format.json_schema.schema.properties).sort(), ["kind", "selection"]);
	assert.equal(payload.reasoning_effort, "no_think");
	assert.equal(payload.tools, undefined);

	const result = await pi.emit("tool_result", {
		type: "tool_result", toolCallId: "selected", toolName: "Agent", input: {},
		content: [{ type: "text", text: "child result" }], isError: false,
		details: { kind: "host-result", marker: "keep" }, usage: USAGE,
	});
	assert.equal(result.details.kind, "host-result");
	assert.equal(result.details.marker, "keep");
	assert.deepEqual(result.details.tsgwDelegation.selectionSource, { type: "chat", model: "tsgw/hy4-flash" });
	assert.deepEqual(result.details.tsgwDelegation.chatModels, ["tsgw/hy4-flash"]);
	assert.equal(result.usage.totalTokens, USAGE.totalTokens * 2);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("显式 model/resume、非 Agent 与不兼容 Agent hook 契约不触发选择", async () => {
	const registry = new Registry();
	const pi = await harness();
	for (const event of [
		call("explicit", { prompt: "explicit", model: "tsgw/example:low" }),
		call("resume", { prompt: "resume", resume: "old-session" }),
		{ ...call("other", { prompt: "not Agent" }), toolName: "read" },
	]) assert.equal(await pi.emit("tool_call", event, context(registry)), undefined);
	const incompatible = await harness([agentTool({ parameters: { type: "object", properties: {
		prompt: { type: "string" }, model: { type: "number" }, resume: { type: "string" },
	} } })]);
	const skipped = call("schema", { prompt: "must not select" });
	assert.equal(await incompatible.emit("tool_call", skipped, context(registry)), undefined);
	assert.equal((skipped.input as AnyRecord).model, undefined);
	assert.equal(registry.requests.length, 0);
	assert.equal(registry.getAvailableCalls, 0);
});

test("Agent hook 保留调用字段、常驻提示分区与失败前取消约定", async () => {
	const registry = new Registry();
	const pi = await harness();
	const event = call("preserve", { prompt: "task", description: "description", input_files: ["fixture.ts"], run_in_background: true });
	await pi.emit("tool_call", event, context(registry));
	assert.deepEqual({ ...event.input as AnyRecord, model: undefined }, {
		prompt: "task", description: "description", input_files: ["fixture.ts"], run_in_background: true, model: undefined,
	});
	const sections: Record<string, string> = { host: "host text" };
	await pi.emit("before_agent_start", { systemPromptOptions: { sections } });
	assert.equal(sections.host, "host text");
	assert.match(sections.tsgw_delegation, /Agent/);
	assert.equal(sections.tsgw_delegation.includes("| tsgw/"), false);
	await pi.emit("session_shutdown", { type: "session_shutdown" });
	assert.equal(await pi.emit("before_agent_start", { systemPrompt: "after shutdown" }), undefined);
});
