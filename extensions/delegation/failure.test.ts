import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Model,
	Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { buildDelegationCandidates, buildDelegationGuide, type DelegationCandidate } from "./policy.ts";
import { registerDelegation } from "./index.ts";

const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
type Handler = (event: any, ctx: any) => any;
type AnyRecord = Record<string, any>;
type FailureKind = "timeout" | "cancelled" | "authentication" | "rate_limit" | "http" | "network" |
	"invalid_response" | "unsupported" | "unknown" | "invalid_input" | "unavailable" |
	"invalid_result" | "model_unavailable";

const CHAT_IDS = ["deepseek-flash", "gpt-6-astra"];
const SECRETS = ["sk-live-hidden", "internal.example.test", "raw-secret"];
const USAGE: Usage = {
	input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

function chatModel(id: string): Model<Api> {
	return {
		id, name: id, provider: "tsgw", api: "openai-responses",
		baseUrl: "https://models.example.test/v1", input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		contextWindow: 128_000, maxTokens: 32_000,
	};
}
function classifierModel(): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier", id: "jev-latest", name: "jev-latest", provider: "tsgw",
		api: "typesafe-system-one", baseUrl: "https://models.example.test/v1",
		input: ["text"], cost: { input: 0.5, output: 0.1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
	};
}
const catalog = (): Model<Api>[] => CHAT_IDS.map(id => chatModel(id));
function candidate(id = "deepseek-flash", level: DelegationCandidate["level"] = "high"): DelegationCandidate {
	const found = buildDelegationCandidates(catalog(), getSupportedThinkingLevels)
		.find(entry => entry.id === id && entry.level === level);
	if (!found) throw new Error(`缺少候选 ${id}:${level}`);
	return found;
}
function choice(value: string) {
	return { type: "choice" as const, choice: value, probabilities: { [value]: 1 }, confidence: 1 };
}
function classification(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return {
		api: "typesafe-system-one", provider: "tsgw", model: "jev-latest",
		answers: {}, usage: USAGE, stopReason: "stop", timestamp: 0, ...overrides,
	};
}
function selected(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return classification({
		answers: { kind: choice("implement"), selection: choice(candidate().key) }, ...overrides,
	});
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}
async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise(resolve => setImmediate(resolve));
}
const GUIDE_HEADER = buildDelegationGuide(undefined).split("\n")
	.find(line => line.startsWith("| 模型与思考档位")) ?? "";
function assertGuideOnce(text: string, label: string): void {
	assert.ok(GUIDE_HEADER, "建议表表头应存在");
	assert.equal(text.split(GUIDE_HEADER).length - 1, 1, `${label}应含且仅含一次原始选型建议表`);
	assert.match(text, /Kimi/);
	assert.match(text, /gpt-6-astra\/max/);
}
function assertGuideRow(guide: unknown, model: string, status: string): void {
	assert.equal(typeof guide, "string");
	const row = (guide as string).split("\n").find(line => line.includes(`| ${model} |`));
	assert.ok(row, `建议表缺少 ${model}`);
	assert.ok(row.includes(`| ${status} |`), `${model} 应标记为${status}`);
}
function assertNoGuide(blocked: ToolCallEventResult | undefined, text: string, delegation: AnyRecord): void {
	assert.equal(delegation.selectionGuide, undefined);
	assert.equal((blocked?.reason ?? "").includes(GUIDE_HEADER), false);
	assert.equal(text.includes(GUIDE_HEADER), false);
}
class Registry {
	chat: Model<Api>[] = catalog();
	classifiers: ClassifierModel<ClassifierApi>[] = [classifierModel()];
	chatCalls = 0;
	classifierCalls = 0;
	classifyCalls = 0;
	lastOptions?: AnyRecord;
	classifyImpl: () => Promise<ClassifierResult> = async () => {
		throw new Error("本测试不应调用 classify");
	};
	async getAvailableOfType(type: "chat" | "classifier") {
		if (type === "chat") {
			this.chatCalls++;
			return [...this.chat];
		}
		this.classifierCalls++;
		return [...this.classifiers];
	}
	async classify(_model: unknown, _context: ClassifierContext, options?: AnyRecord): Promise<ClassifierResult> {
		this.classifyCalls++;
		this.lastOptions = options;
		return this.classifyImpl();
	}
}

