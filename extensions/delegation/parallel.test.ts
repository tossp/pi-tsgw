import assert from "node:assert/strict";
import test from "node:test";
import type { Api, AssistantMessage, ClassifierContext, ClassifierResult, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deepseekModels } from "#tsgw/models/vendors/deepseek";
import { minimaxModels } from "#tsgw/models/vendors/minimax";
import { openaiModels } from "#tsgw/models/vendors/openai";
import { CHAT_SELECTION_IDS } from "./chat-selection.ts";
import { chatFailure } from "./failure.ts";
import { registerDelegation } from "./index.ts";

type Handler = (event: any, ctx?: any) => any;
const usage: Usage = {
	input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
};
const root = "https://models.example.test";
const catalog = [...openaiModels(root), ...deepseekModels(root), ...minimaxModels(root)];
function chat(id: string): Model<Api> {
	const model = catalog.find(entry => entry.id === id)!;
	return { ...model, provider: "tsgw" } as Model<Api>;
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
	models = [...CHAT_SELECTION_IDS.map(chat), chat("gpt-6-astra")];
	classifiers: unknown[] = [{ type: "classifier", id: "jev-latest", provider: "tsgw", input: ["text"], cost: { input: 1, output: 0 } }];
	classifyCalls = 0;
	requests: { model: Model<Api>; context: Context; options: SimpleStreamOptions }[] = [];
	classifierContext?: ClassifierContext;
	nativeOptions?: { signal?: AbortSignal };
	classifyImpl = async (): Promise<ClassifierResult> => native();
	replyImpl = async (_model: Model<Api>): Promise<AssistantMessage> => this.selection();
	async getAvailableOfType(type: string) { return type === "chat" ? [...this.models] : [...this.classifiers]; }
	async classify(_model: unknown, context: ClassifierContext, options: { signal?: AbortSignal }) {
		this.classifyCalls++;
		this.classifierContext = context;
		this.nativeOptions = options;
		return this.classifyImpl();
	}
	streamSimple(model: Model<Api>, context: Context, options: SimpleStreamOptions) {
		this.requests.push({ model, context, options });
		return { result: () => this.replyImpl(model) };
	}
	selection(kind = "implement", key?: string) {
		const context: ClassifierContext = this.classifierContext ?? JSON.parse(this.requests[0].context.messages[0].content as string);
		const criteria = context.questions.selection;
		if (criteria.type !== "choice") throw new Error("缺少候选");
		const selected = Object.entries(criteria.criteria).find(([, value]) => value.includes("模型：deepseek-flash，思考档位：high"));
		return reply(JSON.stringify({ kind, selection: key ?? selected?.[0] ?? Object.keys(criteria.criteria)[0] }));
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

test("聊天 SDK 的 HTTP 状态码兼容两种协议格式；未知消息不猜测错误码或回显正文", () => {
	for (const status of [400, 401, 403, 429, 500, 503]) {
		for (const message of [`${status} secret-chat`, `HTTP ${status} secret-chat`, `tsgw API error (${status}): secret-chat`]) {
			const failure = chatFailure(message);
			assert.equal(failure.statusCode, status);
			assert.equal(failure.failureKind, status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : "http");
			assert.doesNotMatch(JSON.stringify(failure), /secret-chat/);
		}
	}
	for (const message of [undefined, "Bearer secret-chat", 'payload includes HTTP 503', 'tsgw API error: secret-chat 429']) {
		assert.deepEqual(chatFailure(message), { failureKind: "unknown", reason: "聊天选型请求失败（原因未明）。" });
	}
	assert.equal(chatFailure("Request timed out.").failureKind, "timeout");
	assert.equal(chatFailure("Connection error.").failureKind, "network");
});

test("四路材料同源、按厂商协议处理参数且不扩张工具；已报告用量只累加一次", async () => {
	const h = await harness();
	const original = structuredClone(h.event.input);
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
	assert.deepEqual({ ...h.event.input, model: undefined }, { ...original, model: undefined });
	assert.equal(h.registry.classifyCalls, 1);
	assert.deepEqual(h.registry.requests.map(request => request.model.id), CHAT_SELECTION_IDS);
	const questions = h.registry.classifierContext!.questions;
	if (questions.kind.type !== "choice" || questions.selection.type !== "choice") throw new Error("缺少分类选项");
	for (const { model, context, options } of h.registry.requests) {
		assert.equal(context.messages.length, 1);
		assert.deepEqual(JSON.parse(context.messages[0].content as string), h.registry.classifierContext);
		assert.equal(context.tools, undefined);
		assert.deepEqual([options.reasoning, options.maxTokens, options.maxRetries], ["low", 1024, 0]);
		assert.ok(options.timeoutMs! > 0 && options.timeoutMs! <= 15_000);
		const originalPayload = { model: model.id, input: [{ role: "user", content: "不变" }],
			metadata: { keep: true }, ...(model.api === "openai-responses" ? { text: { extra: { keep: true } } } : {}) };
		const snapshot = structuredClone(originalPayload);
		const payload = options.onPayload!(originalPayload, model) as Record<string, any>;
		assert.deepEqual(originalPayload, snapshot);
		assert.equal(payload.input, originalPayload.input);
		assert.equal(payload.metadata, originalPayload.metadata);
		assert.equal(payload.tools, undefined, "不注入 web_search 或结构化输出工具");
		if (model.api === "anthropic-messages") {
			assert.deepEqual(payload.thinking, { type: "adaptive" });
			assert.equal(payload.output_config.effort, "low");
			assert.equal(payload.text, undefined);
			assert.equal(payload.reasoning_effort, undefined);
		} else {
			assert.equal(payload.text.extra, originalPayload.text!.extra);
			assert.equal(payload.text.verbosity, model.id === "gpt-6-luna" ? "low" : undefined);
			assert.deepEqual(payload.text.format, {
				type: "json_schema", name: "delegation_selection", strict: true,
				schema: { type: "object", properties: {
					kind: { type: "string", enum: Object.keys(questions.kind.criteria) },
					selection: { type: "string", enum: Object.keys(questions.selection.criteria) },
				}, required: ["kind", "selection"], additionalProperties: false },
			});
		}
	}
	const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false, usage });
	assert.equal(output.details.tsgwDelegation.chatModel, "tsgw/gpt-6-luna");
	assert.deepEqual(output.details.tsgwDelegation.chatModels, CHAT_SELECTION_IDS.map(id => `tsgw/${id}`));
	assert.equal(output.details.tsgwDelegation.classifier, "tsgw/jev-latest");
	assert.deepEqual(output.details.tsgwDelegation.selectionSource, { type: "chat", model: "tsgw/gpt-6-luna" });
	assert.match(JSON.stringify(output.content), /并行竞速/);
	assert.equal(output.usage.totalTokens, usage.totalTokens * 5);
	assert.equal(output.usage.cost.total, usage.cost.total * 5);
	assert.equal(await h.final(), undefined);
});

