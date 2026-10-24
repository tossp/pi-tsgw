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
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { buildDelegationCandidates, type DelegationCandidate } from "./policy.ts";
import { registerDelegation } from "./index.ts";
const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
type Handler = (event: any, ctx: any) => any;
type AnyRecord = Record<string, any>;
function chatModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id, name: id, provider: "tsgw", api: "openai-responses",
		baseUrl: "https://models.example.test/v1", input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		contextWindow: 128_000, maxTokens: 32_000,
		...overrides,
	};
}
function classifierModel(overrides: Partial<ClassifierModel<ClassifierApi>> = {}): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier", id: "jev-latest", name: "jev-latest", provider: "tsgw",
		api: "typesafe-system-one", baseUrl: "https://models.example.test/v1",
		input: ["text"], cost: { input: 0.5, output: 0.1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000, ...overrides,
	};
}
const CHAT_IDS = ["MiniMax-M3.1-Flash", "gpt-6-luna", "glm-5.3", "glm-5.3-flash",
	"gpt-6.1-sol", "deepseek-flash", "gpt-6-astra", "kimi-k3"];
const catalog = (): Model<Api>[] => CHAT_IDS.map(id => chatModel(id));
function candidatesFor(models: readonly Model<Api>[]): DelegationCandidate[] {
	return buildDelegationCandidates(models, getSupportedThinkingLevels);
}
function pick(models: readonly Model<Api>[], id: string, level: DelegationCandidate["level"]): DelegationCandidate {
	const candidate = candidatesFor(models).find(entry => entry.id === id && entry.level === level);
	if (!candidate) throw new Error(`缺少候选 ${id}:${level}`);
	return candidate;
}
const CHILD_USAGE: Usage = {
	input: 10, output: 4, cacheRead: 2, cacheWrite: 3, cacheWrite1h: 1, reasoning: 2,
	totalTokens: 19, cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
};
const CLASSIFIER_USAGE: Usage = {
	input: 100, output: 20, cacheRead: 10, cacheWrite: 5, cacheWrite1h: 4, reasoning: 8,
	totalTokens: 120, cost: { input: 1, output: 2, cacheRead: 0.3, cacheWrite: 0.4, total: 3.7 },
};
const COMBINED_USAGE: Usage = {
	input: 110, output: 24, cacheRead: 12, cacheWrite: 8, cacheWrite1h: 5, reasoning: 10,
	totalTokens: 139, cost: {
		input: CHILD_USAGE.cost.input + CLASSIFIER_USAGE.cost.input,
		output: CHILD_USAGE.cost.output + CLASSIFIER_USAGE.cost.output,
		cacheRead: CHILD_USAGE.cost.cacheRead + CLASSIFIER_USAGE.cost.cacheRead,
		cacheWrite: CHILD_USAGE.cost.cacheWrite + CLASSIFIER_USAGE.cost.cacheWrite,
		total: CHILD_USAGE.cost.total + CLASSIFIER_USAGE.cost.total,
	},
};
function choice(value: string) {
	return { type: "choice" as const, choice: value, probabilities: { [value]: 1 }, confidence: 1 };
}
function classification(candidate: DelegationCandidate, overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return {
		api: "typesafe-system-one", provider: "tsgw", model: "jev-latest",
		answers: { kind: choice("implement"), selection: choice(candidate.key) },
		usage: CLASSIFIER_USAGE, stopReason: "stop", timestamp: 0, ...overrides,
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
class Registry {
	chat: Model<Api>[] = catalog();
	classifiers: ClassifierModel<ClassifierApi>[] = [classifierModel()];
	chatCalls = 0;
	classifierCalls = 0;
	classifyCalls = 0;
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
	async classify(_model: unknown, context: ClassifierContext): Promise<ClassifierResult> {
		this.classifyCalls++;
		this.lastContext = context;
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
function agentTool(overrides: AnyRecord = {}): AnyRecord {
	return {
		name: "Agent", description: "test-only Agent", exposure: "model-only",
		parameters: {
			type: "object",
			properties: { prompt: { type: "string" }, model: { type: "string" }, resume: { type: "string" } },
		},
		...overrides,
	};
}
function context(registry: Registry, options: { scope?: Model<Api>[]; signal?: AbortSignal } = {}): ExtensionContext {
	return {
		modelRegistry: registry,
		scopedModels: (options.scope ?? []).map(model => ({ model })),
		signal: options.signal,
	} as unknown as ExtensionContext;
}
function callEvent(
	id: string,
	input: Record<string, unknown>,
	options: { toolName?: string; parentToolCallId?: string } = {},
): ToolCallEvent {
	return {
		type: "tool_call", toolCallId: id, toolName: options.toolName ?? "Agent",
		input, ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
	} as unknown as ToolCallEvent;
}
function resultEvent(id: string, overrides: AnyRecord = {}): ToolResultEvent {
	return {
		type: "tool_result", toolCallId: id, toolName: "Agent", input: {},
		content: [{ type: "text", text: "原始结果" }], isError: false,
		details: { kind: "host-agent-result", sessionId: "child-session-42", host: { marker: "keep" } },
		structuredContent: { status: "ok", nested: { marker: "keep" } },
		usage: CHILD_USAGE, ...overrides,
	} as unknown as ToolResultEvent;
}
function messageEndEvent(id: string, overrides: AnyRecord = {}): AnyRecord {
	return {
		type: "message_end",
		message: {
			role: "toolResult", toolCallId: id, toolName: "Agent",
			content: [{ type: "text", text: "执行前已阻止" }], details: {}, isError: true,
			timestamp: 0, ...overrides,
		},
	};
}
async function harness(tools: unknown[] = [agentTool()]): Promise<TestPi> {
	const pi = new TestPi(tools);
	registerDelegation(pi as unknown as ExtensionAPI);
	await pi.emit("session_start", { type: "session_start", reason: "startup" });
	return pi;
}

test("delegation 生命周期、竞态与用量", async t => {
	await t.test("非 Agent、显式 model/resume 与不兼容 Agent 完全不访问 registry", async () => {
		const registry = new Registry();
		const pi = await harness();
		const skipped = [
			callEvent("skip-read", { prompt: "读取" }, { toolName: "read" }),
			callEvent("skip-model", { prompt: "任务", model: "tsgw/gpt-6-astra:max" }),
			callEvent("skip-resume", { prompt: "任务", resume: "session-old" }),
			callEvent("skip-resume-model", { prompt: "追加", resume: "session-old", model: "tsgw/gpt-6-astra:max" }),
			callEvent("skip-query", { agent_id: "session-old" }, { toolName: "get_subagent_result" }),
			callEvent("skip-steer", { agent_id: "session-old", message: "追加" }, { toolName: "steer_subagent" }),
		];
		for (const event of skipped) {
			const before = structuredClone(event.input);
			assert.equal(await pi.emit("tool_call", event, context(registry)), undefined);
			assert.deepEqual(event.input, before);
		}
		const incompatible: unknown[][] = [
			[],
			[agentTool({ parameters: { type: "object", properties: {
				prompt: { type: "string" }, model: { type: "string" },
			} } })],
			[agentTool({ parameters: { type: "object", properties: {
				prompt: { type: "string" }, model: { type: "number" }, resume: { type: "string" },
			} } })],
			[agentTool({ parameters: [] })],
		];
		for (const tools of incompatible) {
			const badPi = await harness(tools);
			const event = callEvent("skip-schema", { prompt: "任务" });
			assert.equal(await badPi.emit("tool_call", event, context(registry)), undefined);
			assert.equal((event.input as AnyRecord).model, undefined);
		}
		assert.deepEqual([registry.chatCalls, registry.classifierCalls, registry.classifyCalls], [0, 0, 0]);
	});

	await t.test("新建选型不依赖暴露方式或嵌套入口，同调用去重且独立创建各自取消", async () => {
		const models = catalog();
		const selected = pick(models, "deepseek-flash", "high");
		const registry = new Registry();
		registry.chat = models;
		const gate = deferred<ClassifierResult>();
		registry.classifyImpl = () => gate.promise;
		const pi = await harness([agentTool({ exposure: "direct" })]);
		const first = callEvent("same-id", { prompt: "同一调用" }, { parentToolCallId: "parent-call" });
		const second = callEvent("same-id", { prompt: "同一调用" }, { parentToolCallId: "parent-call" });
		const waiting = [
			pi.emit("tool_call", first, context(registry)) as Promise<ToolCallEventResult | undefined>,
			pi.emit("tool_call", second, context(registry)) as Promise<ToolCallEventResult | undefined>,
		];
		await tick();
		assert.deepEqual([registry.chatCalls, registry.classifierCalls, registry.classifyCalls], [1, 1, 1]);
		gate.resolve(classification(selected));
		assert.deepEqual(await Promise.all(waiting), [undefined, undefined]);
		assert.equal((first.input as AnyRecord).model, selected.model);
		assert.equal((second.input as AnyRecord).model, selected.model);
		await pi.emit("tool_result", resultEvent("same-id"));
		const resume = callEvent("resume-id", { prompt: "追加任务", resume: "child-session-42" });
		assert.equal(await pi.emit("tool_call", resume, context(registry)), undefined);
		assert.equal((resume.input as AnyRecord).model, undefined);
		assert.equal(registry.classifyCalls, 1);
		const concurrent = new Registry();
		concurrent.chat = models;
		const gates = [deferred<ClassifierResult>(), deferred<ClassifierResult>()];
		let next = 0;
		concurrent.classifyImpl = () => gates[next++].promise;
		const concurrentPi = await harness([agentTool({ exposure: undefined })]);
		const controllerA = new AbortController();
		const controllerB = new AbortController();
		const eventA = callEvent("parallel-a", { prompt: "并发 A" });
		const eventB = callEvent("parallel-b", { prompt: "并发 B" });
		const pendingA = concurrentPi.emit("tool_call", eventA,
			context(concurrent, { signal: controllerA.signal })) as Promise<ToolCallEventResult | undefined>;
		const pendingB = concurrentPi.emit("tool_call", eventB,
			context(concurrent, { signal: controllerB.signal })) as Promise<ToolCallEventResult | undefined>;
		await tick();
		assert.equal(concurrent.classifyCalls, 2);
		controllerA.abort();
		const blockedA = await pendingA;
		assert.equal(blockedA?.block, true);
		assert.equal((eventA.input as AnyRecord).model, undefined);
		gates[0].resolve(classification(selected));
		await tick();
		assert.equal((eventA.input as AnyRecord).model, undefined);
		gates[1].resolve(classification(selected));
		assert.equal(await pendingB, undefined);
		assert.equal((eventB.input as AnyRecord).model, selected.model);
		assert.equal(concurrent.classifyCalls, 2);
		await concurrentPi.emit("session_shutdown", { type: "session_shutdown" });
	});

	await t.test("分类等待 abort 或会话 shutdown 后，迟到的成功结果不能写 model", async () => {
		const models = catalog();
		const selected = pick(models, "deepseek-flash", "high");
		const aborted = new Registry();
		aborted.chat = models;
		const abortGate = deferred<ClassifierResult>();
		aborted.classifyImpl = () => abortGate.promise;
		const abortPi = await harness();
		const controller = new AbortController();
		const abortEvent = callEvent("abort-id", { prompt: "取消任务" });
		const abortPending = abortPi.emit("tool_call", abortEvent,
			context(aborted, { signal: controller.signal })) as Promise<ToolCallEventResult | undefined>;
		await tick();
		controller.abort();
		const abortResult = await abortPending;
		assert.equal(abortResult?.block, true);
		abortGate.resolve(classification(selected));
		await tick();
		assert.equal((abortEvent.input as AnyRecord).model, undefined);
		assert.equal(aborted.chatCalls, 1);
		assert.equal(aborted.classifyCalls, 1);
		await abortPi.emit("session_shutdown", { type: "session_shutdown" });
		const shutdown = new Registry();
		shutdown.chat = models;
		const shutdownGate = deferred<ClassifierResult>();
		shutdown.classifyImpl = () => shutdownGate.promise;
		const shutdownPi = await harness();
		const shutdownEvent = callEvent("shutdown-id", { prompt: "退出任务" });
		const shutdownPending = shutdownPi.emit("tool_call", shutdownEvent,
			context(shutdown)) as Promise<ToolCallEventResult | undefined>;
		await tick();
		await shutdownPi.emit("session_shutdown", { type: "session_shutdown" });
		const shutdownResult = await shutdownPending;
		assert.equal(shutdownResult?.block, true);
		shutdownGate.resolve(classification(selected));
		await tick();
		assert.equal((shutdownEvent.input as AnyRecord).model, undefined);
		const afterShutdown = callEvent("after-shutdown", { prompt: "退出后" });
		assert.equal(await shutdownPi.emit("tool_call", afterShutdown, context(shutdown)), undefined);
		assert.equal((afterShutdown.input as AnyRecord).model, undefined);
		assert.equal(shutdown.chatCalls, 1);
		assert.equal(shutdown.classifyCalls, 1);
	});

	await t.test("分类后目录撤下选定 model 时阻止，不静默改选其他候选", async () => {
		const models = catalog();
		const selected = pick(models, "deepseek-flash", "high");
		const registry = new Registry();
		registry.chat = [...models];
		registry.classifyImpl = async () => {
			registry.chat = models.filter(model => model.id !== "deepseek-flash");
			return classification(selected);
		};
		const pi = await harness();
		const event = callEvent("removed-id", { prompt: "目录变化任务" });
		const blocked = await pi.emit("tool_call", event, context(registry)) as ToolCallEventResult | undefined;
		assert.equal(blocked?.block, true);
		assert.equal((event.input as AnyRecord).model, undefined);
		assert.equal(registry.chatCalls, 2);
		assert.equal(registry.classifyCalls, 1);
	});

	await t.test("ctx.scope 只把会话范围内的候选交给分类器", async () => {
		const models = catalog();
		const astra = models.find(model => model.id === "gpt-6-astra");
		assert.ok(astra);
		const scopedCandidates = candidatesFor([astra]);
		const selected = scopedCandidates.find(candidate => candidate.id === "gpt-6-astra" && candidate.level === "high");
		assert.ok(selected);
		const registry = new Registry();
		registry.chat = models;
		let criteriaKeys: string[] = [];
		registry.classifyImpl = async ctx => {
			assert.equal(ctx.questions.selection.type, "choice");
			if (ctx.questions.selection.type !== "choice") assert.fail("selection 必须是 choice");
			criteriaKeys = Object.keys(ctx.questions.selection.criteria);
			return classification(selected);
		};
		const pi = await harness();
		const event = callEvent("scoped-id", { prompt: "范围任务" });
		assert.equal(await pi.emit("tool_call", event,
			context(registry, { scope: [astra] })), undefined);
		assert.deepEqual(criteriaKeys, [...scopedCandidates.map(candidate => candidate.key), "unresolved"]);
		assert.equal((event.input as AnyRecord).model, selected.model);
		assert.equal(registry.chatCalls, 2);
		assert.equal(registry.classifyCalls, 1);
	});

	await t.test("无候选、无分类器或材料过大都不会发起付费 classify", async () => {
		const noCandidates = new Registry();
		noCandidates.chat = [];
		const noCandidatesPi = await harness();
		const noCandidateEvent = callEvent("no-candidates", { prompt: "任务" });
		const noCandidateResult = await noCandidatesPi.emit("tool_call", noCandidateEvent,
			context(noCandidates)) as ToolCallEventResult | undefined;
		assert.equal(noCandidateResult?.block, true);
		assert.deepEqual([noCandidates.chatCalls, noCandidates.classifierCalls, noCandidates.classifyCalls], [1, 0, 0]);
		const noClassifier = new Registry();
		noClassifier.classifiers = [];
		const noClassifierPi = await harness();
		const noClassifierEvent = callEvent("no-classifier", { prompt: "任务" });
		const noClassifierResult = await noClassifierPi.emit("tool_call", noClassifierEvent,
			context(noClassifier)) as ToolCallEventResult | undefined;
		assert.equal(noClassifierResult?.block, true);
		assert.deepEqual([noClassifier.classifierCalls, noClassifier.classifyCalls], [1, 0]);
		const oversized = new Registry();
		const oversizedPi = await harness();
		const oversizedEvent = callEvent("oversized", { prompt: "x".repeat(40_000) });
		const oversizedResult = await oversizedPi.emit("tool_call", oversizedEvent,
			context(oversized)) as ToolCallEventResult | undefined;
		assert.equal(oversizedResult?.block, true);
		assert.deepEqual([oversized.chatCalls, oversized.classifierCalls, oversized.classifyCalls], [1, 0, 0]);
		for (const event of [noCandidateEvent, noClassifierEvent, oversizedEvent])
			assert.equal((event.input as AnyRecord).model, undefined);
	});

	await t.test("tool_result 保留原字段并完整合并子工具与分类 usage，message_end 不重复加账", async () => {
		const models = catalog();
		const selected = pick(models, "deepseek-flash", "high");
		const registry = new Registry();
		registry.chat = models;
		registry.classifyImpl = async () => classification(selected);
		const pi = await harness();
		const call = callEvent("result-id", { prompt: "结果任务" });
		assert.equal(await pi.emit("tool_call", call, context(registry)), undefined);
		assert.equal((call.input as AnyRecord).model, selected.model);
		const originalContent = [
			{ type: "text" as const, text: "原始结果" },
			{ type: "text" as const, text: "第二段" },
		];
		const structuredContent = { status: "ok", nested: { marker: "keep" } };
		const details = { kind: "host-agent-result", sessionId: "child-session-42", host: { marker: "keep" } };
		const result = await pi.emit("tool_result", resultEvent("result-id", {
			content: originalContent, structuredContent, details, usage: CHILD_USAGE,
		})) as ToolResultEventResult | undefined;
		assert.ok(result?.content);
		assert.deepEqual(result.content.slice(0, -1), originalContent);
		const summary = result.content.at(-1);
		assert.equal(summary?.type, "text");
		assert.match(summary?.type === "text" ? summary.text : "", new RegExp(
			selected.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(result.structuredContent, structuredContent);
		const resultDetails = result.details as AnyRecord;
		assert.equal(resultDetails.kind, "host-agent-result");
		assert.equal(resultDetails.sessionId, "child-session-42");
		assert.equal((resultDetails.tsgwDelegation as AnyRecord).status, "selected");
		assert.deepEqual(result.usage, COMBINED_USAGE);
		assert.equal(await pi.emit("tool_result", resultEvent("result-id", { usage: CHILD_USAGE })), undefined);
		// 成功路径已由 tool_result 消费；同一最终消息在 message_end 不得再次加账。
		assert.equal(await pi.emit("message_end", messageEndEvent("result-id", {
			content: result.content, details: result.details, usage: result.usage, isError: false,
		})), undefined);
	});

	await t.test("执行前阻止的 message_end fallback：失败分类 usage 计入且不泄露原始错误", async () => {
		const models = catalog();
		const selected = pick(models, "deepseek-flash", "high");
		const secret = "Bearer sk-live-hidden https://internal.example.test/classify";
		const registry = new Registry();
		registry.chat = models;
		registry.classifyImpl = async () => classification(selected, {
			answers: {}, stopReason: "error", usage: CLASSIFIER_USAGE, errorMessage: secret,
		});
		const pi = await harness();
		const call = callEvent("failed-classify", { prompt: "失败任务" });
		const blocked = await pi.emit("tool_call", call,
			context(registry)) as ToolCallEventResult | undefined;
		assert.equal(blocked?.block, true);
		assert.doesNotMatch(blocked?.reason ?? "", /sk-live-hidden|internal\.example/);
		assert.equal((call.input as AnyRecord).model, undefined);
		// 宿主在执行前阻止时只发最终 toolResult 消息，不发 tool_result。
		const fallback = await pi.emit("message_end",
			messageEndEvent("failed-classify")) as AnyRecord | undefined;
		assert.ok(fallback?.message);
		const message = fallback.message as AnyRecord;
		const content = message.content as Array<{ type: string; text?: string }>;
		assert.equal(content.length, 2);
		assert.equal(content[0].text, "执行前已阻止");
		assert.equal(message.isError, true);
		assert.equal(JSON.stringify(message).includes("sk-live-hidden"), false);
		assert.equal(JSON.stringify(message).includes("internal.example"), false);
		const delegation = (message.details as AnyRecord).tsgwDelegation as AnyRecord;
		assert.equal(delegation.status, "blocked");
		assert.equal(delegation.classifier, "tsgw/jev-latest");
		assert.doesNotMatch(delegation.reason, /sk-live-hidden|internal\.example/);
		assert.deepEqual(message.usage, CLASSIFIER_USAGE);
		assert.equal(await pi.emit("message_end",
			messageEndEvent("failed-classify")), undefined, "同一记录不能在 message_end 重复加账");
	});

	await t.test("agent_end 清理等待中与已选定的过期记录", async () => {
		const models = catalog();
		const selected = pick(models, "deepseek-flash", "high");
		const registry = new Registry();
		registry.chat = models;
		const gate = deferred<ClassifierResult>();
		registry.classifyImpl = () => gate.promise;
		const pi = await harness();
		const inflight = callEvent("agent-end-inflight", { prompt: "等待中" });
		const pending = pi.emit("tool_call", inflight,
			context(registry)) as Promise<ToolCallEventResult | undefined>;
		await tick();
		await pi.emit("agent_end", { type: "agent_end" });
		assert.equal((await pending)?.block, true);
		gate.resolve(classification(selected));
		await tick();
		assert.equal((inflight.input as AnyRecord).model, undefined);
		assert.equal(await pi.emit("message_end", messageEndEvent("agent-end-inflight")), undefined);
		const completed = new Registry();
		completed.chat = models;
		completed.classifyImpl = async () => classification(selected);
		const completedPi = await harness();
		const completedCall = callEvent("agent-end-completed", { prompt: "已完成选型" });
		assert.equal(await completedPi.emit("tool_call", completedCall, context(completed)), undefined);
		assert.equal((completedCall.input as AnyRecord).model, selected.model);
		await completedPi.emit("agent_end", { type: "agent_end" });
		assert.equal(await completedPi.emit("message_end", messageEndEvent("agent-end-completed")), undefined);
	});
});