class TestPi {
	tools: unknown[];
	activeTools = ["Agent"];
	private readonly handlers = new Map<string, Handler[]>();
	constructor(tools: unknown[] = [agentTool()]) {
		this.tools = tools;
	}
	on(event: string, handler: Handler): () => void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return () => {};
	}
	getActiveTools = () => [...this.activeTools];
	getAllTools = () => this.tools;
	async emit(event: string, payload: unknown, ctx?: unknown): Promise<any> {
		let result: any;
		for (const handler of this.handlers.get(event) ?? []) result = await handler(payload, ctx);
		return result;
	}
}
function agentTool(): AnyRecord {
	return {
		name: "Agent", description: "test-only Agent", exposure: "model-only",
		parameters: {
			type: "object",
			properties: { prompt: { type: "string" }, model: { type: "string" }, resume: { type: "string" } },
		},
	};
}
function context(registry: Registry, options: { signal?: AbortSignal } = {}): ExtensionContext {
	return {
		modelRegistry: registry,
		scopedModels: [],
		signal: options.signal,
	} as unknown as ExtensionContext;
}
function callEvent(id: string, input: Record<string, unknown>): ToolCallEvent {
	return { type: "tool_call", toolCallId: id, toolName: "Agent", input } as unknown as ToolCallEvent;
}
function messageEnd(id: string): AnyRecord {
	return {
		type: "message_end",
		message: {
			role: "toolResult", toolCallId: id, toolName: "Agent",
			content: [{ type: "text", text: "执行前已阻止" }], details: {}, isError: true, timestamp: 0,
		},
	};
}
function delegationOf(message: AnyRecord): AnyRecord {
	return ((message.details as AnyRecord | undefined)?.tsgwDelegation ?? {}) as AnyRecord;
}
function textOf(message: AnyRecord): string {
	return (message.content as Array<{ type: string; text?: string }> | undefined ?? [])
		.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}
function assertSafe(value: unknown, label = "失败输出"): void {
	const serialized = JSON.stringify(value) ?? "";
	for (const secret of SECRETS) assert.equal(serialized.includes(secret), false, `${label}不得泄露 ${secret}`);
}
async function harness(): Promise<TestPi> {
	const pi = new TestPi();
	registerDelegation(pi as unknown as ExtensionAPI);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	return pi;
}
async function blockedOutcome(
	pi: TestPi, registry: Registry, id: string,
	input: Record<string, unknown> = { prompt: "待选型任务" },
	options: { signal?: AbortSignal } = {},
): Promise<{ event: ToolCallEvent; blocked: ToolCallEventResult | undefined; message: AnyRecord; delegation: AnyRecord; text: string }> {
	const event = callEvent(id, input);
	const blocked = await pi.emit("tool_call", event, context(registry, options)) as ToolCallEventResult | undefined;
	assert.equal(blocked?.block, true);
	assert.equal((event.input as AnyRecord).model, undefined);
	const fallback = await pi.emit("message_end", messageEnd(id)) as AnyRecord | undefined;
	assert.ok(fallback?.message);
	const message = fallback.message as AnyRecord;
	return { event, blocked, message, delegation: delegationOf(message), text: textOf(message) };
}

