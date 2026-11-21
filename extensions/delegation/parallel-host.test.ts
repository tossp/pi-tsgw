import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, ExtensionError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import {
	fixtureExtension, lastAgentResult, resultText, type AnyRecord, type FixtureState,
} from "./host.test-support.ts";
import {
	AGENT_TOKENS, CHAT_SELECTION_IDS, CHAT_TOKENS, DEEPSEEK_ID, GLM_ID, HUNYUAN_ID, HUNYUAN_WINDOW_MS,
	LANE_HTTP, MAIN_MODEL_ID, TOTAL_BUDGET_MS, anthropicMessage, assertChatModels, assertGlmLane, assertHunyuanLane,
	assertNoSelectionErrors, assertNoUpstreamLeak, assertResponsesLane, chatCompletionMessage, chatMessage,
	chatSystemPrompt, createLaneHarness, laneCost, laneModel, selectionErrors, sourceEntry,
	type ChatQuestions, type RacePlan,
} from "./parallel-host.test-support.ts";

const BASE_CATALOG = [MAIN_MODEL_ID, HUNYUAN_ID, "jev-latest", "jev-preview", DEEPSEEK_ID, GLM_ID,
	"glm-5.3", "gpt-6-astra", "gpt-6.2-astra", "gpt-6.2-sol"];
const FIXTURE_TOOLS = ["Agent", "probe_nested", "get_subagent_result", "steer_subagent"];
const HISTORY_MARKER = "主会话历史标记-DO-NOT-FORWARD";
const HOST_PROMPT_MARKER = "Host-only private context；不得进入选型请求";