test("四路都已启动：每一路均可独立胜出，不等待三个败路的迟到响应", async () => {
	for (const winner of ["classifier", ...CHAT_SELECTION_IDS]) {
		const h = await harness();
		const nativeGate = deferred<ClassifierResult>();
		const chatGates = new Map(CHAT_SELECTION_IDS.map(id => [id as string, deferred<AssistantMessage>()]));
		h.registry.classifyImpl = () => nativeGate.promise;
		h.registry.replyImpl = model => chatGates.get(model.id)!.promise;
		const pending = h.emit("tool_call", h.event);
		await tick();
		assert.equal(h.registry.classifyCalls, 1);
		assert.deepEqual(h.registry.requests.map(request => request.model.id), CHAT_SELECTION_IDS);
		if (winner === "classifier") nativeGate.resolve(h.registry.validNative());
		else chatGates.get(winner)!.resolve(h.registry.selection());
		assert.equal(await pending, undefined);
		assert.ok(h.registry.requests.every(request => request.options.signal?.aborted));
		assert.ok(h.registry.nativeOptions?.signal?.aborted);
		assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
		const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false });
		assert.deepEqual(output.details.tsgwDelegation.selectionSource, winner === "classifier" ?
			{ type: "classifier", model: "tsgw/jev-latest" } : { type: "chat", model: `tsgw/${winner}` });
		assert.equal(output.usage.totalTokens, usage.totalTokens, "不伪造尚未报告的败路用量");
		assert.equal(output.details.tsgwDelegation.selectionErrors, undefined, "竞速取消不作为报错");
		nativeGate.resolve(h.registry.validNative());
		for (const gate of chatGates.values()) gate.resolve(h.registry.selection());
		await tick();
		assert.equal(await h.final(), undefined, "迟到结果不二次选型或入账");
	}
});

