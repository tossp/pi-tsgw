import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, ClassifierContext, ClassifierResult, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildDelegationCandidates } from "./policy.ts";
import { registerDelegation } from "./index.ts";

type Handler = (event: any, ctx?: any) => any;
const usage: Usage = {
	input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};
function chat(id: string): Model<Api> {
	return {
		id, name: id, provider: "tsgw", api: "openai-responses", baseUrl: "https://models.example.test/v1",
		input: ["text"], reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 32_000,
	};
}
function native(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return { api: "typesafe-system-one", provider: "tsgw", model: "jev-latest", answers: {},
		stopReason: "error", errorMessage: "分类请求失败（HTTP 402）。", timestamp: 0, usage, ...overrides };
}
function reply(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "tsgw", model: "gpt-6-luna",
		content: [{ type: "text", text }], stopReason: "stop", usage, timestamp: 0, ...overrides };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
class Registry {
	models = [chat("gpt-6-luna"), chat("deepseek-flash"), chat("gpt-6-astra")];
	classifiers: unknown[] = [{ type: "classifier", id: "jev-latest", provider: "tsgw", input: ["text"], cost: { input: 1, output: 0 } }];
	classifyCalls = 0;
	fallbackCalls = 0;
	classifierContext?: ClassifierContext;
	fallbackContext?: Context;
	options?: SimpleStreamOptions;
	classifyImpl = async (): Promise<ClassifierResult> => native();
	replyImpl = async (): Promise<AssistantMessage> => this.selection();
	async getAvailableOfType(type: string) { return type === "chat" ? [...this.models] : [...this.classifiers]; }
	async classify(_model: unknown, context: ClassifierContext) {
		this.classifyCalls++;
		this.classifierContext = context;
		return this.classifyImpl();
	}
	streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
		assert.equal(`${model.provider}/${model.id}`, "tsgw/gpt-6-luna");
		this.fallbackCalls++;
		this.fallbackContext = context;
		this.options = options;
		return { result: () => this.replyImpl() };
	}
	selection(kind = "implement", key?: string) {
		const criteria = this.classifierContext!.questions.selection;
		assert.equal(criteria.type, "choice");
		if (criteria.type !== "choice") throw new Error("缺少候选");
		const selected = Object.entries(criteria.criteria).find(([, value]) => value.includes("模型：deepseek-flash，思考档位：high"));
		return reply(JSON.stringify({ kind, selection: key ?? selected?.[0] }));
	}
}
async function harness(registry = new Registry(), signal?: AbortSignal, scopedModels: unknown[] = []) {
	const handlers = new Map<string, Handler>();
	registerDelegation({
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		getActiveTools: () => ["Agent"],
		getAllTools: () => [{ name: "Agent", parameters: { properties: {
			prompt: { type: "string" }, model: { type: "string" }, resume: { type: "string" },
		} } }],
	} as unknown as ExtensionAPI);
	await handlers.get("session_start")!({});
	const ctx = { modelRegistry: registry, signal, scopedModels } as unknown as ExtensionContext;
	const emit = (name: string, event: unknown) => handlers.get(name)!(event, ctx);
	const event = { toolName: "Agent", toolCallId: "fallback", input: {
		prompt: "核对并修改局部代码", description: "局部修改", input_files: ["not-read.ts"], run_in_background: true,
	} as Record<string, unknown> };
	const final = () => emit("message_end", { message: {
		role: "toolResult", toolName: "Agent", toolCallId: event.toolCallId, isError: true, content: [],
	} });
	return { registry, event, emit, final };
}

