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
import { registerDelegation } from "./index.ts";
type Handler = (event: any, ctx: any) => any;
type AnyRecord = Record<string, any>;
type FailureKind = "timeout" | "cancelled" | "authentication" | "rate_limit" | "http" | "network" |
	"invalid_response" | "unsupported" | "unknown" | "invalid_input" | "unavailable" |
	"invalid_result" | "model_unavailable";

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
const catalog = (): Model<Api>[] => [chatModel("deepseek-flash")];
function choice(value: string) {
	return { type: "choice" as const, choice: value, probabilities: { [value]: 1 }, confidence: 1 };
}
/** 只用本次实际下发的候选 key 作答，不复制推荐表、档位或分类说明。 */
function classification(context: ClassifierContext, overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	const criteria = context.questions.selection;
	if (criteria.type !== "choice") throw new Error("selection 必须是 choice");
	const selection = Object.keys(criteria.criteria)[0];
	if (!selection) throw new Error("本次没有可用候选");
	return {
		api: "typesafe-system-one", provider: "tsgw", model: "jev-latest",
		answers: { kind: choice("implement"), selection: choice(selection) },
		usage: USAGE, stopReason: "stop", timestamp: 0, ...overrides,
	};
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
/**
 * 失败接管指导只验证来自本次已核验候选：非空、至少一行候选，并随阻止原因与最终消息给出。
 * 不锁定型号、档位、行数或整表文案。
 */
function assertCandidateGuide(
	outcome: { blocked: ToolCallEventResult | undefined; text: string; message: unknown; delegation: AnyRecord },
	label: string,
): void {
	const guide = outcome.delegation.selectionGuide;
	assert.equal(typeof guide, "string", `${label}应提供本次有效候选指导`);
	assert.match(guide as string, /^\| tsgw\/[^|]+ \|/m, `${label}应至少列出一个本次有效候选`);
	assert.ok(outcome.text.includes(guide as string), `${label}最终消息应附本次指导`);
	assert.ok((outcome.blocked?.reason ?? "").includes(guide as string), `${label}阻止原因应附本次指导`);
	assertSafe(outcome.blocked, label);
	assertSafe(outcome.message, label);
}
/** 早期失败没有已核验候选：仍说明状态，但不得补入或沿用候选表。 */
function assertNoCandidateTable(delegation: AnyRecord, label: string): void {
	assert.equal(typeof delegation.selectionGuide, "string", `${label}应说明未提供候选表`);
	assert.equal((delegation.selectionGuide as string).includes("| tsgw/"), false, `${label}不得补入未核验候选`);
}
class Registry {
	/** 最小宿主目录：只保留真实选型所需的一个型号，不复制推荐型号/档位清单。 */
	chat: Model<Api>[] = catalog();
	classifiers: ClassifierModel<ClassifierApi>[] = [classifierModel()];
	chatCalls = 0;
	classifierCalls = 0;
	classifyCalls = 0;
	lastOptions?: AnyRecord;
	lastContext?: ClassifierContext;
	classifyImpl: (context: ClassifierContext) => Promise<ClassifierResult> = async () => {
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
	async classify(_model: unknown, context: ClassifierContext, options?: AnyRecord): Promise<ClassifierResult> {
		this.classifyCalls++;
		this.lastContext = context;
		this.lastOptions = options;
		return this.classifyImpl(context);
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
		assert.ok(registry.lastOptions?.timeoutMs > 0 && registry.lastOptions?.timeoutMs <= 15_000,
			"请求使用剩余总预算，不重置为完整 15 秒");
		assert.equal(registry.lastOptions?.maxRetries, 0);
		assert.ok(registry.lastOptions?.signal instanceof AbortSignal);

		timeoutSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
		const blocked = await pending;
		assert.equal(blocked?.block, true);
		assert.equal((event.input as AnyRecord).model, undefined);
		const fallback = await pi.emit("message_end", messageEnd("outer-timeout")) as AnyRecord;
		const delegation = delegationOf(fallback.message as AnyRecord);
		assert.equal(delegation.status, "blocked");
		assert.equal(delegation.failureKind, "timeout");
		assertCandidateGuide({ blocked, text: textOf(fallback.message as AnyRecord), message: fallback.message, delegation }, "timeout 接管指导");
		gate.resolve(classification(registry.lastContext!));
		await tick();
		assert.equal((event.input as AnyRecord).model, undefined);

		// 超时只影响本次调用；新的独立任务不被会话级冷却拦截。
		AbortSignal.timeout = original;
		registry.classifyImpl = async context => classification(context);
		const independent = callEvent("after-timeout", { prompt: "另一项独立任务" });
		assert.equal(await pi.emit("tool_call", independent, context(registry)), undefined);
		assert.equal(registry.classifyCalls, 2);
		const independentModel = (independent.input as AnyRecord).model;
		assert.equal(typeof independentModel, "string");
		assert.ok(independentModel.length > 0, "新调用仍应补入非空 model");
	} finally {
		AbortSignal.timeout = original;
		gate.resolve(classification(registry.lastContext!));
		await tick();
		await pi.emit("session_shutdown", { type: "session_shutdown" });
	}
});

test("仅主调用方取消归类 cancelled；单通道 aborted 不冒充整体取消", async () => {
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
	assert.equal(cancelDelegation.selectionGuide, undefined, "取消不得提供候选指导");
	assert.equal((blocked?.reason ?? "").includes("| tsgw/"), false, "取消阻止原因不得含候选表");
	assertSafe(blocked);
	assertSafe(fallback);
	// 取消后的迟到成功不能写 model，也不能再触发一次分类或自动再派遣。
	gate.resolve(classification(cancelled.lastContext!));
	await tick();
	assert.equal((event.input as AnyRecord).model, undefined);
	assert.equal(cancelled.classifyCalls, 1);
	assert.equal(cancelled.chatCalls, 1);
	await pi.emit("session_shutdown", { type: "session_shutdown" });

	const aborted = new Registry();
	aborted.classifyImpl = async context => classification(context, {
		answers: {}, stopReason: "aborted",
		errorMessage: `分类请求已取消。Bearer ${SECRETS.join(" https://")}`,
	});
	const abortedPi = await harness();
	const outcome = await blockedOutcome(abortedPi, aborted, "classifier-aborted");
	assert.equal(outcome.delegation.failureKind, "unknown");
	assertCandidateGuide(outcome, "单通道中止后的整体失败");
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
		registry.classifyImpl = async context => classification(context, { answers: {}, stopReason: "error", errorMessage });
		const pi = await harness();
		const outcome = await blockedOutcome(pi, registry, `adapter-kind-${index}`);
		assert.equal(outcome.delegation.failureKind, kind, errorMessage);
		assert.equal(outcome.delegation.status, "blocked");
		assert.equal(typeof outcome.delegation.reason, "string");
		assert.ok(outcome.delegation.reason.length > 0);
		assertCandidateGuide(outcome, errorMessage);
		await pi.emit("session_shutdown", { type: "session_shutdown" });
	}

	const raw = new Registry();
	const rawMessage = `Bearer ${SECRETS[0]} https://${SECRETS[1]}/raw-secret`;
	raw.classifyImpl = async context => classification(context, { answers: {}, stopReason: "error", errorMessage: rawMessage });
	const pi = await harness();
	const outcome = await blockedOutcome(pi, raw, "adapter-raw-error");
	assert.equal(outcome.delegation.failureKind, "unknown");
	assertCandidateGuide(outcome, "原始错误");
	assert.doesNotMatch(outcome.text, new RegExp(SECRETS.join("|")));
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});