test("外层 15 秒超时：请求禁用重试并归类 timeout", async () => {
	const original = AbortSignal.timeout;
	const timeoutSignal = new AbortController();
	let requestedMs: number | undefined;
	const registry = new Registry();
	const gate = deferred<ClassifierResult>();
	registry.classifyImpl = () => gate.promise;
	const pi = await harness();
	AbortSignal.timeout = ((ms: number) => {
		requestedMs = ms;
		return timeoutSignal.signal;
	}) as typeof AbortSignal.timeout;
	try {
		const event = callEvent("outer-timeout", { prompt: "超时任务" });
		const pending = pi.emit("tool_call", event, context(registry)) as Promise<ToolCallEventResult | undefined>;
		await tick();
		assert.equal(registry.classifyCalls, 1);
		assert.equal(requestedMs, 15_000);
		assert.equal(registry.lastOptions?.timeoutMs, 15_000);
		assert.equal(registry.lastOptions?.maxRetries, 0);
		assert.ok(registry.lastOptions?.signal instanceof AbortSignal);

		timeoutSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		const blocked = await pending;
		assert.equal(blocked?.block, true);
		assert.equal((event.input as AnyRecord).model, undefined);
		assertSafe(blocked);
		const fallback = await pi.emit("message_end", messageEnd("outer-timeout")) as AnyRecord;
		const delegation = delegationOf(fallback.message as AnyRecord);
		assert.equal(delegation.status, "blocked");
		assert.equal(delegation.failureKind, "timeout");
		assertGuideOnce(blocked?.reason ?? "", "timeout 阻止原因");
		assertGuideOnce(textOf(fallback.message as AnyRecord), "timeout 最终消息");
		assertGuideRow(delegation.selectionGuide, candidate("deepseek-flash", "high").model, "可用");
		assertGuideRow(delegation.selectionGuide, candidate("deepseek-flash", "max").model, "可用");
		assertGuideRow(delegation.selectionGuide, candidate("gpt-6-astra", "max").model, "可用");
		assert.ok((delegation.selectionGuide as string).includes("| 不可用 |"));
		assertSafe(fallback);
		gate.resolve(selected());
		await tick();
		assert.equal((event.input as AnyRecord).model, undefined);

		// 超时只影响本次调用；新的独立任务不被会话级冷却拦截。
		AbortSignal.timeout = original;
		registry.classifyImpl = async () => selected();
		const independent = callEvent("after-timeout", { prompt: "另一项独立任务" });
		assert.equal(await pi.emit("tool_call", independent, context(registry)), undefined);
		assert.equal(registry.classifyCalls, 2);
		assert.equal((independent.input as AnyRecord).model, candidate().model);
	} finally {
		AbortSignal.timeout = original;
		gate.resolve(selected());
		await tick();
		await pi.emit("session_shutdown", { type: "session_shutdown" });
	}
});

test("主调用方取消与分类器 aborted 均归类 cancelled", async () => {
	const cancelled = new Registry();
	const gate = deferred<ClassifierResult>();
	cancelled.classifyImpl = () => gate.promise;
	const pi = await harness();
	const caller = new AbortController();
	const event = callEvent("caller-cancel", { prompt: "取消任务" });
	const pending = pi.emit("tool_call", event, context(cancelled, { signal: caller.signal })) as
		Promise<ToolCallEventResult | undefined>;
	await tick();
	caller.abort(new Error("test caller cancellation"));
	const blocked = await pending;
	assert.equal(blocked?.block, true);
	assert.equal((event.input as AnyRecord).model, undefined);
	assertSafe(blocked);
	const fallback = await pi.emit("message_end", messageEnd("caller-cancel")) as AnyRecord;
	const cancelDelegation = delegationOf(fallback.message as AnyRecord);
	assert.equal(cancelDelegation.failureKind, "cancelled");
	assertNoGuide(blocked, textOf(fallback.message as AnyRecord), cancelDelegation);
	assertSafe(fallback);
	// 取消后的迟到成功不能写 model，也不能再触发一次分类或自动再派遣。
	gate.resolve(selected());
	await tick();
	assert.equal((event.input as AnyRecord).model, undefined);
	assert.equal(cancelled.classifyCalls, 1);
	assert.equal(cancelled.chatCalls, 1);
	await pi.emit("session_shutdown", { type: "session_shutdown" });

	const aborted = new Registry();
	aborted.classifyImpl = async () => selected({
		answers: {}, stopReason: "aborted",
		errorMessage: `分类请求已取消。Bearer ${SECRETS.join(" https://")}`,
	});
	const abortedPi = await harness();
	const outcome = await blockedOutcome(abortedPi, aborted, "classifier-aborted");
	assert.equal(outcome.delegation.failureKind, "cancelled");
	assertNoGuide(outcome.blocked, outcome.text, outcome.delegation);
	assertSafe(outcome.blocked);
	assertSafe(outcome.message);
	assert.doesNotMatch(outcome.text, new RegExp(SECRETS.join("|")));
	await abortedPi.emit("session_shutdown", { type: "session_shutdown" });
});