test("欠费后只调用固定 Luna 一次，材料不扩张，低成本请求与已报告用量合并", async () => {
	const h = await harness();
	const original = structuredClone(h.event.input);
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
	assert.deepEqual({ ...h.event.input, model: undefined }, { ...original, model: undefined });
	assert.equal(h.registry.classifyCalls, 1);
	assert.equal(h.registry.fallbackCalls, 1);
	const context = h.registry.fallbackContext!;
	assert.equal(context.messages.length, 1);
	assert.deepEqual(JSON.parse(context.messages[0].content as string), h.registry.classifierContext);
	assert.equal(context.tools, undefined);
	assert.deepEqual([h.registry.options?.reasoning, h.registry.options?.maxTokens, h.registry.options?.maxRetries], ["low", 1024, 0]);
	assert.ok(h.registry.options!.timeoutMs! > 0 && h.registry.options!.timeoutMs! <= 15_000);
	const payload = h.registry.options!.onPayload!({ model: "gpt-6-luna" }, chat("gpt-6-luna")) as Record<string, unknown>;
	assert.equal(payload.tools, undefined, "不注入 web_search");
	const questions = h.registry.classifierContext!.questions;
	assert.equal(questions.kind.type, "choice");
	assert.equal(questions.selection.type, "choice");
	if (questions.kind.type !== "choice" || questions.selection.type !== "choice") throw new Error("缺少分类选项");
	assert.deepEqual(payload.text, {
		verbosity: "low",
		format: {
			type: "json_schema", name: "delegation_selection", strict: true,
			schema: {
				type: "object", properties: {
					kind: { type: "string", enum: Object.keys(questions.kind.criteria) },
					selection: { type: "string", enum: Object.keys(questions.selection.criteria) },
				}, required: ["kind", "selection"], additionalProperties: false,
			},
		},
	});
	const originalPayload = { model: "gpt-6-luna", text: { verbosity: "medium", extra: { keep: true } },
		input: [{ role: "user", content: "不变" }], metadata: { keep: true } };
	const snapshot = structuredClone(originalPayload);
	const rewritten = h.registry.options!.onPayload!(originalPayload, chat("gpt-6-luna")) as typeof originalPayload;
	assert.deepEqual(originalPayload, snapshot, "不原地改写宿主请求体");
	assert.equal(rewritten.text.extra, originalPayload.text.extra);
	assert.equal(rewritten.input, originalPayload.input);
	assert.equal(rewritten.metadata, originalPayload.metadata);
	const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "fallback", content: [], isError: false, usage });
	assert.equal(output.details.tsgwDelegation.fallback, "tsgw/gpt-6-luna");
	assert.equal(output.details.tsgwDelegation.classifier, "tsgw/jev-latest");
	assert.equal(output.details.tsgwDelegation.kind, "implement");
	assert.deepEqual(output.details.tsgwDelegation.selectionSource, { type: "chat", model: "tsgw/gpt-6-luna" });
	assert.ok(JSON.stringify(output.content).includes("选型来源：聊天模型 tsgw/gpt-6-luna"));
	assert.equal(output.usage.totalTokens, usage.totalTokens * 3);
	assert.equal(output.usage.cost.total, usage.cost.total * 3);
	assert.equal(await h.final(), undefined, "tool_result 已消费后不重复计费");
});

test("兼容宿主抛异常也兜底，但不暴露异常原文", async () => {
	const h = await harness();
	h.registry.classifyImpl = async () => { throw new Error("Bearer secret-original"); };
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.registry.fallbackCalls, 1);
	assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
});