test("失败后显式 Agent.model 重发跳过分类，每个新失败最多一次 classify", async () => {
	const registry = new Registry();
	let status = 500;
	registry.classifyImpl = async context => classification(context, {
		answers: {}, stopReason: "error",
		errorMessage: status === 500 ? "分类请求失败（HTTP 500）。" : "分类请求被上游限流（HTTP 429）。",
	});
	const pi = await harness();
	const first = await blockedOutcome(pi, registry, "fail-once", { prompt: "第一次失败" });
	assert.equal(first.delegation.failureKind, "http");
	assert.equal(registry.classifyCalls, 1);

	const model = "tsgw/test-model:low";
	assertCandidateGuide(first, "失败后接管");
	assert.ok(first.text.includes("Agent.model"), "错误结果应提供实际参数的使用说明");
	const before = { chat: registry.chatCalls, classifier: registry.classifierCalls, classify: registry.classifyCalls };
	const explicitEvent = callEvent("explicit-after-failure", {
		prompt: "重新派遣任务", model,
	});
	assert.equal(await pi.emit("tool_call", explicitEvent, context(registry)), undefined);
	assert.equal((explicitEvent.input as AnyRecord).model, model);
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

test("本地失败：invalid_input、unavailable、invalid_result、model_unavailable", async () => {
	const invalidInput = new Registry();
	const invalidInputPi = await harness();
	const empty = await blockedOutcome(invalidInputPi, invalidInput, "local-invalid-input", { prompt: "   " });
	assert.equal(empty.delegation.failureKind, "invalid_input");
	assert.equal(invalidInput.chatCalls, 0);
	assertNoCandidateTable(empty.delegation, "invalid_input");
	assert.equal(empty.text.includes("| tsgw/"), false);
	await invalidInputPi.emit("session_shutdown", { type: "session_shutdown" });

	const unavailable = new Registry();
	unavailable.chat = [];
	const unavailablePi = await harness();
	const noCandidate = await blockedOutcome(unavailablePi, unavailable, "local-unavailable");
	assert.equal(noCandidate.delegation.failureKind, "unavailable");
	assert.equal(unavailable.classifyCalls, 0);
	assertNoCandidateTable(noCandidate.delegation, "unavailable");
	await unavailablePi.emit("session_shutdown", { type: "session_shutdown" });

	const invalidResult = new Registry();
	invalidResult.classifyImpl = async context => classification(context, {
		answers: { kind: choice("implement"), selection: choice("option_not_a_candidate") },
	});
	const invalidResultPi = await harness();
	const badChoice = await blockedOutcome(invalidResultPi, invalidResult, "local-invalid-result");
	assert.equal(badChoice.delegation.failureKind, "invalid_result");
	await invalidResultPi.emit("session_shutdown", { type: "session_shutdown" });

	const removed = new Registry();
	removed.classifyImpl = async context => {
		// 选定候选所在目录在复核前被撤空，不得改选其他项。
		removed.chat = [];
		return classification(context);
	};
	const removedPi = await harness();
	const modelGone = await blockedOutcome(removedPi, removed, "local-model-unavailable");
	assert.equal(modelGone.delegation.failureKind, "model_unavailable");
	assert.equal(removed.classifyCalls, 1);
	assertNoCandidateTable(modelGone.delegation, "目录撤回后");
	// 分类已完成的用量不因选定模型随后失效而丢失。
	assert.deepEqual(modelGone.message.usage, USAGE);
	await removedPi.emit("session_shutdown", { type: "session_shutdown" });
});

test("执行前目录复核失败：不把较早的候选快照作为当前可选表", async () => {
	const registry = new Registry();
	registry.classifyImpl = async context => classification(context);
	const lookup = registry.getAvailableOfType.bind(registry);
	registry.getAvailableOfType = async type => {
		if (type === "chat" && registry.chatCalls > 0) throw new Error("合成目录读取失败");
		return lookup(type);
	};
	const pi = await harness();
	const outcome = await blockedOutcome(pi, registry, "revalidation-failed");
	assert.equal(outcome.delegation.failureKind, "unknown");
	assert.equal(registry.classifyCalls, 1);
	assertNoCandidateTable(outcome.delegation, "复核失败后");
	await pi.emit("session_shutdown", { type: "session_shutdown" });
});