// 独立进程；HostSandbox 先隔离 env/网络，之后才动态 import SDK 与 pi-ai。
test("Pi SDK delegation：混元优先，后备两条并发竞速，首个有效结果胜出", { timeout: 90_000 }, async t => {
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
		assert.ok(["1.2.0", "1.4.0", "1.5.2"].includes(VERSION), `未验证的宿主 SDK 版本：${VERSION}`);
		writeFileSync(join(sandbox.agentDir, "settings.json"),
			JSON.stringify({ tsgw: { baseUrl: TEST_ROOT } }));
		const guardedFetch = globalThis.fetch;
		const plan: RacePlan = {};
		let callSequence = 0;
		const queueTool = (name: string, args: AnyRecord) => {
			const id = ++callSequence;
			plan.next = { name, args, callId: `call_fixture_${id}`, itemId: `fc_fixture_${id}` };
		};
		const refresh = async () => {
			const result = await runtime!.refresh({ providers: ["tsgw"], allowNetwork: true, force: true });
			assert.deepEqual([...result.errors], []);
			assert.equal(result.aborted, false);
		};
		const harness = createLaneHarness({ guardedFetch, plan });
		globalThis.fetch = harness.fetch;
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
		await refresh();
		const mainModel = runtime.getModel("tsgw", MAIN_MODEL_ID);
		assert.ok(mainModel);
		let selectedModel = "";
		harness.expectSelection("option_0");
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		session.setActiveToolsByName([...FIXTURE_TOOLS]);
		await session.setModel(mainModel);
		for (const name of FIXTURE_TOOLS) assert.ok(session.getActiveToolNames().includes(name), `${name} 应处于激活状态`);

		await t.test("混元首战成功：两条后备根本不发，补参/费用/摘要契约保持", async () => {
			harness.arrange({ hunyuan: "select" });
			const hyBefore = harness.hunyuanRequests.length;
			const deepseekBefore = harness.fallbackRequests[DEEPSEEK_ID].length;
			const glmBefore = harness.fallbackRequests[GLM_ID].length;
			const mainBefore = harness.mainRequests.length, callsBefore = fixture.agentCalls.length;
			const originalArgs = {
				subagent_type: "general-purpose", prompt: "实现 fixture 混元选型功能", description: "fixture 混元选型",
				run_in_background: true,
			};
			queueTool("Agent", originalArgs);
			await session!.prompt(HISTORY_MARKER);
			assert.equal(harness.hunyuanRequests.length, hyBefore + 1, "混元只请求一次");
			assert.equal(harness.fallbackRequests[DEEPSEEK_ID].length, deepseekBefore, "混元胜出时 DeepSeek 不得发起");
			assert.equal(harness.fallbackRequests[GLM_ID].length, glmBefore, "混元胜出时 GLM 不得发起");
			assert.equal(harness.systemoneRequests.length, 0, "委派选型不再调用原生分类");
			assert.equal(harness.mainRequests.length, mainBefore + 2, "主模型仍是 Sol：工具调用与其后续回复各一次");
			assert.equal(harness.mainRequests[mainBefore]!.model, MAIN_MODEL_ID);
			assert.ok(JSON.stringify(harness.mainRequests[mainBefore]).includes(HISTORY_MARKER), "主会话历史只进入主模型请求");
			assert.equal(session!.model?.id, MAIN_MODEL_ID, "选型不得切换主会话模型");

			const hunyuan = harness.hunyuanRequests.at(-1)!;
			const material = chatCompletionMessage(hunyuan.body);
			const context = JSON.parse(material.user) as AnyRecord;
			const questions = context.questions as ChatQuestions;
			assertHunyuanLane(hunyuan.body, questions);
			assert.deepEqual(context.state, { task: originalArgs }, "只呈现调用方任务，不携带历史或本地工具");
			assert.ok(material.system.trim().length > 0, "选型请求应携带独立的系统提示");
			for (const marker of [HISTORY_MARKER, HOST_PROMPT_MARKER, "probe_nested", "get_subagent_result", "steer_subagent"])
				assert.equal(JSON.stringify(hunyuan.body).includes(marker), false, "混元请求不得携带会话历史、主系统提示或本地工具");

			assert.equal(fixture.agentCalls.length, callsBefore + 1, "胜出后原 Agent 正常执行");
			const call = fixture.agentCalls.at(-1)!;
			assert.equal(typeof call.params.model, "string");
			selectedModel = call.params.model as string;
			assert.match(selectedModel, /^tsgw\/[^:]+:[^:]+$/);
			assert.deepEqual(call.params, { ...originalArgs, model: selectedModel }, "只补 model，原 Agent 参数不得改变");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, false);
			assert.equal(result.toolCallId, call.toolCallId);
			const text = resultText(result);
			assert.match(text, /fixture agent executed/);
			assert.match(text, /选型来源：聊天模型/);
			assert.ok(text.includes(laneModel(HUNYUAN_ID)), "工具文本须说明胜出通道");
			assert.ok(text.includes(selectedModel), "工具文本须给出实际补入的模型");
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.model, selectedModel);
			assert.equal(decision.kind, "implement");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(HUNYUAN_ID) });
			assertChatModels(decision, [HUNYUAN_ID]);
			assertNoSelectionErrors(decision);
			assert.equal(decision.selectionGuide, undefined, "成功选型不附接管表");
			assert.equal(decision.fallback, undefined, "旧字段已由 chatModel/chatModels 取代");
			assert.deepEqual((result.details as AnyRecord).host, { profile: "general-purpose", marker: "keep-me" },
				"宿主原有 details 必须保留");
			// 用量：原 Agent + 唯一返回结果的混元通道；未发起的后备没有可计费用量。
			const usage = result.usage!, cost = laneCost(runtime!, HUNYUAN_ID);
			assert.equal(usage.input, AGENT_TOKENS.input + CHAT_TOKENS.input);
			assert.equal(usage.output, AGENT_TOKENS.output + CHAT_TOKENS.output);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
			assert.ok(Math.abs(usage.cost.input - (0.001 + cost.input)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + cost.output)) < 1e-12);
			assert.ok(Math.abs(usage.cost.total - (0.003 + cost.input + cost.output)) < 1e-12);
			const persisted = session!.sessionManager.getBranch().filter(entry =>
				entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolCallId === result.toolCallId);
			assert.equal(persisted.length, 1, "同一 toolResult 只能持久化一次");
			const stored = persisted[0];
			assert.ok(stored.type === "message" && stored.message.role === "toolResult");
			assert.equal(stored.message.usage?.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total,
				"选型用量只入账一次，不在 message_end 重复累加");
			assertNoUpstreamLeak(JSON.stringify(persisted));
			assertNoUpstreamLeak(JSON.stringify(result));
		});

		await t.test("混元提前失败：两条后备并发，DeepSeek 胜出并取消在飞的 GLM", async () => {
			harness.arrange({ hunyuan: "error", deepseek: "after-errors", glm: "hang", holdReturned: 1 });
			const callsBefore = fixture.agentCalls.length;
			const countsBefore = harness.laneCounts();
			queueTool("Agent", { prompt: "实现 fixture 后备竞速", description: "fixture 后备" });
			await session!.prompt("混元先返回错误，后备并发");
			assert.deepEqual(harness.laneCounts(), countsBefore.map(count => count + 1),
				"混元与两条后备各请求一次");
			assert.equal(harness.drainedErrors(), 1, "混元的错误必须在后备胜出前被宿主读完");
			assert.equal(harness.fallbackAborted[GLM_ID], true, "DeepSeek 胜出后必须取消在飞的 GLM 请求");
			assert.equal(harness.fallbackAborted[DEEPSEEK_ID], false, "胜出通道自身不得被取消");
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "先返回的错误不得阻止后备有效结果创建子代理");
			const result = lastAgentResult(session!)!;
			assert.equal(result.isError, false);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.model, selectedModel);
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(DEEPSEEK_ID) });
			assertChatModels(decision, CHAT_SELECTION_IDS);
			const errors = selectionErrors(decision);
			assert.equal(errors.length, 1, "被取消的 GLM 不计入逐路错误，混元缺席以外的通道不臆造");
			assert.deepEqual([errors[0]!.source, errors[0]!.failureKind, errors[0]!.statusCode],
				[{ type: "chat", model: laneModel(HUNYUAN_ID) }, "http", LANE_HTTP],
				"只记录已发起且先返回错误的混元，并保留 HTTP 码");
			assert.ok(errors[0]!.reason.length > 0 && !errors[0]!.reason.includes("synthetic"), "原因只保留安全摘要");
			const text = resultText(result);
			assert.ok(text.includes(laneModel(HUNYUAN_ID)), "工具文本须列出先报错的混元");
			assert.ok(text.includes(String(LANE_HTTP)), "工具文本须给出简短 HTTP 码");
			assert.ok(text.includes(laneModel(DEEPSEEK_ID)), "工具文本须说明胜出的后备通道");
			assertNoUpstreamLeak(JSON.stringify(result));

			// 三路共用同一份材料；协议字段按各自厂商契约发出。
			const hy = harness.hunyuanRequests.at(-1)!, deepseek = harness.fallbackRequests[DEEPSEEK_ID].at(-1)!;
			const glm = harness.fallbackRequests[GLM_ID].at(-1)!;
			const context = JSON.parse(chatCompletionMessage(hy.body).user) as AnyRecord;
			const questions = context.questions as ChatQuestions;
			assertResponsesLane(deepseek.body, questions);
			assertGlmLane(glm.body, questions);
			assert.deepEqual(JSON.parse(chatMessage(deepseek.body, "system")), JSON.parse(chatCompletionMessage(hy.body).user),
				"DeepSeek 必须复用同一份选型材料");
			const glmMaterials = anthropicMessage(glm.body);
			assert.deepEqual(JSON.parse(glmMaterials.message), JSON.parse(chatCompletionMessage(hy.body).user),
				"GLM 必须复用同一份选型材料");
			assert.equal(glmMaterials.system, chatSystemPrompt(deepseek.body), "两条后备复用同一套分类器提示");
			assert.equal(glmMaterials.system, chatCompletionMessage(hy.body).system, "混元与后备共用同一套分类器提示");
			for (const payload of [hy.body, deepseek.body, glm.body]) {
				const serialized = JSON.stringify(payload);
				for (const marker of [HISTORY_MARKER, HOST_PROMPT_MARKER, "probe_nested", "get_subagent_result", "steer_subagent"])
					assert.equal(serialized.includes(marker), false, "选型通道不得携带会话历史、主系统提示或本地工具");
			}
			// 只有胜出通道与夹具 Agent 计入用量；先报错的混元没有可计费用量。
			const usage = result.usage!, cost = laneCost(runtime!, DEEPSEEK_ID);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
			assert.ok(Math.abs(usage.cost.input - (0.001 + cost.input)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + cost.output)) < 1e-12);
		});

		await t.test("混元返回候选表外的 key：转入后备，GLM 胜出并取消在飞的 DeepSeek", async () => {
			harness.arrange({ hunyuan: "invalid", deepseek: "hang", glm: "after-errors", holdReturned: 1 });
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "混元非法结果后的后备选型", description: "invalid hunyuan" });
			await session!.prompt("混元返回候选表外的 key");
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "非法混元结果不得阻止后备创建子代理");
			assert.equal(harness.fallbackAborted[DEEPSEEK_ID], true, "GLM 胜出后必须取消在飞的 DeepSeek 请求");
			const result = lastAgentResult(session!)!;
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(GLM_ID) });
			assertChatModels(decision, CHAT_SELECTION_IDS);
			const errors = selectionErrors(decision);
			assert.equal(errors.length, 1, "只有实际返回非法结果的混元进入逐路摘要");
			assert.deepEqual([errors[0]!.source, errors[0]!.failureKind, errors[0]!.statusCode],
				[{ type: "chat", model: laneModel(HUNYUAN_ID) }, "invalid_result", undefined],
				"非法结果没有 HTTP 码，也不臆造缺失通道");
			assert.ok(resultText(result).includes(laneModel(GLM_ID)), "工具文本须说明胜出的 GLM");
			assertNoUpstreamLeak(JSON.stringify(result));
			// GLM 只靠提示约束 JSON：非法混元后 GLM 的合法 JSON 仍按本地校验通过。
			const glm = harness.fallbackRequests[GLM_ID].at(-1)!;
			const context = JSON.parse(anthropicMessage(glm.body).message) as AnyRecord;
			assertGlmLane(glm.body, context.questions as ChatQuestions);
			const usage = result.usage!, cost = laneCost(runtime!, GLM_ID);
			// 混元虽返回非法 key，但 HTTP 已返回并报告用量；同一规则下两路已报告用量都应累计一次。
			const invalidCost = laneCost(runtime!, HUNYUAN_ID);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total * 2);
			assert.ok(Math.abs(usage.cost.input - (0.001 + invalidCost.input + cost.input)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + invalidCost.output + cost.output)) < 1e-12);
		});

		await t.test("GLM 返回非法 JSON：本地校验拒绝，DeepSeek 胜出", async () => {
			// GLM 没有 schema 强制能力，只能靠提示约束；非法输出必须由本地校验淘汰。
			harness.arrange({ hunyuan: "error", deepseek: "after-errors", glm: "invalid", holdReturned: 2 });
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "GLM 非法输出后的后备选型", description: "invalid glm" });
			await session!.prompt("GLM 返回非法 JSON");
			assert.equal(harness.drainedErrors(), 2, "混元错误与 GLM 非法结果都须在 DeepSeek 胜出前被读完");
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "非法 GLM 结果不得阻止 DeepSeek 创建子代理");
			assert.equal(harness.fallbackAborted[GLM_ID], false, "已返回非法结果的 GLM 不需要再取消");
			const result = lastAgentResult(session!)!;
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(DEEPSEEK_ID) });
			assertChatModels(decision, CHAT_SELECTION_IDS);
			const errors = selectionErrors(decision);
			assert.deepEqual(errors.map(entry => [entry.source.model, entry.failureKind, entry.statusCode]).sort(), [
				[laneModel(HUNYUAN_ID), "http", LANE_HTTP],
				[laneModel(GLM_ID), "invalid_result", undefined],
			].sort(), "GLM 非法结果本地淘汰，只带失败类型不带 HTTP 码");
			const text = resultText(result);
			assert.ok(text.includes(laneModel(GLM_ID)), "工具文本须列出本地淘汰的 GLM");
			assert.ok(text.includes(laneModel(DEEPSEEK_ID)), "工具文本须说明胜出的 DeepSeek");
			assertNoUpstreamLeak(JSON.stringify(result));
			// 已报告用量的通道各自累计一次：夹具 Agent + 非法 GLM + 胜出 DeepSeek。
			const usage = result.usage!, deepseekCost = laneCost(runtime!, DEEPSEEK_ID), glmCost = laneCost(runtime!, GLM_ID);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total * 2);
			assert.ok(Math.abs(usage.cost.input - (0.001 + glmCost.input + deepseekCost.input)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + glmCost.output + deepseekCost.output)) < 1e-12);
		});

		await t.test("混元 7 秒窗口超时后转入后备；总预算仍为 15 秒", async () => {
			harness.arrange({ hunyuan: "hang", deepseek: "select", glm: "hang" });
			const callsBefore = fixture.agentCalls.length;
			const startedAt = Date.now();
			queueTool("Agent", { prompt: "混元超时后的后备选型", description: "timeout fallback" });
			await session!.prompt("混元挂起直到窗口结束");
			const elapsed = Date.now() - startedAt;
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "窗口结束后后备仍须在总预算内完成选型");
			const hy = harness.hunyuanRequests.at(-1)!;
			const firstFallback = Math.min(harness.fallbackRequests[DEEPSEEK_ID].at(-1)!.at,
				harness.fallbackRequests[GLM_ID].at(-1)!.at);
			const window = firstFallback - hy.at;
			assert.ok(window >= HUNYUAN_WINDOW_MS - 600,
				`混元窗口应接近 ${HUNYUAN_WINDOW_MS}ms，实际 ${window}ms（过短说明误用了其它上限）`);
			assert.ok(window <= HUNYUAN_WINDOW_MS + 5_000,
				`混元窗口不得延长到总预算，实际 ${window}ms`);
			assert.ok(elapsed < TOTAL_BUDGET_MS, `总选型预算不得超过 ${TOTAL_BUDGET_MS}ms，实际 ${elapsed}ms`);
			assert.equal(harness.hunyuanAborted, true, "窗口结束时必须取消仍挂起的混元请求");
			assert.equal(harness.fallbackAborted[GLM_ID], true, "DeepSeek 胜出后必须取消在飞的 GLM 请求");
			const result = lastAgentResult(session!)!;
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(DEEPSEEK_ID) });
			assertChatModels(decision, CHAT_SELECTION_IDS);
			const errors = selectionErrors(decision);
			assert.equal(errors.length, 1, "只有超时的混元进入逐路摘要，被取消的 GLM 不算失败");
			assert.equal(errors[0]!.source.model, laneModel(HUNYUAN_ID));
			assert.equal(errors[0]!.statusCode, undefined, "超时没有 HTTP 码");
			assert.ok(errors[0]!.reason.length > 0);
			assertNoUpstreamLeak(JSON.stringify(result));
			const usage = result.usage!, cost = laneCost(runtime!, DEEPSEEK_ID);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
			assert.ok(Math.abs(usage.cost.total - (0.003 + cost.input + cost.output)) < 1e-12);
		});

		await t.test("目录缺少混元：直接并发两条后备，不为缺席通道记账", async () => {
			sandbox.catalogIds = BASE_CATALOG.filter(id => id !== HUNYUAN_ID);
			await refresh();
			try {
				harness.arrange({ hunyuan: "error", deepseek: "select", glm: "hang" });
				const countsBefore = harness.laneCounts();
				const callsBefore = fixture.agentCalls.length;
				queueTool("Agent", { prompt: "混元缺席时的后备选型", description: "missing primary" });
				await session!.prompt("目录中没有混元");
				assert.deepEqual(harness.laneCounts(), [countsBefore[0]!, countsBefore[1]! + 1, countsBefore[2]! + 1],
					"混元缺席时既不请求也不记账，两条后备各一次");
				assert.equal(fixture.agentCalls.length, callsBefore + 1, "后备有效结果正常创建子代理");
				assert.equal(harness.fallbackAborted[GLM_ID], true, "DeepSeek 胜出后必须取消在飞的 GLM 请求");
				const result = lastAgentResult(session!)!;
				const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.status, "selected");
				assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(DEEPSEEK_ID) });
				assertChatModels(decision, [DEEPSEEK_ID, GLM_ID]);
				assertNoSelectionErrors(decision);
				assert.equal(harness.systemoneRequests.length, 0);
			} finally {
				sandbox.catalogIds = [...BASE_CATALOG];
				await refresh();
			}
		});

		await t.test("三路都失败才阻止：逐路安全摘要、Agent.model 指导、不自动重跑", async () => {
			harness.arrange({ hunyuan: "error", deepseek: "error", glm: "error" });
			const countsBefore = harness.laneCounts();
			const callsBefore = fixture.agentCalls.length, mainBefore = harness.mainRequests.length;
			queueTool("Agent", { subagent_type: "general-purpose", prompt: "三路失败任务", description: "all lanes failure" });
			await session!.prompt("混元与两条后备都失败");
			assert.deepEqual(harness.laneCounts(), countsBefore.map(count => count + 1),
				"三路各请求一次，maxRetries=0 下不得重试");
			assert.equal(fixture.agentCalls.length, callsBefore, "三路都失败不得创建子代理");
			assert.equal(harness.mainRequests.length, mainBefore + 2, "主模型只有自身调用与失败后的回复，无额外选型请求");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, true);
			const text = resultText(result);
			assert.match(text, /本次未创建子代理/);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.selectionSource, undefined);
			assert.ok(text.includes("选型来源：无"), "三路都没有有效选型时不声称胜出通道");
			assert.equal(decision.failureKind, "selection_failed");
			assertChatModels(decision, CHAT_SELECTION_IDS);
			const errors = selectionErrors(decision);
			assert.deepEqual(errors.map(entry => [entry.source.model, entry.failureKind, entry.statusCode]).sort(), [
				[laneModel(HUNYUAN_ID), "http", LANE_HTTP],
				[laneModel(DEEPSEEK_ID), "http", LANE_HTTP],
				[laneModel(GLM_ID), "http", LANE_HTTP],
			].sort(), "失败摘要必须覆盖三路与各自的 HTTP 码");
			for (const entry of errors) {
				assert.ok(text.includes(entry.source.model), "工具文本须逐路列出失败通道");
				assert.ok(entry.reason.length > 0 && !entry.reason.includes("synthetic"), "原因只保留安全摘要，不含上游正文");
				assert.ok(text.includes(String(entry.statusCode)), "工具文本须给出简短 HTTP 错误码");
			}
			const guide = decision.selectionGuide;
			assert.ok(typeof guide === "string" && guide.length > 0, "必须保留原选型指导");
			assert.ok(guide.includes(`| ${selectedModel} |`), "指导必须复用本次有效候选");
			assert.ok(text.includes("Agent.model"), "失败接管要求主代理显式传 Agent.model 重新派遣");
			assert.equal(text.split(guide).length - 1, 1, "宿主阻止结果仅保留一份选型表");
			assert.equal(result.usage?.totalTokens ?? 0, 0, "三次失败都没有可计费用量");
			// 失败后不自动重跑：再等一拍，请求计数保持不变。
			await new Promise(resolve => setImmediate(resolve));
			assert.deepEqual(harness.laneCounts(), countsBefore.map(count => count + 1));
			assertNoUpstreamLeak(JSON.stringify(result));
		});

		await t.test("会话限定候选：混元仍作为执行器，指导表只列 scope 内候选", async () => {
			const target = runtime!.getModel("tsgw", "gpt-6.2-astra");
			assert.ok(target);
			const scopedModel = `tsgw/${target.id}:max`;
			session!.setScopedModels([{ model: target, thinkingLevel: "max" as ModelThinkingLevel }]);
			try {
				harness.arrange({ hunyuan: "select" });
				const countsBefore = harness.laneCounts();
				queueTool("Agent", { prompt: "限定候选的混元选型", description: "scoped primary" });
				await session!.prompt("仅允许本次指定型号和档位");
				assert.equal(fixture.agentCalls.at(-1)!.params.model, scopedModel, "只补入 scope 内的候选");
				assert.deepEqual(harness.laneCounts(),
					[countsBefore[0]! + 1, countsBefore[1]!, countsBefore[2]!],
					"固定选型执行器不受输出候选 scope 限制");
				const hy = harness.hunyuanRequests.at(-1)!;
				const context = JSON.parse(chatCompletionMessage(hy.body).user) as AnyRecord;
				const selection = (context.questions as AnyRecord).selection as AnyRecord;
				assert.deepEqual(Object.keys(selection.criteria as AnyRecord), ["option_0", "unresolved"],
					"选型材料只呈现本次 scope 中的候选");
				const format = (hy.body.response_format as AnyRecord).json_schema as AnyRecord;
				const selectionSchema = ((format.schema as AnyRecord).properties as AnyRecord).selection as AnyRecord;
				assert.deepEqual(selectionSchema.enum, ["option_0", "unresolved"]);

				harness.arrange({ hunyuan: "error", deepseek: "error", glm: "error" });
				queueTool("Agent", { prompt: "限定候选的失败接管", description: "scoped guide" });
				await session!.prompt("三路都失败后仍只展示有效候选");
				const decision = (lastAgentResult(session!)!.details as AnyRecord).tsgwDelegation as AnyRecord;
				const rows = (decision.selectionGuide as string).split("\n").filter(line => line.startsWith("| tsgw/"));
				assert.equal(rows.length, 1, "指导只保留本次 scope 中的一项");
				assert.ok(rows[0]!.includes(scopedModel));
				assert.deepEqual(selectionErrors(decision).map(entry => entry.source.model).sort(),
					[laneModel(HUNYUAN_ID), laneModel(DEEPSEEK_ID), laneModel(GLM_ID)].sort(),
					"受限会话同样逐路记录三路失败");
			} finally {
				session!.setScopedModels([]);
			}
		});

		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