test("Luna 报错、未决、格式或固定审阅约束无效均回到原 HTTP402，绝不第三次尝试", async t => {
	const cases: Array<[string, (registry: Registry) => Promise<AssistantMessage>]> = [
		["抛异常", async () => { throw new Error("Bearer secret-fallback"); }],
		["error", async () => reply("secret-fallback", { stopReason: "error", errorMessage: "secret-fallback" })],
		["aborted", async () => reply("", { stopReason: "aborted" })],
		["截断", async () => reply("{}", { stopReason: "length" })],
		["非 JSON", async () => reply("secret-fallback")],
		["空输出", async () => reply("")],
		["工具调用", async () => reply("{}", { content: [{ type: "toolCall", id: "forbidden", name: "read", arguments: {} }] })],
		["Markdown", async () => reply('```json\n{"kind":"implement","selection":"option_0"}\n```')],
		["数组", async () => reply("[]")],
		["多余字段", async () => reply('{"kind":"implement","selection":"option_0","why":"secret-fallback"}')],
		["未知类别", async r => r.selection("unknown")],
		["未知候选", async r => r.selection("implement", "unknown")],
		["未决", async r => r.selection("implement", "unresolved")],
		["双审", async r => r.selection("dual_review")],
		["正式审阅降档", async r => r.selection("design_review")],
	];
	for (const [name, response] of cases) await t.test(name, async () => {
		const h = await harness();
		h.registry.replyImpl = () => response(h.registry);
		const block = await h.emit("tool_call", h.event);
		assert.equal(block.block, true);
		assert.match(block.reason, /HTTP 402/);
		assert.equal(h.event.input.model, undefined);
		assert.deepEqual([h.registry.classifyCalls, h.registry.fallbackCalls], [1, 1]);
		const final = await h.final();
		assert.equal(final.message.details.tsgwDelegation.failureKind, "http");
		assert.equal(final.message.details.tsgwDelegation.selectionSource, undefined);
		assert.match(block.reason, /选型来源：无（未完成有效选型/);
		assert.ok(final.message.details.tsgwDelegation.selectionGuide);
		assert.doesNotMatch(JSON.stringify(final), /secret-fallback/);
		assert.equal(final.message.usage.totalTokens, usage.totalTokens * (name === "抛异常" ? 1 : 2));
		assert.equal(await h.final(), undefined);
	});
});

test("Luna 缺席、被用户过滤或非文本身份不调用其他模型，保持原失败", async () => {
	for (const models of [[], [chat("gpt-6-sol")], [{ ...chat("gpt-6-luna"), provider: "other" }],
		[{ ...chat("gpt-6-luna"), input: ["image"] as Model<Api>["input"] }]]) {
		const registry = new Registry();
		registry.models = [chat("deepseek-flash"), ...models];
		const h = await harness(registry);
		assert.match((await h.emit("tool_call", h.event)).reason, /HTTP 402/);
		assert.equal(registry.fallbackCalls, 0);
	}
});

test("合法正式审阅只能选 Astra/max；兜底不绕过会话范围及档位", async () => {
	const registry = new Registry();
	const astra = registry.models.find(model => model.id === "gpt-6-astra")!;
	const h = await harness(registry, undefined, [{ model: astra, thinkingLevel: "max" }]);
	registry.replyImpl = async () => registry.selection("design_review", Object.keys(
		(registry.classifierContext!.questions.selection as { criteria: object }).criteria)[0]);
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/gpt-6-astra:max");
	assert.equal(registry.fallbackCalls, 1, "Luna 是分类执行器，不是 scope 内子代理候选");
	const criteria = (registry.classifierContext!.questions.selection as { criteria: Record<string, string> }).criteria;
	assert.equal(Object.keys(criteria).length, 2);
	assert.ok(Object.values(criteria).some(value => value.includes("模型：gpt-6-astra，思考档位：max")));
});

test("正常分类、未决、主动取消和前置失败不触发 Luna", async () => {
	const answer = (choice: string) => ({ type: "choice" as const, choice, probabilities: { [choice]: 1 }, confidence: 1 });
	for (const mode of ["success", "unresolved", "aborted", "empty", "oversized", "no-classifier", "explicit", "resume"]) {
		const h = await harness();
		if (mode === "empty") h.event.input.prompt = "";
		if (mode === "oversized") h.event.input.prompt = "x".repeat(40_000);
		if (mode === "no-classifier") h.registry.classifiers = [];
		if (mode === "explicit") h.event.input.model = "tsgw/gpt-6-astra:max";
		if (mode === "resume") h.event.input.resume = "old-session";
		h.registry.classifyImpl = async () => {
			const candidate = buildDelegationCandidates(h.registry.models, getSupportedThinkingLevels).find(c => c.id === "deepseek-flash");
			return native({ stopReason: mode === "aborted" ? "aborted" : "stop",
				answers: { kind: answer("implement"), selection: answer(mode === "unresolved" ? "unresolved" : candidate!.key) } });
		};
		await h.emit("tool_call", h.event);
		assert.equal(h.registry.fallbackCalls, 0, mode);
	}
});

