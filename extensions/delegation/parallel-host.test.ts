import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildDelegationCandidates } from "#tsgw/delegation/policy";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import {
	fixtureExtension, lastAgentResult, makeGate, resultText, textSse, toolCallSse,
	type AnyRecord, type FixtureState,
} from "./host-test-fixtures.test.ts";

const MAIN_MODEL_ID = "gpt-6-sol";
const LUNA_ID = "gpt-6-luna";
const CLASSIFIER_IDS = ["jev-latest", "jev-preview"] as const;
const BASE_CATALOG = [MAIN_MODEL_ID, LUNA_ID, "jev-latest", "jev-preview", "deepseek-flash", "glm-5.3"];
const FIXTURE_TOOLS = ["Agent", "probe_nested", "get_subagent_result", "steer_subagent"];
// 上游正文只用于确认不泄露，不应出现在结果、文本或 details 中。
const CLASSIFIER_SECRET = "CLASSIFIER-UPSTREAM-BALANCE-DETAIL", CHAT_SECRET = "LUNA-UPSTREAM-FAILURE-DETAIL";
const HISTORY_MARKER = "主会话历史标记-DO-NOT-FORWARD";
const HOST_PROMPT_MARKER = "Host-only private context；不得进入并行选型请求";
// 合成用量：夹具 Agent 10/2、Luna 12/3、系统一分类 20/5；屏障与取消观察都设上限，串行实现快速失败。
const AGENT_TOKENS = { input: 10, output: 2, total: 12 }, CHAT_TOKENS = { input: 12, output: 3, total: 15 };
const CLASSIFIER_TOKENS = { input: 20, output: 5, total: 25 }, CHAT_COST = { input: 0.1, output: 0.5 };
const PARALLEL_TIMEOUT_MS = 3_000, ABORT_TIMEOUT_MS = 5_000;

type ClassifierMode = "error" | "select" | "hang";
type ChatMode = "select" | "invalid" | "error" | "hang";

function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位源码入口");
		dir = parent;
	}
}

/** 聊天通道只有分类器系统提示与一条 user 消息；后者应与原生分类材料逐字一致。 */
function chatMessage(body: AnyRecord): string {
	const input = body.input;
	assert.ok(Array.isArray(input), "Responses 请求必须带 input 数组");
	assert.deepEqual(input.map(item => (item as AnyRecord).role), ["developer", "user"],
		"聊天通道只允许分类器系统提示与原分类材料，不携带会话历史或工具结果");
	const message = input[1] as AnyRecord;
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content));
	return message.content.map(part => String((part as AnyRecord).text ?? "")).join("");
}

function chatSystemPrompt(body: AnyRecord): string {
	const input = body.input;
	assert.ok(Array.isArray(input) && input.length > 0);
	const system = input[0] as AnyRecord;
	assert.ok(system.role === "developer" && typeof system.content === "string");
	return system.content as string;
}

/** System One 成功响应；答案 key 必须落在本次问题枚举内，用量按分类模型目录价计费。 */
function classifierResponse(body: AnyRecord, kind: string, selection: string): Response {
	const questions = body.questions as Record<string, AnyRecord>;
	const answers: AnyRecord = {};
	for (const [id, question] of Object.entries(questions)) {
		const choice = id === "kind" ? kind : selection;
		assert.ok(Object.hasOwn(question.criteria as AnyRecord, choice), `${id} 的答案必须在本次候选枚举内`);
		answers[id] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
	}
	return Response.json({ model: body.model, answers,
		usage: { input_tokens: CLASSIFIER_TOKENS.input, output_tokens: CLASSIFIER_TOKENS.output } });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); });
	});
}

/** HTTP 级同步屏障：两路请求都到达后才释放，串行实现无法通过。 */
function makeCrossGate(expected: number) {
	const gate = makeGate();
	let arrived = 0;
	return {
		arrive: (): Promise<void> => {
			if (++arrived >= expected) gate.open();
			return withTimeout(gate.promise, PARALLEL_TIMEOUT_MS,
				`等待 ${expected} 路选型请求同时到达超时（疑似仍是串行执行）`);
		},
	};
}

