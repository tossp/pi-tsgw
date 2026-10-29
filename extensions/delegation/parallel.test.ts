import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, ClassifierContext, ClassifierResult, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
	chatCalls = 0;
	classifierContext?: ClassifierContext;
	chatContext?: Context;
	nativeOptions?: { signal?: AbortSignal };
	options?: SimpleStreamOptions;
	classifyImpl = async (): Promise<ClassifierResult> => native();
	replyImpl = async (): Promise<AssistantMessage> => this.selection();
	async getAvailableOfType(type: string) { return type === "chat" ? [...this.models] : [...this.classifiers]; }
	async classify(_model: unknown, context: ClassifierContext, options: { signal?: AbortSignal }) {
		this.classifyCalls++;
		this.classifierContext = context;
		this.nativeOptions = options;
		return this.classifyImpl();
	}
	streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
		assert.equal(`${model.provider}/${model.id}`, "tsgw/gpt-6-luna");
		this.chatCalls++;
		this.chatContext = context;
		this.options = options;
		return { result: () => this.replyImpl() };
	}
	selection(kind = "implement", key?: string) {
		const context: ClassifierContext = this.classifierContext ?? JSON.parse(this.chatContext!.messages[0].content as string);
		const criteria = context.questions.selection;
		if (criteria.type !== "choice") throw new Error("缺少候选");
		const selected = Object.entries(criteria.criteria).find(([, value]) => value.includes("模型：deepseek-flash，思考档位：high"));
		return reply(JSON.stringify({ kind, selection: key ?? selected?.[0] }));
	}
	validNative(kind = "implement"): ClassifierResult {
		const { selection } = JSON.parse(this.selection(kind).content.flatMap(part => part.type === "text" ? [part.text] : []).join(""));
		const answer = (choice: string) => ({ type: "choice" as const, choice, probabilities: { [choice]: 1 }, confidence: 1 });
		return native({ stopReason: "stop", answers: { kind: answer(kind), selection: answer(selection) } });
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
	const event = { toolName: "Agent", toolCallId: "parallel", input: {
		prompt: "核对并修改局部代码", description: "局部修改", input_files: ["not-read.ts"], run_in_background: true,
	} as Record<string, unknown> };
	const final = () => emit("message_end", { message: {
		role: "toolResult", toolName: "Agent", toolCallId: event.toolCallId, isError: true, content: [],
	} });
	return { registry, event, emit, final };
}

test("并行两路材料同源、严格格式且不扩张工具；两路已报告用量只累加一次", async () => {
	const h = await harness();
	const original = structuredClone(h.event.input);
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
	assert.deepEqual({ ...h.event.input, model: undefined }, { ...original, model: undefined });
	assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [1, 1]);
	const context = h.registry.chatContext!;
	assert.equal(context.messages.length, 1);
	assert.deepEqual(JSON.parse(context.messages[0].content as string), h.registry.classifierContext);
	assert.equal(context.tools, undefined);
	assert.deepEqual([h.registry.options?.reasoning, h.registry.options?.maxTokens, h.registry.options?.maxRetries], ["low", 1024, 0]);
	assert.ok(h.registry.options!.timeoutMs! > 0 && h.registry.options!.timeoutMs! <= 15_000);
	const payload = h.registry.options!.onPayload!({ model: "gpt-6-luna" }, chat("gpt-6-luna")) as Record<string, unknown>;
	assert.equal(payload.tools, undefined, "不注入 web_search");
	const questions = h.registry.classifierContext!.questions;
	if (questions.kind.type !== "choice" || questions.selection.type !== "choice") throw new Error("缺少分类选项");
	assert.deepEqual(payload.text, {
		verbosity: "low", format: {
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
	assert.deepEqual(originalPayload, snapshot);
	assert.equal(rewritten.text.extra, originalPayload.text.extra);
	assert.equal(rewritten.input, originalPayload.input);
	assert.equal(rewritten.metadata, originalPayload.metadata);
	const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false, usage });
	assert.equal(output.details.tsgwDelegation.chatModel, "tsgw/gpt-6-luna");
	assert.equal(output.details.tsgwDelegation.classifier, "tsgw/jev-latest");
	assert.deepEqual(output.details.tsgwDelegation.selectionSource, { type: "chat", model: "tsgw/gpt-6-luna" });
	assert.ok(JSON.stringify(output.content).includes("并行竞速"));
	assert.equal(JSON.stringify(output.content).includes("兜底"), false);
	assert.equal(output.usage.totalTokens, usage.totalTokens * 3);
	assert.equal(output.usage.cost.total, usage.cost.total * 3);
	assert.equal(await h.final(), undefined);
});