test("三路先失败、未决或违反硬约束，仍等待第四路有效结果", async () => {
	for (const winner of ["classifier", ...CHAT_SELECTION_IDS]) {
		const h = await harness();
		const nativeGate = deferred<ClassifierResult>();
		const chatGate = deferred<AssistantMessage>();
		h.registry.classifyImpl = () => winner === "classifier" ? nativeGate.promise : Promise.resolve(native({ stopReason: "aborted" }));
		h.registry.replyImpl = async model => model.id === winner ? chatGate.promise : h.registry.selection("design_review");
		let completed = false;
		const pending = h.emit("tool_call", h.event).then((result: unknown) => { completed = true; return result; });
		await tick();
		assert.equal(completed, false, winner);
		assert.ok(h.registry.requests.every(request => !request.options.signal?.aborted));
		if (winner === "classifier") nativeGate.resolve(h.registry.validNative());
		else chatGate.resolve(h.registry.selection());
		assert.equal(await pending, undefined);
		const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false });
		const errors = output.details.tsgwDelegation.selectionErrors;
		assert.equal(errors.length, 3);
		assert.equal(errors.some((error: any) => error.source.model === `tsgw/${winner === "classifier" ? "jev-latest" : winner}`), false);
		for (const error of errors) assert.ok(JSON.stringify(output.content).includes(error.source.model));
	}
});

test("先返回 HTTP 错误继续等待有效结果；错误只提取渠道与状态码，不泄露上游正文", async () => {
	const h = await harness();
	const gate = deferred<AssistantMessage>();
	h.registry.replyImpl = async model => model.id === "MiniMax-M3.1-Flash" ? gate.promise :
		reply("", { stopReason: "error", errorMessage: model.id === "gpt-6-luna" ?
			'tsgw API error (429): {"secret-chat":"token"}' : "tsgw API error (503): secret-chat" });
	const pending = h.emit("tool_call", h.event);
	await tick();
	gate.resolve(h.registry.selection());
	assert.equal(await pending, undefined);
	const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false });
	const errors = output.details.tsgwDelegation.selectionErrors;
	assert.deepEqual(errors.map((error: any) => [error.source.model, error.statusCode]).sort(),
		[["tsgw/deepseek-flash", 503], ["tsgw/gpt-6-luna", 429], ["tsgw/jev-latest", 402]]);
	assert.deepEqual(errors.map((error: any) => error.failureKind).sort(), ["http", "http", "rate_limit"]);
	assert.match(JSON.stringify(output.content), /HTTP 429/);
	assert.match(JSON.stringify(output.content), /HTTP 503/);
	assert.doesNotMatch(JSON.stringify(output), /secret-chat/);
});