test("adapter 安全 errorMessage 分类，且任意原始文本不进入 reason/details/content", async () => {
	const cases: Array<[string, FailureKind]> = [
		["分类请求认证失败（HTTP 401）。", "authentication"],
		["分类请求认证失败（HTTP 403）。", "authentication"],
		["分类请求缺少有效认证信息。", "authentication"],
		["分类请求被上游限流（HTTP 429）。", "rate_limit"],
		["分类请求失败（HTTP 500）。", "http"],
		["分类网络请求失败。", "network"],
		["分类请求超时。", "timeout"],
		["分类服务返回了无效响应。", "invalid_response"],
		["不支持的分类模型或协议。", "unsupported"],
		["分类请求失败，请检查认证、网络及请求参数。", "unknown"],
	];
	for (const [index, [errorMessage, kind]] of cases.entries()) {
		const registry = new Registry();
		registry.classifyImpl = async () => selected({ answers: {}, stopReason: "error", errorMessage });
		const pi = await harness();
		const outcome = await blockedOutcome(pi, registry, `adapter-kind-${index}`);
		assert.equal(outcome.delegation.failureKind, kind, errorMessage);
		assert.equal(outcome.delegation.status, "blocked");
		assert.equal(typeof outcome.delegation.reason, "string");
		assert.ok(outcome.delegation.reason.length > 0);
		assertGuideOnce(outcome.blocked?.reason ?? "", `${errorMessage} 阻止原因`);
		assertGuideOnce(outcome.text, `${errorMessage} 最终消息`);
		assertGuideRow(outcome.delegation.selectionGuide, candidate("deepseek-flash", "high").model, "可用");
		assertSafe(outcome.blocked, errorMessage);
		assertSafe(outcome.message, errorMessage);
		await pi.emit("session_shutdown", { type: "session_shutdown" });
	}

	const raw = new Registry();
	const rawMessage = `Bearer ${SECRETS[0]} https://${SECRETS[1]}/raw-secret`;
	raw.classifyImpl = async () => selected({ answers: {}, stopReason: "error", errorMessage: rawMessage });
	const pi = await harness();
	const outcome = await blockedOutcome(pi, raw, "adapter-raw-error");
	assert.equal(outcome.delegation.failureKind, "unknown");
	assertGuideOnce(outcome.blocked?.reason ?? "", "原始错误阻止原因");
	assertGuideOnce(outcome.text, "原始错误最终消息");
	assertSafe(outcome.blocked);
	assertSafe(outcome.message);
	assert.doesNotMatch(outcome.text, new RegExp(SECRETS.join("|")));
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("失败后显式 Agent.model 重发跳过分类，每个新失败最多一次 classify", async () => {
	const registry = new Registry();
	let status = 500;
	registry.classifyImpl = async () => selected({
		answers: {}, stopReason: "error",
		errorMessage: status === 500 ? "分类请求失败（HTTP 500）。" : "分类请求被上游限流（HTTP 429）。",
	});
	const pi = await harness();
	const first = await blockedOutcome(pi, registry, "fail-once", { prompt: "第一次失败" });
	assert.equal(first.delegation.failureKind, "http");
	assert.equal(registry.classifyCalls, 1);

	const before = { chat: registry.chatCalls, classifier: registry.classifierCalls, classify: registry.classifyCalls };
	const explicitEvent = callEvent("explicit-after-failure", {
		prompt: "重新派遣任务", model: "tsgw/gpt-6-astra:max",
	});
	assert.equal(await pi.emit("tool_call", explicitEvent, context(registry)), undefined);
	assert.equal((explicitEvent.input as AnyRecord).model, "tsgw/gpt-6-astra:max");
	assert.deepEqual(
		{ chat: registry.chatCalls, classifier: registry.classifierCalls, classify: registry.classifyCalls },
		before,
		"显式 model 不应访问 registry，也不应再次分类",
	);

	status = 429;
	const second = await blockedOutcome(pi, registry, "fail-again", { prompt: "第二次失败" });
	assert.equal(second.delegation.failureKind, "rate_limit");
	assert.equal(registry.classifyCalls, 2, "每个新的失败调用最多分类一次");
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("取消与超时的迟到结果都不写 model", async () => {
	const cancelled = new Registry();
	const cancelGate = deferred<ClassifierResult>();
	cancelled.classifyImpl = () => cancelGate.promise;
	const cancelPi = await harness();
	const caller = new AbortController();
	const cancelEvent = callEvent("late-cancel", { prompt: "迟到取消" });
	const cancelPending = cancelPi.emit("tool_call", cancelEvent,
		context(cancelled, { signal: caller.signal })) as Promise<ToolCallEventResult | undefined>;
	await tick();
	caller.abort();
	assert.equal((await cancelPending)?.block, true);
	cancelGate.resolve(selected());
	await tick();
	assert.equal((cancelEvent.input as AnyRecord).model, undefined);
	assert.equal(cancelled.classifyCalls, 1);
	await cancelPi.emit("session_shutdown", { type: "session_shutdown" });

	const original = AbortSignal.timeout;
	const timeoutSignal = new AbortController();
	const timed = new Registry();
	const timeoutGate = deferred<ClassifierResult>();
	timed.classifyImpl = () => timeoutGate.promise;
	const timeoutPi = await harness();
	AbortSignal.timeout = (() => timeoutSignal.signal) as typeof AbortSignal.timeout;
	try {
		const timeoutEvent = callEvent("late-timeout", { prompt: "迟到超时" });
		const timeoutPending = timeoutPi.emit("tool_call", timeoutEvent, context(timed)) as
			Promise<ToolCallEventResult | undefined>;
		await tick();
		timeoutSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		assert.equal((await timeoutPending)?.block, true);
		const fallback = await timeoutPi.emit("message_end", messageEnd("late-timeout")) as AnyRecord;
		assert.equal(delegationOf(fallback.message as AnyRecord).failureKind, "timeout");
		timeoutGate.resolve(selected());
		await tick();
		assert.equal((timeoutEvent.input as AnyRecord).model, undefined);
		assert.equal(timed.classifyCalls, 1);
	} finally {
		AbortSignal.timeout = original;
		await timeoutPi.emit("session_shutdown", { type: "session_shutdown" });
	}
});

test("本地失败：invalid_input、unavailable、invalid_result、model_unavailable", async () => {
	const invalidInput = new Registry();
	const invalidInputPi = await harness();
	const empty = await blockedOutcome(invalidInputPi, invalidInput, "local-invalid-input", { prompt: "   " });
	assert.equal(empty.delegation.failureKind, "invalid_input");
	assert.equal(invalidInput.chatCalls, 0);
	assertGuideOnce(empty.blocked?.reason ?? "", "invalid_input 阻止原因");
	assertGuideOnce(empty.text, "invalid_input 最终消息");
	assert.ok((empty.delegation.selectionGuide as string).includes("| 未核验 |"));
	assert.equal((empty.delegation.selectionGuide as string).includes("| 可用 |"), false);
	await invalidInputPi.emit("session_shutdown", { type: "session_shutdown" });

	const unavailable = new Registry();
	unavailable.chat = [];
	const unavailablePi = await harness();
	const noCandidate = await blockedOutcome(unavailablePi, unavailable, "local-unavailable");
	assert.equal(noCandidate.delegation.failureKind, "unavailable");
	assert.equal(unavailable.classifyCalls, 0);
	await unavailablePi.emit("session_shutdown", { type: "session_shutdown" });

	const invalidResult = new Registry();
	invalidResult.classifyImpl = async () => selected({
		answers: { kind: choice("implement"), selection: choice("option_not_a_candidate") },
	});
	const invalidResultPi = await harness();
	const badChoice = await blockedOutcome(invalidResultPi, invalidResult, "local-invalid-result");
	assert.equal(badChoice.delegation.failureKind, "invalid_result");
	await invalidResultPi.emit("session_shutdown", { type: "session_shutdown" });

	const removed = new Registry();
	const removedModels = catalog();
	const chosen = candidate();
	removed.chat = [...removedModels];
	removed.classifyImpl = async () => {
		removed.chat = removedModels.filter(model => model.id !== "deepseek-flash");
		return selected({ answers: { kind: choice("implement"), selection: choice(chosen.key) } });
	};
	const removedPi = await harness();
	const modelGone = await blockedOutcome(removedPi, removed, "local-model-unavailable");
	assert.equal(modelGone.delegation.failureKind, "model_unavailable");
	assert.equal(removed.classifyCalls, 1);
	await removedPi.emit("session_shutdown", { type: "session_shutdown" });
});