test("两路均启动后分别释放有效结果：首个合法者胜出，取消败路但不等待其迟到响应", async () => {
	for (const winner of ["classifier", "chat"]) {
		const h = await harness();
		const nativeGate = deferred<ClassifierResult>();
		const chatGate = deferred<AssistantMessage>();
		h.registry.classifyImpl = () => nativeGate.promise;
		h.registry.replyImpl = () => chatGate.promise;
		const pending = h.emit("tool_call", h.event);
		await tick();
		assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [1, 1], "未返回任何结果前两路都已请求");
		if (winner === "classifier") nativeGate.resolve(h.registry.validNative());
		else chatGate.resolve(h.registry.selection());
		assert.equal(await pending, undefined);
		assert.ok(h.registry.options?.signal?.aborted);
		assert.ok(h.registry.nativeOptions?.signal?.aborted);
		assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
		const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false });
		assert.equal(output.details.tsgwDelegation.selectionSource.type, winner);
		assert.equal(output.usage.totalTokens, usage.totalTokens, "不伪造尚未报告的败路用量");
		nativeGate.resolve(h.registry.validNative());
		chatGate.resolve(h.registry.selection());
		await tick();
		assert.equal(await h.final(), undefined, "迟到结果不二次选型或入账");
	}
});

test("一条通道先失败、未决或违反硬约束，仍等待另一条有效结果", async () => {
	for (const first of ["native-error", "native-invalid", "native-aborted", "chat-invalid", "chat-design-review"]) {
		const h = await harness();
		const nativeGate = deferred<ClassifierResult>();
		const chatGate = deferred<AssistantMessage>();
		h.registry.classifyImpl = () => nativeGate.promise;
		h.registry.replyImpl = () => chatGate.promise;
		let completed = false;
		const pending = h.emit("tool_call", h.event).then((result: unknown) => { completed = true; return result; });
		await tick();
		if (first.startsWith("native")) {
			let result = native();
			if (first === "native-invalid") result = native({ stopReason: "stop" });
			if (first === "native-aborted") result = native({ stopReason: "aborted" });
			nativeGate.resolve(result);
		}
		else chatGate.resolve(first === "chat-invalid" ? reply("invalid") : h.registry.selection("design_review"));
		await tick();
		assert.equal(completed, false, first);
		assert.equal(h.registry.options?.signal?.aborted, false);
		if (first.startsWith("native")) chatGate.resolve(h.registry.selection());
		else nativeGate.resolve(h.registry.validNative());
		assert.equal(await pending, undefined);
	}
});

test("两路都失败才阻止，保留安全失败类别，不重试或泄露响应", async t => {
	const cases: Array<[string, (registry: Registry) => Promise<AssistantMessage>]> = [
		["抛异常", async () => { throw new Error("Bearer secret-chat"); }],
		["error", async () => reply("secret-chat", { stopReason: "error" })],
		["aborted", async () => reply("", { stopReason: "aborted" })],
		["截断", async () => reply("{}", { stopReason: "length" })],
		["非 JSON", async () => reply("secret-chat")],
		["工具调用", async () => reply("{}", { content: [{ type: "toolCall", id: "forbidden", name: "read", arguments: {} }] })],
		["Markdown", async () => reply('```json\n{"kind":"implement","selection":"option_0"}\n```')],
		["数组", async () => reply("[]")],
		["多余字段", async () => reply('{"kind":"implement","selection":"option_0","why":"secret-chat"}')],
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
		assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [1, 1]);
		const final = await h.final();
		assert.equal(final.message.details.tsgwDelegation.selectionSource, undefined);
		assert.equal(final.message.details.tsgwDelegation.failureKind, "http");
		assert.doesNotMatch(JSON.stringify(final), /secret-chat/);
		assert.equal(final.message.usage.totalTokens, usage.totalTokens * (name === "抛异常" ? 1 : 2));
		assert.equal(await h.final(), undefined);
	});
});

test("单通道 aborted 保留已清洗的网络或超时原因，不冒充用户取消", async () => {
	for (const [message, expected] of [["分类网络请求失败。", "network"], ["分类请求超时。", "timeout"]]) {
		const h = await harness();
		h.registry.classifyImpl = async () => native({ stopReason: "aborted", errorMessage: message });
		h.registry.replyImpl = async () => reply("invalid");
		assert.equal((await h.emit("tool_call", h.event)).block, true);
		const final = await h.final();
		assert.equal(final.message.details.tsgwDelegation.failureKind, expected);
		assert.match(final.message.content[0].text, /选型来源：无/);
	}
});

test("一路缺席或不支持不妨碍另一条；不替换固定 Luna 或绕过用户过滤", async () => {
	const h = await harness();
	h.registry.classifiers = [];
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [0, 1]);
	for (const extra of [[], [chat("gpt-6-sol")], [{ ...chat("gpt-6-luna"), provider: "other" }],
		[{ ...chat("gpt-6-luna"), input: ["image"] as Model<Api>["input"] }]]) {
		const registry = new Registry();
		registry.models = [chat("deepseek-flash"), ...extra];
		registry.classifyImpl = async () => registry.validNative();
		const isolated = await harness(registry);
		assert.equal(await isolated.emit("tool_call", isolated.event), undefined);
		assert.deepEqual([registry.classifyCalls, registry.chatCalls], [1, 0]);
	}
});