test("四路都失败才阻止；所有聊天通道拒绝非法输出，不重试或泄露响应", async t => {
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
		assert.equal(h.registry.classifyCalls, 1);
		assert.equal(h.registry.requests.length, 3);
		for (const id of CHAT_SELECTION_IDS) assert.ok(block.reason.includes(`tsgw/${id}`));
		const final = await h.final();
		assert.equal(final.message.details.tsgwDelegation.selectionSource, undefined);
		assert.equal(final.message.details.tsgwDelegation.failureKind, "http");
		assert.equal(final.message.details.tsgwDelegation.selectionErrors.length, 4);
		assert.doesNotMatch(JSON.stringify(final), /secret-chat/);
		assert.equal(final.message.usage.totalTokens, usage.totalTokens * (name === "抛异常" ? 1 : 4));
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

test("各聊天执行器独立尊重可用目录和用户过滤；不补入其他型号", async () => {
	for (const id of CHAT_SELECTION_IDS) {
		for (const replacement of [undefined, { ...chat(id), provider: "other" },
			{ ...chat(id), input: ["image"] as Model<Api>["input"] }, { ...chat(id), type: "classifier" }]) {
			const registry = new Registry();
			registry.models = registry.models.filter(model => model.id !== id);
			if (replacement) registry.models.push(replacement as Model<Api>);
			registry.classifyImpl = async () => registry.validNative();
			const h = await harness(registry);
			assert.equal(await h.emit("tool_call", h.event), undefined);
			assert.deepEqual(registry.requests.map(request => request.model.id), CHAT_SELECTION_IDS.filter(model => model !== id));
		}
		const registry = new Registry();
		registry.models = [chat(id), chat("gpt-6-astra")];
		registry.classifiers = [];
		const h = await harness(registry);
		assert.equal(await h.emit("tool_call", h.event), undefined);
		assert.equal(registry.classifyCalls, 0);
		assert.deepEqual(registry.requests.map(request => request.model.id), [id]);
		const output = await h.emit("tool_result", { toolName: "Agent", toolCallId: "parallel", content: [], isError: false });
		assert.deepEqual(output.details.tsgwDelegation.chatModels, [`tsgw/${id}`]);
	}
});

test("分类目录查询仍在等待时聊天通道可胜出；宿主缺单路接口也可选型", async () => {
	const h = await harness();
	const gate = deferred<unknown[]>();
	const available = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = type => type === "classifier" ? gate.promise : available(type);
	assert.equal(await h.emit("tool_call", h.event), undefined);
	assert.equal(h.event.input.model, "tsgw/deepseek-flash:high");
	assert.equal(h.registry.classifyCalls, 0);
	assert.equal(h.registry.requests.length, 3);
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
	assert.equal(registry.requests.length, 3);
	for (const request of registry.requests) {
		const context = JSON.parse(request.context.messages[0].content as string) as ClassifierContext;
		const criteria = context.questions.selection;
		assert.equal(criteria.type === "choice" && Object.keys(criteria.criteria).length, 2);
	}
});

test("输入与显式指定前置检查不发请求；同一工具调用不会重复四发", async () => {
	for (const mode of ["empty", "oversized", "explicit", "resume"]) {
		const h = await harness();
		if (mode === "empty") h.event.input.prompt = "";
		if (mode === "oversized") h.event.input.prompt = "x".repeat(40_000);
		if (mode === "explicit") h.event.input.model = "tsgw/gpt-6-astra:max";
		if (mode === "resume") h.event.input.resume = "old-session";
		await h.emit("tool_call", h.event);
		assert.equal(h.registry.classifyCalls, 0);
		assert.equal(h.registry.requests.length, 0);
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
	assert.equal(h.registry.classifyCalls, 1);
	assert.equal(h.registry.requests.length, 3);
	assert.equal(duplicate.input.model, h.event.input.model);
});

test("目录查询耗尽预算时四路均不请求；获胜后目录撤下仍阻止，不改选", async () => {
	const h = await harness();
	const originalNow = Date.now;
	let clock = 0;
	const available = h.registry.getAvailableOfType.bind(h.registry);
	h.registry.getAvailableOfType = async type => { const models = await available(type); clock = 15_000; return models; };
	Date.now = () => clock;
	try {
		assert.equal((await h.emit("tool_call", h.event)).block, true);
		assert.equal(h.registry.classifyCalls, 0);
		assert.equal(h.registry.requests.length, 0);
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

test("调用取消、会话结束或总超时中断四路；忽略 signal 的迟到响应不得创建", async () => {
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
			assert.equal(h.registry.classifyCalls, 1);
			assert.equal(h.registry.requests.length, 3);
			if (mode === "caller") caller.abort();
			if (mode === "shutdown") await h.emit("session_shutdown", {});
			if (mode === "timeout") timeout.abort();
			assert.equal((await pending).block, true);
			assert.ok(h.registry.requests.every(request => request.options.signal?.aborted));
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
