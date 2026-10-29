import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, ExtensionError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildDelegationCandidates } from "#tsgw/delegation/policy";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import {
	fixtureExtension, lastAgentResult, resultText, type AnyRecord, type FixtureState,
} from "./host-test-fixtures.test.ts";
import {
	AGENT_TOKENS, CHAT_LANE_IDS, CHAT_TOKENS, CLASSIFIER_IDS, CLASSIFIER_TOKENS, DEEPSEEK_ID, LANES_HTTP, LUNA_ID,
	MAIN_MODEL_ID, MINIMAX_ID, anthropicMessage, assertChatModels, assertMiniMaxLane, assertNoSelectionErrors,
	assertNoUpstreamLeak, assertResponsesLane, chatMessage, chatSystemPrompt, createLaneHarness, laneCost, laneModel,
	selectionErrors, sourceEntry, type ChatLane, type ChatQuestions, type LaneMode, type RacePlan,
} from "./parallel-host-protocols.test.ts";

const BASE_CATALOG = [MAIN_MODEL_ID, LUNA_ID, "jev-latest", "jev-preview", DEEPSEEK_ID, "glm-5.3", MINIMAX_ID];
const FIXTURE_TOOLS = ["Agent", "probe_nested", "get_subagent_result", "steer_subagent"];
const HISTORY_MARKER = "主会话历史标记-DO-NOT-FORWARD";
const HOST_PROMPT_MARKER = "Host-only private context；不得进入并行选型请求";