test("分类目录查询仍在等待时聊天通道可胜出；宿主缺单路接口也可选型", async () => {
	const h = await harness();
	const gate = deferred<unknown[]>();
	const available = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = type => type === "classifier" ? gate.promise : available(type);
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
	assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [0, 1]);
	gate.resolve(h.registry.classifiers);
	await tick();
	assert.equal(h.registry.classifyCalls, 0, "迟到目录不得再发出分类请求");
	for (const missing of ["classify", "streamSimple"]) {
		const single = await harness();
		single.registry.classifyImpl = async () => single.registry.validNative();
		Object.defineProperty(single.registry, missing, { value: undefined });
		assert.equal(await single.emit("tool_call", single.event), undefined);
		assert.equal(single.event.input.model, "tsgw/deepseek-flash:high");
	}
});

test("合法正式审阅只选 Astra/max；聊天执行器不受子代理 scope 限制", async () => {
	const registry = new Registry();
	const astra = registry.models.find(model => model.id === "gpt-6-astra")!;
	const h = await harness(registry, undefined, [{ model: astra, thinkingLevel: "max" }]);
	registry.replyImpl = async () => registry.selection("design_review", "option_0");
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/gpt-6-astra:max");
	assert.equal(registry.chatCalls, 1);
	const context = JSON.parse(registry.chatContext!.messages[0].content as string) as ClassifierContext;
	const criteria = context.questions.selection;
	assert.equal(criteria.type === "choice" && Object.keys(criteria.criteria).length, 2);
});

test("输入与显式指定前置检查不发请求；同一工具调用不会重复双发", async () => {
	for (const mode of ["empty", "oversized", "explicit", "resume"]) {
		const h = await harness();
		if (mode === "empty") h.event.input.prompt = "";
		if (mode === "oversized") h.event.input.prompt = "x".repeat(40_000);
		if (mode === "explicit") h.event.input.model = "tsgw/gpt-6-astra:max";
		if (mode === "resume") h.event.input.resume = "old-session";
		await h.emit("tool_call", h.event);
		assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [0, 0]);
	}
	const h = await harness();
	const gate = deferred<AssistantMessage>();
	h.registry.replyImpl = () => gate.promise;
	const duplicate = structuredClone(h.event);
	const first = h.emit("tool_call", h.event);
	const second = h.emit("tool_call", duplicate);
	await tick();
	gate.resolve(h.registry.selection());
	assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
	assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [1, 1]);
	assert.equal(duplicate.input.model, h.event.input.model);
});

test("目录查询耗尽预算时两路均不请求；获胜后目录撤下仍阻止，不改选", async () => {
	const h = await harness();
	const originalNow = Date.now;
	let clock = 0;
	const available = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = async type => { const models = await available(type); clock = 15_000; return models; };
	Date.now = () => clock;
	try {
		assert.equal((await h.emit("tool_call", h.event)).block, true);
		assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [0, 0]);
	} finally { Date.now = originalNow; }
	const withdrawn = await harness();
	withdrawn.registry.replyImpl = async () => {
		const response = withdrawn.registry.selection();
		withdrawn.registry.models = withdrawn.registry.models.filter(model => model.id !== "deepseek-flash");
		return response;
	};
	assert.match((await withdrawn.emit("tool_call", withdrawn.event)).reason, /不在当前可用候选/);
	assert.equal(withdrawn.event.input.model, undefined);
});

test("调用取消、会话结束或总超时中断两路；忽略 signal 的迟到响应不得创建", async () => {
	for (const mode of ["caller", "shutdown", "timeout"]) {
		const caller = new AbortController();
		const timeout = new AbortController();
		const originalTimeout = AbortSignal.timeout;
		if (mode === "timeout") AbortSignal.timeout = (() => timeout.signal) as typeof AbortSignal.timeout;
		const chatGate = deferred<AssistantMessage>();
		const nativeGate = deferred<ClassifierResult>();
		const h = await harness(new Registry(), caller.signal);
		h.registry.replyImpl = () => chatGate.promise;
		h.registry.classifyImpl = () => nativeGate.promise;
		try {
			const pending = h.emit("tool_call", h.event);
			await tick();
			assert.deepEqual([h.registry.classifyCalls, h.registry.chatCalls], [1, 1]);
			if (mode === "caller") caller.abort();
			if (mode === "shutdown") await h.emit("session_shutdown", {});
			if (mode === "timeout") timeout.abort();
			assert.equal((await pending).block, true);
			assert.ok(h.registry.options?.signal?.aborted);
			assert.ok(h.registry.nativeOptions?.signal?.aborted);
			chatGate.resolve(h.registry.selection());
			nativeGate.resolve(h.registry.validNative());
			await tick();
			assert.equal(h.event.input.model, undefined);
		} finally {
			AbortSignal.timeout = originalTimeout;
			chatGate.resolve(reply("{}"));
			nativeGate.resolve(native());
		}
	}
});
