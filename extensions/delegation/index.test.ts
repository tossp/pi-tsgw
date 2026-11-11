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
import { registerDelegation } from "./index.ts";
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
/** 只断言宿主补参契约，不锁定当前推荐表选中的型号或档位。 */
function injectedModel(event: ToolCallEvent): string {
	const model = (event.input as AnyRecord).model;
	assert.equal(typeof model, "string");
	assert.match(model as string, /^tsgw\/.+:.+$/);
	return model as string;
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
/** 只用本次实际下发的候选 key 作答，不复制推荐表、档位或分类说明。 */
function classification(context: ClassifierContext, overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	const criteria = context.questions.selection;
	if (criteria.type !== "choice") throw new Error("selection 必须是 choice");
	const selection = Object.keys(criteria.criteria)[0];
	if (!selection) throw new Error("本次没有可用候选");
	return {
		api: "typesafe-system-one", provider: "tsgw", model: "jev-latest",
		answers: { kind: choice("implement"), selection: choice(selection) },
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
	/** 最小宿主目录：只保留真实选型所需的一个型号，不复制推荐型号/档位清单。 */
	chat: Model<Api>[] = [chatModel("deepseek-flash")];
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
function context(registry: Registry, options: { signal?: AbortSignal } = {}): ExtensionContext {
	return { modelRegistry: registry, scopedModels: [], signal: options.signal } as unknown as ExtensionContext;
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
		const registry = new Registry();
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
		gate.resolve(classification(registry.lastContext!));
		assert.deepEqual(await Promise.all(waiting), [undefined, undefined]);
		const model = injectedModel(first);
		assert.equal((second.input as AnyRecord).model, model, "同调用去重必须补入同一模型");
		await pi.emit("tool_result", resultEvent("same-id"));
		const resume = callEvent("resume-id", { prompt: "追加任务", resume: "child-session-42" });
		assert.equal(await pi.emit("tool_call", resume, context(registry)), undefined);
		assert.equal((resume.input as AnyRecord).model, undefined);
		assert.equal(registry.classifyCalls, 1);
		const concurrent = new Registry();
		const contexts: ClassifierContext[] = [];
		const gates = [deferred<ClassifierResult>(), deferred<ClassifierResult>()];
		let next = 0;
		concurrent.classifyImpl = context => { contexts.push(context); return gates[next++].promise; };
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
		gates[0].resolve(classification(contexts[0]!));
		await tick();
		assert.equal((eventA.input as AnyRecord).model, undefined);
		gates[1].resolve(classification(contexts[1]!));
		assert.equal(await pendingB, undefined);
		injectedModel(eventB);
		assert.equal(concurrent.classifyCalls, 2);
		await concurrentPi.emit("session_shutdown", { type: "session_shutdown" });
	});

	await t.test("会话 shutdown 阻止等待中的选型：迟到结果与退出后的新调用都不写 model", async () => {
		const shutdown = new Registry();
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
		shutdownGate.resolve(classification(shutdown.lastContext!));
		await tick();
		assert.equal((shutdownEvent.input as AnyRecord).model, undefined);
		const afterShutdown = callEvent("after-shutdown", { prompt: "退出后" });
		assert.equal(await shutdownPi.emit("tool_call", afterShutdown, context(shutdown)), undefined);
		assert.equal((afterShutdown.input as AnyRecord).model, undefined);
		assert.equal(shutdown.chatCalls, 1);
		assert.equal(shutdown.classifyCalls, 1);
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
		const registry = new Registry();
		registry.classifyImpl = async context => classification(context);
		const pi = await harness();
		const call = callEvent("result-id", { prompt: "结果任务" });
		assert.equal(await pi.emit("tool_call", call, context(registry)), undefined);
		const model = injectedModel(call);
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
		const summaryText = summary?.type === "text" ? summary.text : "";
		assert.ok(summaryText.includes(model), "摘要应给出本次实际补入的模型");
		assert.equal(result.structuredContent, structuredContent);
		const resultDetails = result.details as AnyRecord;
		assert.equal(resultDetails.kind, "host-agent-result");
		assert.equal(resultDetails.sessionId, "child-session-42");
		const delegation = resultDetails.tsgwDelegation as AnyRecord;
		assert.equal(delegation.status, "selected");
		assert.equal(delegation.model, model, "结果记录必须与本次补参一致");
		assert.equal(delegation.selectionSource?.type, "classifier");
		assert.equal(delegation.selectionSource?.model, "tsgw/jev-latest");
		assert.ok(summaryText.includes(String(delegation.selectionSource?.model)), "摘要来源必须与实际来源一致");
		assert.deepEqual(result.usage, COMBINED_USAGE);
		assert.equal(await pi.emit("tool_result", resultEvent("result-id", { usage: CHILD_USAGE })), undefined);
		// 成功路径已由 tool_result 消费；同一最终消息在 message_end 不得再次加账。
		assert.equal(await pi.emit("message_end", messageEndEvent("result-id", {
			content: result.content, details: result.details, usage: result.usage, isError: false,
		})), undefined);
	});

	await t.test("执行前阻止的 message_end fallback：分类 usage 计入且只加一次", async () => {
		const registry = new Registry();
		registry.classifyImpl = async context => classification(context, {
			answers: {}, stopReason: "error", usage: CLASSIFIER_USAGE,
		});
		const pi = await harness();
		const call = callEvent("failed-classify", { prompt: "失败任务" });
		const blocked = await pi.emit("tool_call", call,
			context(registry)) as ToolCallEventResult | undefined;
		assert.equal(blocked?.block, true);
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
		const delegation = (message.details as AnyRecord).tsgwDelegation as AnyRecord;
		assert.equal(delegation.status, "blocked");
		assert.equal(delegation.classifier, "tsgw/jev-latest");
		assert.deepEqual(message.usage, CLASSIFIER_USAGE);
		assert.equal(await pi.emit("message_end",
			messageEndEvent("failed-classify")), undefined, "同一记录不能在 message_end 重复加账");
	});

	await t.test("agent_end 清理等待中与已选定的过期记录", async () => {
		const registry = new Registry();
		const gate = deferred<ClassifierResult>();
		registry.classifyImpl = () => gate.promise;
		const pi = await harness();
		const inflight = callEvent("agent-end-inflight", { prompt: "等待中" });
		const pending = pi.emit("tool_call", inflight,
			context(registry)) as Promise<ToolCallEventResult | undefined>;
		await tick();
		await pi.emit("agent_end", { type: "agent_end" });
		assert.equal((await pending)?.block, true);
		gate.resolve(classification(registry.lastContext!));
		await tick();
		assert.equal((inflight.input as AnyRecord).model, undefined);
		assert.equal(await pi.emit("message_end", messageEndEvent("agent-end-inflight")), undefined);
		const completed = new Registry();
		completed.classifyImpl = async context => classification(context);
		const completedPi = await harness();
		const completedCall = callEvent("agent-end-completed", { prompt: "已完成选型" });
		assert.equal(await completedPi.emit("tool_call", completedCall, context(completed)), undefined);
		injectedModel(completedCall);
		await completedPi.emit("agent_end", { type: "agent_end" });
		assert.equal(await completedPi.emit("message_end", messageEndEvent("agent-end-completed")), undefined);
	});

	await t.test("常驻注入只给调用契约：保留宿主提示，不提前注入候选表或接管说明，shutdown 后不再注入", async () => {
		const pi = await harness();
		const sections: Record<string, string> = { host: "宿主提示标记" };
		assert.equal(await pi.emit("before_agent_start", { systemPromptOptions: { sections } }), undefined);
		assert.equal(sections.host, "宿主提示标记", "不覆盖宿主已有分区");
		const guidance = sections.tsgw_delegation;
		assert.ok(guidance, "应写入独立的常驻分区");
		for (const term of ["Agent", "model", "resume"]) assert.ok(guidance.includes(term), `调用契约缺少 ${term}`);
		assert.equal(guidance.includes("| tsgw/"), false, "常驻注入不包含候选表");
		assert.equal(guidance.includes("本次未创建子代理"), false, "失败接管说明只随工具结果给出");
		// 旧宿主没有分区结构时，回退为追加到原 systemPrompt 末尾。
		const legacy = await pi.emit("before_agent_start", { systemPrompt: "宿主原始提示" });
		assert.equal(legacy.systemPrompt, `宿主原始提示\n\n${guidance}`);
		await pi.emit("session_shutdown", { type: "session_shutdown" });
		assert.equal(await pi.emit("before_agent_start", { systemPrompt: "结束后" }), undefined,
			"shutdown 后不再注入常驻分区");
	});
});