// 独立进程；HostSandbox 先隔离 env/网络，之后才动态 import SDK 与 pi-ai。
test("Pi 1.2 delegation：原生分类与三款聊天模型四路并行竞速，首个有效结果胜出", { timeout: 90_000 }, async t => {
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
		const harness = createLaneHarness({ sandbox, catalog: BASE_CATALOG, guardedFetch, plan,
			refreshCatalog: () => refresh() });
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
		const candidates = buildDelegationCandidates(
			await runtime.getAvailableOfType("chat", "tsgw"), getSupportedThinkingLevels);
		const deepseekHigh = candidates.find(candidate => candidate.id === DEEPSEEK_ID && candidate.level === "high");
		assert.ok(deepseekHigh, "固定选型表应提供常规工程候选");
		harness.expectSelection(deepseekHigh.key);
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		session.setActiveToolsByName([...FIXTURE_TOOLS]);
		await session.setModel(mainModel);
		for (const name of FIXTURE_TOOLS) assert.ok(session.getActiveToolNames().includes(name), `${name} 应处于激活状态`);
		const classifierModel = () => `tsgw/${String(harness.classifierRequests.at(-1)!.model)}`;

		await t.test("四路同时到达后 Luna 先胜出：三款聊天协议参数按契约发出，在飞三路全部取消", async () => {
			harness.arrange({ classifier: "hang",
				lanes: { [LUNA_ID]: "select", [DEEPSEEK_ID]: "hang", [MINIMAX_ID]: "hang" } });
			const classifiersBefore = harness.classifierRequests.length, laneBefore = harness.laneCounts();
			const mainBefore = harness.mainRequests.length, callsBefore = fixture.agentCalls.length;
			const originalArgs = {
				subagent_type: "general-purpose", prompt: "实现 fixture 并行选型功能", description: "fixture 并行选型",
				run_in_background: true,
			};
			queueTool("Agent", originalArgs);
			await session!.prompt(HISTORY_MARKER);
			assert.equal(harness.classifierRequests.length, classifiersBefore + 1, "原生分类只请求一次");
			harness.laneCounts().forEach((count, index) =>
				assert.equal(count, laneBefore[index]! + 1, `${CHAT_LANE_IDS[index]} 聊天通道只请求一次`));
			// 屏障只在四路请求都到达后才释放；分类与两路聊天此刻仍未返回即说明没有等待任何一路失败。
			assert.equal(harness.classifierAborted, true, "Luna 胜出后必须主动取消仍在飞的分类请求");
			assert.equal(harness.laneAborted[DEEPSEEK_ID], true, "Luna 胜出后必须取消在飞的 DeepSeek 请求");
			assert.equal(harness.laneAborted[MINIMAX_ID], true, "Luna 胜出后必须取消在飞的 MiniMax 请求");
			assert.equal(harness.mainRequests.length, mainBefore + 2, "主模型仍是 Sol：工具调用与其后续回复各一次");
			assert.equal(harness.mainRequests[mainBefore]!.model, MAIN_MODEL_ID);
			assert.ok(JSON.stringify(harness.mainRequests[mainBefore]).includes(HISTORY_MARKER), "主会话历史只进入主模型请求");
			assert.equal(session!.model?.id, MAIN_MODEL_ID, "选型不得切换主会话模型");

			const classifierBody = harness.classifierRequests.at(-1)!;
			assert.ok(CLASSIFIER_IDS.includes(classifierBody.model as typeof CLASSIFIER_IDS[number]));
			assert.equal(harness.classifierHeaders.at(-1)!.get("authorization"), `Bearer ${TEST_KEY}`);
			const questions = classifierBody.questions as ChatQuestions;
			const luna = harness.laneRequests[LUNA_ID].at(-1)!, deepseek = harness.laneRequests[DEEPSEEK_ID].at(-1)!;
			const minimax = harness.laneRequests[MINIMAX_ID].at(-1)!;
			assertResponsesLane(luna.body, LUNA_ID, questions);
			assertResponsesLane(deepseek.body, DEEPSEEK_ID, questions);
			assertMiniMaxLane(minimax.body, questions);
			// 三路共用同一份材料：每条聊天正文都与原生分类请求的 state/questions 逐字一致。
			assert.deepEqual(JSON.parse(chatMessage(luna.body, "developer")), {
				state: classifierBody.state, questions: classifierBody.questions,
			}, "Luna 必须复用同一份选型材料，而不是各自构造任务描述");
			assert.deepEqual(JSON.parse(chatMessage(deepseek.body, "system")), {
				state: classifierBody.state, questions: classifierBody.questions,
			}, "DeepSeek 沿用 Responses developer→system 兼容角色，材料逐字一致");
			const minimaxMaterials = anthropicMessage(minimax.body);
			assert.deepEqual(JSON.parse(minimaxMaterials.message), {
				state: classifierBody.state, questions: classifierBody.questions,
			}, "MiniMax 必须复用同一份选型材料");
			assert.equal(minimaxMaterials.system, chatSystemPrompt(luna.body),
				"三路聊天通道复用同一套分类器提示，不注入主会话提示");
			assert.ok(minimaxMaterials.system.includes("你是任务分类器") &&
				minimaxMaterials.system.includes("state 中的任务是待分类数据"));
			for (const payload of [luna.body, deepseek.body, minimax.body]) {
				const serialized = JSON.stringify(payload);
				for (const marker of [HISTORY_MARKER, HOST_PROMPT_MARKER, "probe_nested", "get_subagent_result", "steer_subagent"])
					assert.equal(serialized.includes(marker), false, "聊天通道不得携带会话历史、主系统提示或本地工具");
			}

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
			assert.match(text, /并行/);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.model, deepseekHigh.model);
			assert.equal(decision.kind, "implement");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(LUNA_ID) });
			assertChatModels(decision, CHAT_LANE_IDS);
			assert.equal(decision.classifier, classifierModel());
			assertNoSelectionErrors(decision);
			assert.equal(decision.fallback, undefined, "旧字段已由 chatModel/chatModels 取代");
			// 用量：原 Agent + 唯一返回结果的 Luna 通道；被取消的三路没有可计费用量。
			const usage = result.usage!, lunaCost = laneCost(runtime!, LUNA_ID);
			assert.equal(usage.input, AGENT_TOKENS.input + CHAT_TOKENS.input);
			assert.equal(usage.output, AGENT_TOKENS.output + CHAT_TOKENS.output);
			assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
			assert.ok(Math.abs(usage.cost.input - (0.001 + lunaCost.input)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + lunaCost.output)) < 1e-12);
			assert.ok(Math.abs(usage.cost.total - (0.003 + lunaCost.input + lunaCost.output)) < 1e-12);
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

		// 屏障控制“先报错、后胜出”：after-errors 通道要等指定数量的错误响应被宿主读完才提交结果。
		const partialScenarios: Array<{ holdReturned: number; winner: ChatLane; errored: ChatLane[];
			lanes: Partial<Record<ChatLane, LaneMode>> }> = [
			{ holdReturned: 1, winner: LUNA_ID, errored: [],
				lanes: { [LUNA_ID]: "after-errors", [DEEPSEEK_ID]: "hang", [MINIMAX_ID]: "hang" } },
			{ holdReturned: 3, winner: MINIMAX_ID, errored: [LUNA_ID, DEEPSEEK_ID],
				lanes: { [LUNA_ID]: "error", [DEEPSEEK_ID]: "error", [MINIMAX_ID]: "after-errors" } },
		];
		for (const scenario of partialScenarios) {
			const { holdReturned, winner, errored } = scenario;
			await t.test(`${holdReturned} 路错误先返回后 ${winner} 才胜出：metadata 与工具文本保留逐路安全摘要`, async () => {
				harness.arrange({ classifier: "error", holdReturned, lanes: scenario.lanes });
				const callsBefore = fixture.agentCalls.length;
				queueTool("Agent", { prompt: "只核对选型并发逻辑，不改实现", description: "partial lane errors" });
				await session!.prompt("先返回错误，随后另一路给出有效结果");
				assert.equal(fixture.agentCalls.length, callsBefore + 1, "先返回的错误不得阻止随后有效结果创建子代理");
				assert.equal(harness.drainedErrors(), holdReturned, "指定数量的错误必须在胜出前被宿主读完");
				const result = lastAgentResult(session!)!;
				assert.equal(result.isError, false);
				const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.status, "selected");
				assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(winner) });
				assertChatModels(decision, CHAT_LANE_IDS);
				const errors = selectionErrors(decision);
				// 顺序不锁；胜出前已返回的各路必须齐全，其后到达与取消的通道不在其中。
				assert.deepEqual(errors.map(entry => [entry.source.type, entry.source.model, entry.statusCode]).sort(), [
					["classifier", classifierModel(), LANES_HTTP.classifier],
					...errored.map(lane => ["chat", laneModel(lane), LANES_HTTP.lane]),
				].sort(), "只记录已发起且先返回的错误通道，含各自的 HTTP 码");
				for (const entry of errors) {
					assert.ok(typeof entry.failureKind === "string" && entry.failureKind.length > 0, "逐路错误须带失败类型");
					assert.ok(typeof entry.reason === "string" && entry.reason.length > 0, "逐路错误须带简短安全原因");
				}
				const text = resultText(result);
				assert.match(text, /并行/);
				for (const entry of errors) {
					assert.ok(text.includes(entry.source.model), "工具文本须列出先报错的通道");
					if (entry.statusCode !== undefined)
						assert.ok(text.includes(String(entry.statusCode)), `工具文本须给出 ${entry.source.model} 的简短 HTTP 码`);
				}
				assert.ok(text.includes(laneModel(winner)), "工具文本须说明胜出的通道");
				assertNoUpstreamLeak(JSON.stringify(result));
				// 只有胜出通道与夹具 Agent 计入用量；先报错的各路没有可计费用量。
				const usage = result.usage!, cost = laneCost(runtime!, winner);
				assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
				assert.ok(Math.abs(usage.cost.input - (0.001 + cost.input)) < 1e-12);
				assert.ok(Math.abs(usage.cost.output - (0.002 + cost.output)) < 1e-12);
			});
		}

		// 每款聊天通道都必须能单独立胜出；MiniMax 额外验证 anthropic-messages 的已报告用量同样入账。
		for (const lane of [DEEPSEEK_ID, MINIMAX_ID] as const) {
			await t.test(`${lane} 聊天通道可独立胜出：其余三路在飞请求全部取消`, async () => {
				const lanes: Partial<Record<ChatLane, LaneMode>> = {};
				for (const other of CHAT_LANE_IDS) lanes[other] = other === lane ? "select" : "hang";
				harness.arrange({ classifier: "hang", lanes });
				const prompt = `核对 ${lane} 通道独立胜出`, description = `${lane} race`;
				const callsBefore = fixture.agentCalls.length;
				queueTool("Agent", { subagent_type: "general-purpose", prompt, description });
				await session!.prompt(`${lane} 通道先通过校验`);
				assert.equal(harness.classifierAborted, true, "胜出后必须取消在飞的分类请求");
				for (const other of CHAT_LANE_IDS) if (other !== lane)
					assert.equal(harness.laneAborted[other], true, `胜出后必须取消在飞的 ${other} 请求`);
				assert.equal(fixture.agentCalls.length, callsBefore + 1, "胜出后原 Agent 正常执行");
				assert.deepEqual(fixture.agentCalls.at(-1)!.params,
					{ subagent_type: "general-purpose", prompt, description, model: deepseekHigh.model },
					"只补 model，原 Agent 参数不得改变");
				const result = lastAgentResult(session!)!;
				assert.equal(result.isError, false);
				const text = resultText(result);
				assert.match(text, /并行/);
				assert.ok(text.includes(laneModel(lane)), `文案须说明 ${lane} 的胜出模型`);
				const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.status, "selected");
				assert.equal(decision.kind, "implement");
				assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(lane) });
				assertChatModels(decision, CHAT_LANE_IDS);
				assertNoSelectionErrors(decision);
				const usage = result.usage!, cost = laneCost(runtime!, lane);
				assert.equal(usage.input, AGENT_TOKENS.input + CHAT_TOKENS.input);
				assert.equal(usage.output, AGENT_TOKENS.output + CHAT_TOKENS.output);
				assert.equal(usage.totalTokens, AGENT_TOKENS.total + CHAT_TOKENS.total);
				assert.ok(Math.abs(usage.cost.input - (0.001 + cost.input)) < 1e-12);
				assert.ok(Math.abs(usage.cost.output - (0.002 + cost.output)) < 1e-12);
			});
		}

		// Responses 与 Anthropic Messages 都没有可依赖的本地 schema 强制时，答案同样要在本地严格校验。
		for (const lane of [LUNA_ID, MINIMAX_ID] as const) {
			await t.test(`${lane} 返回候选表外的 key：不成为胜者，仅记录为非法结果`, async () => {
				harness.arrange({ classifier: "after-errors", holdReturned: 1,
					lanes: { [lane]: "invalid", ...Object.fromEntries(CHAT_LANE_IDS.filter(id => id !== lane)
						.map(id => [id, "hang"])) } });
				const callsBefore = fixture.agentCalls.length;
				queueTool("Agent", { prompt: `${lane} 非法 key 下的原生胜出`, description: "invalid chat" });
				await session!.prompt("聊天通道返回候选表外的 key");
				assert.equal(fixture.agentCalls.length, callsBefore + 1, "非法聊天结果不得阻止原生分类胜出");
				const classifierBody = harness.classifierRequests.at(-1)!;
				const result = lastAgentResult(session!)!;
				assert.equal(result.isError, false);
				const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.status, "selected");
				assert.equal(decision.model, deepseekHigh.model);
				assert.deepEqual(decision.selectionSource,
					{ type: "classifier", model: `tsgw/${String(classifierBody.model)}` });
				assertChatModels(decision, CHAT_LANE_IDS);
				const errors = selectionErrors(decision);
				assert.equal(errors.length, 1, "只有实际返回非法结果的一路进入逐路摘要");
				assert.deepEqual([errors[0]!.source.type, errors[0]!.source.model, errors[0]!.statusCode],
					["chat", laneModel(lane), undefined], "非法结果没有 HTTP 码，也不臆造缺失通道");
				assertNoUpstreamLeak(JSON.stringify(result));
				// HTTP 已返回不等于 SDK 已消费；只有这一路的用量可能在取消前报告。
				const usage = result.usage!, nativeTokens = AGENT_TOKENS.total + CLASSIFIER_TOKENS.total;
				if (!usage) assert.fail("工具结果必须带用量");
				assert.ok([nativeTokens, nativeTokens + CHAT_TOKENS.total].includes(usage.totalTokens),
					"只累计已报告用量，不等待迟到的聊天响应");
			});
		}

		await t.test("四路全部失败才阻止创建：逐路摘要含四路与 HTTP 码，显式 Agent.model 重新派遣，不自动重跑", async () => {
			harness.arrange({ classifier: "error" });
			const classifiersBefore = harness.classifierRequests.length, laneBefore = harness.laneCounts();
			const callsBefore = fixture.agentCalls.length, mainBefore = harness.mainRequests.length;
			queueTool("Agent", { subagent_type: "general-purpose", prompt: "四路失败任务", description: "all lanes failure" });
			await session!.prompt("四路都失败的派遣");
			assert.equal(harness.classifierRequests.length, classifiersBefore + 1, "原生分类只请求一次");
			harness.laneCounts().forEach((count, index) => assert.equal(count, laneBefore[index]! + 1,
				`${CHAT_LANE_IDS[index]} 的 500 在 maxRetries=0 下不得重试`));
			assert.equal(fixture.agentCalls.length, callsBefore, "四路都失败不得创建子代理");
			assert.equal(harness.mainRequests.length, mainBefore + 2, "主模型只有自身调用与失败后的回复，无额外分类请求");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, true);
			const text = resultText(result);
			assert.ok(text.includes("分类请求失败（HTTP 402）。"), "保留原生分类的 HTTP 402 安全错误");
			assert.match(text, /本次未创建子代理/);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.selectionSource, undefined);
			assert.ok(text.includes("选型来源：无"), "四路都没有有效选型时不声称胜出通道");
			assert.equal(decision.failureKind, "http");
			assert.equal(decision.classifier, classifierModel());
			assertChatModels(decision, CHAT_LANE_IDS);
			const errors = selectionErrors(decision);
			assert.deepEqual(errors.map(entry => [entry.source.model, entry.statusCode]).sort(), [
				[classifierModel(), LANES_HTTP.classifier],
				[laneModel(DEEPSEEK_ID), LANES_HTTP.lane],
				[laneModel(LUNA_ID), LANES_HTTP.lane],
				[laneModel(MINIMAX_ID), LANES_HTTP.lane],
			].sort(), "失败摘要必须覆盖四路与各自的 HTTP 码");
			for (const entry of errors) {
				assert.ok(text.includes(entry.source.model), "工具文本须逐路列出失败通道");
				assert.ok(typeof entry.failureKind === "string" && entry.failureKind.length > 0);
				assert.ok(entry.reason.length > 0 && !entry.reason.includes("synthetic"), "原因只保留安全摘要，不含上游正文");
				assert.equal(typeof entry.statusCode, "number", `${entry.source.model} 的失败必须带 HTTP 码`);
				assert.ok(text.includes(String(entry.statusCode)), "工具文本须给出简短 HTTP 错误码");
			}
			const guide = decision.selectionGuide;
			assert.ok(typeof guide === "string" && guide.length > 0, "必须保留原选型指导");
			assert.ok(guide.includes(`| ${deepseekHigh.model} |`), "指导必须复用本次有效候选");
			assert.ok(text.includes("Agent.model"), "失败接管要求主代理显式传 Agent.model 重新派遣");
			assert.equal(text.split(guide).length - 1, 1, "宿主阻止结果仅保留一份选型表");
			assert.equal(result.usage?.totalTokens ?? 0, 0, "四次失败都没有可计费用量");
			// 失败后不自动重跑四路：再等一拍，请求计数保持不变。
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(harness.classifierRequests.length, classifiersBefore + 1);
			assert.deepEqual(harness.laneCounts(), laneBefore.map(count => count + 1));
			assertNoUpstreamLeak(JSON.stringify(result));
		});

		await t.test("胜出后仍复核目录：候选已不在目录时不修改原 Agent 也不创建子代理", async () => {
			harness.arrange({ classifier: "error",
				lanes: { [LUNA_ID]: "select", [DEEPSEEK_ID]: "error", [MINIMAX_ID]: "error" } });
			harness.dropAfterWin(DEEPSEEK_ID);
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "胜出后目录变化的任务", description: "catalog recheck" });
			await session!.prompt("胜出后目录复核");
			assert.equal(fixture.agentCalls.length, callsBefore, "复核失败不得创建子代理");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, true);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.failureKind, "model_unavailable");
			assert.match(resultText(result), /不在当前可用候选/);
			assertChatModels(decision, CHAT_LANE_IDS);
			sandbox.catalogIds = [...BASE_CATALOG];
			await refresh();
			assert.ok(runtime!.getModel("tsgw", DEEPSEEK_ID));
		});

		await t.test("会话限定型号与档位：四路与失败接管表共用有效候选", async () => {
			harness.arrange({ classifier: "error",
				lanes: { [LUNA_ID]: "select", [DEEPSEEK_ID]: "error", [MINIMAX_ID]: "error" } });
			const deepseek = runtime!.getModel("tsgw", DEEPSEEK_ID)!;
			const scope = [{ model: deepseek, thinkingLevel: "max" as const }];
			const scoped = buildDelegationCandidates(await runtime!.getAvailableOfType("chat", "tsgw"),
				getSupportedThinkingLevels, scope);
			assert.equal(scoped.length, 1);
			session!.setScopedModels(scope);
			harness.expectSelection(scoped[0].key);
			try {
				queueTool("Agent", { prompt: "限定候选的复杂实现", description: "scoped selection" });
				await session!.prompt("仅允许本次指定型号和档位");
				assert.equal(fixture.agentCalls.at(-1)!.params.model, scoped[0].model);
				const native = harness.classifierRequests.at(-1)!;
				const questions = native.questions as ChatQuestions;
				const selection = (native.questions as AnyRecord).selection as AnyRecord;
				assert.deepEqual(Object.keys(selection.criteria as AnyRecord), [scoped[0].key, "unresolved"]);
				const luna = harness.laneRequests[LUNA_ID].at(-1)!, deepseekLane = harness.laneRequests[DEEPSEEK_ID].at(-1)!;
				const minimax = harness.laneRequests[MINIMAX_ID].at(-1)!;
				assertResponsesLane(luna.body, LUNA_ID, questions);
				assertResponsesLane(deepseekLane.body, DEEPSEEK_ID, questions);
				assertMiniMaxLane(minimax.body, questions);
				assert.deepEqual(JSON.parse(chatMessage(luna.body, "developer")), { state: native.state, questions: native.questions });
				assert.deepEqual(JSON.parse(chatMessage(deepseekLane.body, "system")), { state: native.state, questions: native.questions });
				assert.deepEqual(JSON.parse(anthropicMessage(minimax.body).message), { state: native.state, questions: native.questions });
				const format = (luna.body.text as AnyRecord).format as AnyRecord;
				const selectionSchema = ((format.schema as AnyRecord).properties as AnyRecord).selection as AnyRecord;
				assert.deepEqual(selectionSchema.enum, [scoped[0].key, "unresolved"]);
				harness.arrange({ classifier: "error" });
				queueTool("Agent", { prompt: "限定候选的失败接管", description: "scoped guide" });
				await session!.prompt("四路都失败后仍只展示有效候选");
				const decision = (lastAgentResult(session!)!.details as AnyRecord).tsgwDelegation as AnyRecord;
				const rows = (decision.selectionGuide as string).split("\n").filter(line => line.startsWith("| tsgw/"));
				assert.deepEqual(rows, scoped.map(entry => `| ${entry.model} | ${entry.instructions} |`));
				assert.deepEqual(selectionErrors(decision).map(entry => entry.source.model).sort(),
					[`tsgw/${String(harness.classifierRequests.at(-1)!.model)}`, laneModel(DEEPSEEK_ID), laneModel(LUNA_ID),
						laneModel(MINIMAX_ID)].sort(), "受限会话同样逐路记录四路失败");
			} finally {
				session!.setScopedModels([]);
				harness.expectSelection(deepseekHigh.key);
			}
		});

		await t.test("聊天模型缺席时只发实际可用的通道，逐路摘要不臆造缺席通道", async () => {
			// 目录缺 Luna：DeepSeek 与 MiniMax 仍各发一次，chatModel 落到首个实际发起者。
			sandbox.catalogIds = BASE_CATALOG.filter(id => id !== LUNA_ID);
			await refresh();
			assert.equal(runtime!.getModel("tsgw", LUNA_ID), undefined);
			harness.arrange({ classifier: "error" });
			const classifiersBefore = harness.classifierRequests.length, laneBefore = harness.laneCounts();
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "缺 Luna 的任务", description: "no luna" });
			await session!.prompt("目录缺少 Luna 聊天选型模型");
			assert.equal(harness.classifierRequests.length, classifiersBefore + 1);
			assert.equal(harness.laneRequests[LUNA_ID].length, laneBefore[0]!, "目录没有 Luna 时不得发出该通道");
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /分类请求失败（HTTP 402）/);
			const decision = (result!.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assertChatModels(decision, [DEEPSEEK_ID, MINIMAX_ID]);
			assert.equal(decision.chatModel, laneModel(DEEPSEEK_ID), "缺少 Luna 时 chatModel 记录首个实际发起的聊天模型");
			assert.deepEqual(selectionErrors(decision).map(entry => entry.source.model).sort(),
				[classifierModel(), laneModel(DEEPSEEK_ID), laneModel(MINIMAX_ID)].sort(),
				"缺席的 Luna 不得出现在逐路错误摘要中");

			// 三款聊天模型都不在目录：只跑原生分类，不伪造 chatModel 或聊天错误。
			sandbox.catalogIds = BASE_CATALOG.filter(id => ![LUNA_ID, DEEPSEEK_ID, MINIMAX_ID].includes(id));
			await refresh();
			harness.arrange({ classifier: "error" });
			const silentBefore = harness.laneCounts();
			queueTool("Agent", { prompt: "无聊天模型任务", description: "no chat lanes" });
			await session!.prompt("目录缺少全部聊天选型模型");
			assert.deepEqual(harness.laneCounts(), silentBefore, "没有可用聊天模型时不得发出任何聊天请求");
			const blocked = lastAgentResult(session!);
			assert.equal(blocked?.isError, true);
			const blockedDecision = (blocked!.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(blockedDecision.status, "blocked");
			assert.equal(blockedDecision.chatModel, undefined, "未发起聊天通道时不记录 chatModel");
			assert.equal(blockedDecision.chatModels, undefined, "未发起聊天通道时不记录 chatModels");
			assert.deepEqual(selectionErrors(blockedDecision).map(entry => entry.source.model),
				[classifierModel()], "只记录实际发起的原生分类错误");
			sandbox.catalogIds = [...BASE_CATALOG];
			await refresh();
		});

		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