test("原分类耗尽总预算时不启动 Luna，同一调用并发等待只产生一次兜底", async () => {
	const originalTimeout = AbortSignal.timeout;
	const timeout = new AbortController();
	AbortSignal.timeout = (() => timeout.signal) as typeof AbortSignal.timeout;
	try {
		const h = await harness();
		h.registry.classifyImpl = async () => { timeout.abort(); return native(); };
		assert.match((await h.emit("tool_call", h.event)).reason, /15 秒/);
		assert.equal(h.registry.fallbackCalls, 0);
	} finally { AbortSignal.timeout = originalTimeout; }
	const h = await harness();
	const gate = deferred<AssistantMessage>();
	h.registry.replyImpl = () => gate.promise;
	const duplicate = structuredClone(h.event);
	const first = h.emit("tool_call", h.event);
	const second = h.emit("tool_call", duplicate);
	await tick();
	gate.resolve(h.registry.selection());
	assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
	assert.equal(h.registry.fallbackCalls, 1);
	assert.equal(duplicate.input.model, h.event.input.model);
});

test("计时器尚未触发但目录查询已耗尽预算时，也不发出兜底请求", async () => {
	const h = await harness();
	const originalNow = Date.now;
	let clock = 0;
	let chatLookups = 0;
	const available = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = async type => {
		const models = await available(type);
		if (type === "chat" && ++chatLookups === 2) clock += 15_000;
		return models;
	};
	Date.now = () => clock;
	try {
		assert.equal((await h.emit("tool_call", h.event)).block, true);
		assert.equal(h.registry.classifyCalls, 1);
		assert.equal(h.registry.fallbackCalls, 0);
		assert.equal(h.event.input.model, undefined);
	} finally { Date.now = originalNow; }
});

test("兜底后目录撤下选定型号仍阻止，不改选其他模型", async () => {
	const h = await harness();
	h.registry.replyImpl = async () => {
		const response = h.registry.selection();
		h.registry.models = h.registry.models.filter(model => model.id !== "deepseek-flash");
		return response;
	};
	assert.match((await h.emit("tool_call", h.event)).reason, /不在当前可用候选/);
	assert.equal(h.event.input.model, undefined);
	assert.equal((await h.final()).message.details.tsgwDelegation.failureKind, "model_unavailable");
});

test("调用取消、会话结束和共用15秒超时均中断兜底等待，迟到响应不得补 model", async () => {
	for (const mode of ["caller", "shutdown", "timeout"]) {
		const caller = new AbortController();
		const timeout = new AbortController();
		const originalTimeout = AbortSignal.timeout;
		if (mode === "timeout") AbortSignal.timeout = (() => timeout.signal) as typeof AbortSignal.timeout;
		const gate = deferred<AssistantMessage>();
		const h = await harness(new Registry(), caller.signal);
		h.registry.replyImpl = () => gate.promise;
		try {
			const pending = h.emit("tool_call", h.event);
			await tick();
			assert.equal(h.registry.fallbackCalls, 1);
			if (mode === "caller") caller.abort();
			if (mode === "shutdown") await h.emit("session_shutdown", {});
			if (mode === "timeout") timeout.abort();
			assert.equal((await pending).block, true);
			assert.ok(h.registry.options?.signal?.aborted);
			assert.equal(h.event.input.model, undefined);
			gate.resolve(h.registry.selection());
			await tick();
			assert.equal(h.event.input.model, undefined);
			assert.deepEqual([h.registry.classifyCalls, h.registry.fallbackCalls], [1, 1]);
		} finally {
			AbortSignal.timeout = originalTimeout;
			gate.resolve(reply("{}"));
		}
	}
});