/** 只观察胜出后是否主动取消另一路，不依赖真实耗时或 sleep。 */
function abortNotice(signal: AbortSignal | null | undefined): Promise<boolean> {
	if (!signal || signal.aborted) return Promise.resolve(signal?.aborted === true);
	return new Promise<boolean>(resolve => {
		const timer = setTimeout(() => resolve(false), ABORT_TIMEOUT_MS);
		signal.addEventListener("abort", () => { clearTimeout(timer); resolve(true); }, { once: true });
	});
}

// 独立进程；HostSandbox 先隔离 env/网络，之后才动态 import SDK 与 pi-ai。
test("Pi 1.2 delegation：原生分类与聊天模型并行竞速，先通过校验者胜出", { timeout: 90_000 }, async t => {
	const sandbox = new HostSandbox();
	const entry = sourceEntry();
	const fixture: FixtureState = {
		agentCalls: [], resultQueries: [], steers: [], nestedOutcomes: [],
		blockAgent: false, permissionBlocks: 0,
	};
	let session: AgentSession | undefined;
	let runtime: ModelRuntime | undefined;
	try {
		const {
			createAgentSession, DefaultResourceLoader, ModelRuntime: Runtime, SessionManager,
			SettingsManager, VERSION,
		} = await import("@earendil-works/pi-coding-agent");
		const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
		assert.match(VERSION, /^1\.2\./, "此宿主集成回归的已验证基线是 Pi 1.2 SDK");
		writeFileSync(join(sandbox.agentDir, "settings.json"),
			JSON.stringify({ tsgw: { baseUrl: TEST_ROOT } }));
		const guardedFetch = globalThis.fetch;
		const classifierRequests: AnyRecord[] = [];
		const classifierHeaders: Headers[] = [];
		const mainRequests: AnyRecord[] = [];
		const chatRequests: AnyRecord[] = [];
		const plan: { next?: { name: string; args: AnyRecord; callId: string; itemId: string } } = {};
		let callSequence = 0;
		let expectedSelection = "";
		let classifierMode: ClassifierMode = "error";
		let chatMode: ChatMode = "select";
		let classifierAborted = false;
		let chatAborted = false;
		let dropCatalogAfterWin: string | undefined;
		let cross = makeCrossGate(2);
		const arrange = (options: { classifier: ClassifierMode; chat: ChatMode; arrivals?: number }) => {
			classifierMode = options.classifier;
			chatMode = options.chat;
			classifierAborted = chatAborted = false;
			dropCatalogAfterWin = undefined;
			cross = makeCrossGate(options.arrivals ?? 2);
		};
		const queueTool = (name: string, args: AnyRecord) => {
			const id = ++callSequence;
			plan.next = { name, args, callId: `call_fixture_${id}`, itemId: `fc_fixture_${id}` };
		};
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const signal = init?.signal ?? request.signal;
			const url = new URL(request.url);
			if (url.origin === TEST_ROOT && url.pathname === "/v1/systemone") {
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				const body = await request.clone().json() as AnyRecord;
				classifierRequests.push(body);
				classifierHeaders.push(request.headers);
				await cross.arrive();
				if (classifierMode === "hang") {
					classifierAborted = await abortNotice(signal);
					return Response.json({ error: { message: "synthetic cancelled classifier" } }, { status: 499 });
				}
				if (classifierMode === "select") return classifierResponse(body, "implement", expectedSelection);
				// 模拟欠费：原生通道失败不影响另一路，而不是触发第二路串行兜底。
				return Response.json({ error: { message: `synthetic insufficient balance: ${CLASSIFIER_SECRET}` } }, { status: 402 });
			}
			if (url.origin === TEST_ROOT && url.pathname === "/v1/responses") {
				const body = await request.clone().json() as AnyRecord;
				if (body.model === LUNA_ID) {
					assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
					chatRequests.push(body);
					await cross.arrive();
					if (chatMode === "hang") {
						chatAborted = await abortNotice(signal);
						return Response.json({ error: { message: "synthetic cancelled chat" } }, { status: 499 });
					}
					if (chatMode === "error")
						return Response.json({ error: { message: `synthetic luna failure: ${CHAT_SECRET}` } }, { status: 500 });
					if (dropCatalogAfterWin) {
						sandbox.catalogIds = BASE_CATALOG.filter(id => id !== dropCatalogAfterWin);
						dropCatalogAfterWin = undefined;
						await runtime!.refresh({ providers: ["tsgw"], allowNetwork: true, force: true });
					}
					if (chatMode === "invalid") return textSse('{"kind":"implement","selection":"option_999"}');
					return textSse(JSON.stringify({ kind: "implement", selection: expectedSelection }));
				}
				assert.equal(body.model, MAIN_MODEL_ID, "除两路选型外只允许主模型自身的请求");
				mainRequests.push(body);
				const call = plan.next;
				plan.next = undefined;
				return call ? toolCallSse(call) : textSse("fixture main reply");
			}
			return guardedFetch(request);
		};
		const errors: ExtensionError[] = [];
		const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse" });
		const loader = new DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: HOST_PROMPT_MARKER, extensionFactories: [pi => fixtureExtension(pi, fixture)] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		runtime = await Runtime.create({ authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			refreshOnCreate: false, allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
			modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(sandbox.cwd), tools: FIXTURE_TOOLS, thinkingLevel: "off" }));
		sandbox.catalogIds = [...BASE_CATALOG];
		await runtime.setRuntimeApiKey("tsgw", TEST_KEY);
		const refresh = async () => {
			const result = await runtime!.refresh({ providers: ["tsgw"], allowNetwork: true, force: true });
			assert.deepEqual([...result.errors], []);
			assert.equal(result.aborted, false);
		};
		await refresh();
		const mainModel = runtime.getModel("tsgw", MAIN_MODEL_ID);
		assert.ok(mainModel);
		const candidates = buildDelegationCandidates(
			await runtime.getAvailableOfType("chat", "tsgw"), getSupportedThinkingLevels);
		const deepseekHigh = candidates.find(candidate => candidate.id === "deepseek-flash" && candidate.level === "high");
		assert.ok(deepseekHigh, "固定选型表应提供常规工程候选");
		expectedSelection = deepseekHigh.key;
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		session.setActiveToolsByName([...FIXTURE_TOOLS]);
		await session.setModel(mainModel);
		for (const name of FIXTURE_TOOLS) assert.ok(session.getActiveToolNames().includes(name), `${name} 应处于激活状态`);

		await t.test("聊天通道胜出：两路同时到达后一起释放，在飞的分类请求被取消，原 Agent 原参数执行", async () => {
			arrange({ classifier: "hang", chat: "select" });
			const classifiersBefore = classifierRequests.length, chatsBefore = chatRequests.length;
			const mainBefore = mainRequests.length, callsBefore = fixture.agentCalls.length;
			const originalArgs = {
				subagent_type: "general-purpose", prompt: "实现 fixture 并行选型功能", description: "fixture 并行选型",
				run_in_background: true,
			};
			queueTool("Agent", originalArgs);
			await session!.prompt(HISTORY_MARKER);
			assert.equal(classifierRequests.length, classifiersBefore + 1, "原生分类只请求一次");
			assert.equal(chatRequests.length, chatsBefore + 1, "聊天通道只请求一次");
			// 屏障只在两路请求都到达后才释放；分类通道此刻仍未返回即说明没有等待分类失败。
			assert.equal(classifierAborted, true, "聊天通道胜出后必须主动取消仍在飞的分类请求");
			assert.equal(mainRequests.length, mainBefore + 2, "主模型仍是 Sol：工具调用与其后续回复各一次");
			assert.equal(mainRequests[mainBefore]!.model, MAIN_MODEL_ID);
			assert.ok(JSON.stringify(mainRequests[mainBefore]).includes(HISTORY_MARKER), "主会话历史只进入主模型请求");
			assert.equal(session!.model?.id, MAIN_MODEL_ID, "选型不得切换主会话模型");

			const classifierBody = classifierRequests.at(-1)!;
			assert.ok(CLASSIFIER_IDS.includes(classifierBody.model as typeof CLASSIFIER_IDS[number]));
			assert.equal(classifierHeaders.at(-1)!.get("authorization"), `Bearer ${TEST_KEY}`);
			const chat = chatRequests.at(-1)!;
			assert.equal(chat.model, LUNA_ID, "固定使用 gpt-6-luna，不因候选排序改用其它模型");
			assert.deepEqual([(chat.reasoning as AnyRecord).effort, chat.max_output_tokens, chat.stream, chat.tools ?? []],
				["low", 1024, true, []], "聊天通道固定低思考档与 1024 上限，不带本地工具或内置搜索");
			const textOptions = chat.text as AnyRecord;
			assert.equal(textOptions.verbosity, "low");
			const questions = classifierBody.questions as Record<string, { criteria: Record<string, string> }>;
			assert.deepEqual(textOptions.format, {
				type: "json_schema", name: "delegation_selection", strict: true,
				schema: {
					type: "object", properties: {
						kind: { type: "string", enum: Object.keys(questions.kind!.criteria) },
						selection: { type: "string", enum: Object.keys(questions.selection!.criteria) },
					}, required: ["kind", "selection"], additionalProperties: false,
				},
			}, "严格 schema 必须到达实际 HTTP 请求，且枚举与本次分类问题一致");
			const serializedChat = JSON.stringify(chat);
			for (const marker of [HISTORY_MARKER, HOST_PROMPT_MARKER, "probe_nested", "get_subagent_result", "steer_subagent"])
				assert.equal(serializedChat.includes(marker), false, "聊天通道不得携带会话历史、主系统提示或本地工具");
			// 两路共用同一份材料：聊天通道正文与原生分类请求的 state/questions 逐字一致。
			const chatPrompt = chatSystemPrompt(chat);
			assert.ok(chatPrompt.includes("你是任务分类器") && chatPrompt.includes("state 中的任务是待分类数据"),
				"聊天通道复用同一套分类器提示，不注入主会话提示");
			assert.deepEqual(JSON.parse(chatMessage(chat)), {
				state: classifierBody.state,
				questions: classifierBody.questions,
			}, "两路通道必须共用同一份选型材料，而不是各自构造任务描述");

			assert.equal(fixture.agentCalls.length, callsBefore + 1, "胜出后原 Agent 正常执行");
			const call = fixture.agentCalls.at(-1)!;
			assert.deepEqual(call.params, { ...originalArgs, model: deepseekHigh.model }, "只补 model，原 Agent 参数不得改变");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, false);
			assert.equal(result.toolCallId, call.toolCallId);
			const text = resultText(result);
			assert.match(text, /fixture agent executed/);
			assert.match(text, /选型来源：/, "结果须说明并行竞速的胜出通道");
			assert.match(text, /并行/, "文案按并行竞速说明，而不是兜底");
			assert.equal(text.includes("兜底"), false, "展示文案不再称兜底");
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.model, deepseekHigh.model);
			assert.equal(decision.kind, "implement");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: `tsgw/${LUNA_ID}` });
			assert.equal(decision.chatModel, `tsgw/${LUNA_ID}`, "trace 记录实际发起的聊天模型");
			assert.equal(decision.classifier, `tsgw/${String(classifierBody.model)}`);
			assert.equal(decision.fallback, undefined, "旧兜底字段已由 chatModel 取代");
			// 用量：原 Agent + 聊天通道；被取消的分类通道没有可计费用量。
			const usage = result.usage!;
			assert.equal(usage.input, AGENT_TOKENS.input + CHAT_TOKENS.input);
			assert.equal(usage.output, AGENT_TOKENS.output + CHAT_TOKENS.output);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
			const chatInputCost = CHAT_TOKENS.input / 1_000_000 * CHAT_COST.input;
			const chatOutputCost = CHAT_TOKENS.output / 1_000_000 * CHAT_COST.output;
			assert.ok(Math.abs(usage.cost.input - (0.001 + chatInputCost)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + chatOutputCost)) < 1e-12);
			assert.ok(Math.abs(usage.cost.total - (0.003 + chatInputCost + chatOutputCost)) < 1e-12);
			const persisted = session!.sessionManager.getBranch().filter(entry =>
				entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolCallId === result.toolCallId);
			assert.equal(persisted.length, 1, "同一 toolResult 只能持久化一次");
			const stored = persisted[0];
			assert.ok(stored.type === "message" && stored.message.role === "toolResult");
			assert.equal(stored.message.usage?.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total,
				"选型用量只入账一次，不在 message_end 重复累加");
			assert.equal(JSON.stringify(persisted).includes(CLASSIFIER_SECRET), false);
			assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
		});

		await t.test("原生分类胜出：不等聊天通道失败，主动取消在飞请求且文案不再假定分类失败", async () => {
			arrange({ classifier: "select", chat: "hang" });
			const callsBefore = fixture.agentCalls.length, chatsBefore = chatRequests.length;
			queueTool("Agent", { prompt: "核对并行竞速的原生胜出路径", description: "parallel native" });
			await session!.prompt("原生通道先通过校验");
			assert.equal(chatRequests.length, chatsBefore + 1, "聊天通道必须在竞速中真实发起");
			assert.equal(chatAborted, true, "原生分类胜出后必须主动取消仍在飞的聊天请求");
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "原生分类胜出后原 Agent 正常执行");
			const classifierBody = classifierRequests.at(-1)!;
			assert.equal(fixture.agentCalls.at(-1)!.params.model, deepseekHigh.model);
			const result = lastAgentResult(session!)!;
			assert.equal(result.isError, false);
			const text = resultText(result);
			assert.equal(text.includes("兜底"), false, "原生胜出也不得称聊天通道为兜底");
			assert.equal(/原分类模型.*请求失败/.test(text), false, "不得假定原生分类失败");
			assert.match(text, /并行/);
			assert.ok(text.includes(`tsgw/${String(classifierBody.model)}`), "文案须说明原生分类的胜出模型");
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.kind, "implement");
			assert.deepEqual(decision.selectionSource,
				{ type: "classifier", model: `tsgw/${String(classifierBody.model)}` });
			assert.equal(decision.classifier, `tsgw/${String(classifierBody.model)}`);
			assert.equal(decision.chatModel, `tsgw/${LUNA_ID}`, "败路同样记录实际发起的聊天模型");
			// 胜出的原生分类用量必须累计；被取消的聊天通道不假定费用完整。
			const usage = result.usage!;
			assert.ok(usage.totalTokens >= AGENT_TOKENS.total + CLASSIFIER_TOKENS.total,
				"原生分类胜出时其已返回用量必须累计");
			assert.ok(usage.totalTokens <= AGENT_TOKENS.total + CLASSIFIER_TOKENS.total + CHAT_TOKENS.total,
				"取消的聊天通道最多只可能计入已返回部分");
		});

		await t.test("无效聊天结果不成为胜者；原生胜出只累计 SDK 已报告用量", async () => {
			arrange({ classifier: "select", chat: "invalid" });
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "非法聊天结果下的原生胜出", description: "invalid chat" });
			await session!.prompt("聊天通道返回候选表外的 key");
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "非法聊天结果不得阻止原生分类胜出");
			const classifierBody = classifierRequests.at(-1)!;
			const result = lastAgentResult(session!)!;
			assert.equal(result.isError, false);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.model, deepseekHigh.model);
			assert.deepEqual(decision.selectionSource,
				{ type: "classifier", model: `tsgw/${String(classifierBody.model)}` });
			assert.equal(decision.chatModel, `tsgw/${LUNA_ID}`);
			// HTTP 已返回不等于 SDK 已消费；败路取消前报告的用量才可能计入。
			const usage = result.usage!, nativeTokens = AGENT_TOKENS.total + CLASSIFIER_TOKENS.total;
			assert.ok([nativeTokens, nativeTokens + CHAT_TOKENS.total].includes(usage.totalTokens));
			const chatReported = usage.totalTokens > nativeTokens;
			assert.equal(usage.input, AGENT_TOKENS.input + CLASSIFIER_TOKENS.input + (chatReported ? CHAT_TOKENS.input : 0));
			assert.equal(usage.output, AGENT_TOKENS.output + CLASSIFIER_TOKENS.output + (chatReported ? CHAT_TOKENS.output : 0));
			const classifierModel = runtime!.getModelOfType("classifier", "tsgw", String(classifierBody.model));
			const inputRate = classifierModel?.cost?.input, outputRate = classifierModel?.cost?.output;
			assert.ok(typeof inputRate === "number" && typeof outputRate === "number", "分类模型目录价必须可用");
			const chatInputCost = chatReported ? CHAT_TOKENS.input / 1_000_000 * CHAT_COST.input : 0;
			const chatOutputCost = chatReported ? CHAT_TOKENS.output / 1_000_000 * CHAT_COST.output : 0;
			const classifierInputCost = CLASSIFIER_TOKENS.input / 1_000_000 * inputRate;
			const classifierOutputCost = CLASSIFIER_TOKENS.output / 1_000_000 * outputRate;
			assert.ok(Math.abs(usage.cost.input - (0.001 + chatInputCost + classifierInputCost)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + chatOutputCost + classifierOutputCost)) < 1e-12);
		});

		await t.test("两路都失败才阻止创建：保留原 402 安全错误与选型指导，无额外请求", async () => {
			arrange({ classifier: "error", chat: "error" });
			const classifiersBefore = classifierRequests.length, chatsBefore = chatRequests.length;
			const callsBefore = fixture.agentCalls.length, mainBefore = mainRequests.length;
			queueTool("Agent", { subagent_type: "general-purpose", prompt: "两路失败任务", description: "both failure" });
			await session!.prompt("两路都失败的派遣");
			assert.equal(classifierRequests.length, classifiersBefore + 1, "原生分类只请求一次");
			assert.equal(chatRequests.length, chatsBefore + 1, "聊天通道的 500 在 maxRetries=0 下不得重试");
			assert.equal(fixture.agentCalls.length, callsBefore, "两路都失败不得创建子代理");
			assert.equal(mainRequests.length, mainBefore + 2, "主模型只有自身调用与失败后的回复，无额外分类请求");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, true);
			const text = resultText(result);
			assert.ok(text.includes("分类请求失败（HTTP 402）。"), "保留原生分类的 HTTP 402 安全错误");
			assert.match(text, /本次未创建子代理/);
			assert.equal(text.includes("兜底"), false);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.selectionSource, undefined);
			assert.ok(text.includes("选型来源：无"), "两路都没有有效选型时不声称胜出通道");
			assert.equal(decision.failureKind, "http");
			assert.equal(decision.classifier, `tsgw/${String(classifierRequests.at(-1)!.model)}`);
			assert.equal(decision.chatModel, `tsgw/${LUNA_ID}`, "失败 trace 仍记录实际发起过的聊天模型");
			const guide = decision.selectionGuide;
			assert.ok(typeof guide === "string" && guide.length > 0, "必须保留原选型指导");
			assert.ok(guide.includes(`| ${deepseekHigh.model} |`), "指导必须复用本次有效候选");
			assert.equal(text.split(guide).length - 1, 1, "宿主阻止结果仅保留一份选型表");
			assert.equal(result.usage?.totalTokens ?? 0, 0, "两次失败都没有可计费用量");
			for (const secret of [CLASSIFIER_SECRET, CHAT_SECRET, TEST_KEY])
				assert.equal(JSON.stringify(result).includes(secret), false, "不得泄露上游正文或凭据");
		});

		await t.test("胜出后仍复核目录：候选已不在目录时不修改原 Agent 也不创建子代理", async () => {
			arrange({ classifier: "error", chat: "select" });
			dropCatalogAfterWin = "deepseek-flash";
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "胜出后目录变化的任务", description: "catalog recheck" });
			await session!.prompt("胜出后目录复核");
			assert.equal(dropCatalogAfterWin, undefined, "聊天通道必须在返回答案前触发目录变化");
			assert.equal(fixture.agentCalls.length, callsBefore, "复核失败不得创建子代理");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, true);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.failureKind, "model_unavailable");
			assert.match(resultText(result), /不在当前可用候选/);
			sandbox.catalogIds = [...BASE_CATALOG];
			await refresh();
			assert.ok(runtime!.getModel("tsgw", "deepseek-flash"));
		});

		await t.test("会话限定型号与档位：两路与失败接管表共用有效候选", async () => {
			arrange({ classifier: "error", chat: "select" });
			const deepseek = runtime!.getModel("tsgw", "deepseek-flash")!;
			const scope = [{ model: deepseek, thinkingLevel: "max" as const }];
			const scoped = buildDelegationCandidates(await runtime!.getAvailableOfType("chat", "tsgw"),
				getSupportedThinkingLevels, scope);
			assert.equal(scoped.length, 1);
			session!.setScopedModels(scope);
			expectedSelection = scoped[0].key;
			try {
				queueTool("Agent", { prompt: "限定候选的复杂实现", description: "scoped selection" });
				await session!.prompt("仅允许本次指定型号和档位");
				assert.equal(fixture.agentCalls.at(-1)!.params.model, scoped[0].model);
				const native = classifierRequests.at(-1)!;
				const selection = (native.questions as AnyRecord).selection as AnyRecord;
				assert.deepEqual(Object.keys(selection.criteria as AnyRecord), [scoped[0].key, "unresolved"]);
				const chat = chatRequests.at(-1)!;
				assert.deepEqual(JSON.parse(chatMessage(chat)), { state: native.state, questions: native.questions });
				const format = (chat.text as AnyRecord).format as AnyRecord;
				const selectionSchema = ((format.schema as AnyRecord).properties as AnyRecord).selection as AnyRecord;
				assert.deepEqual(selectionSchema.enum, [scoped[0].key, "unresolved"]);
				arrange({ classifier: "error", chat: "error" });
				queueTool("Agent", { prompt: "限定候选的失败接管", description: "scoped guide" });
				await session!.prompt("两路都失败后仍只展示有效候选");
				const decision = (lastAgentResult(session!)!.details as AnyRecord).tsgwDelegation as AnyRecord;
				const rows = (decision.selectionGuide as string).split("\n").filter(line => line.startsWith("| tsgw/"));
				assert.deepEqual(rows, scoped.map(entry => `| ${entry.model} | ${entry.instructions} |`));
			} finally {
				session!.setScopedModels([]);
				expectedSelection = deepseekHigh.key;
			}
		});

		await t.test("聊天模型不在当前目录时只跑原生分类，不臆造第二路", async () => {
			arrange({ classifier: "error", chat: "select", arrivals: 1 });
			sandbox.catalogIds = BASE_CATALOG.filter(id => id !== LUNA_ID);
			await refresh();
			assert.equal(runtime!.getModel("tsgw", LUNA_ID), undefined);
			const classifiersBefore = classifierRequests.length, chatsBefore = chatRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "无聊天模型任务", description: "no luna" });
			await session!.prompt("目录缺少聊天选型模型");
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			assert.equal(chatRequests.length, chatsBefore, "没有可用聊天模型时不得发出第二路请求");
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /分类请求失败（HTTP 402）/);
			const decision = (result!.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.chatModel, undefined, "未发起聊天通道时不记录 chatModel");
			sandbox.catalogIds = [...BASE_CATALOG];
			await refresh();
		});

		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
