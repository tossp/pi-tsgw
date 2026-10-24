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

type CapturedClassifierRequest = { body: AnyRecord; headers: Headers };

const CLASSIFIER_IDS = ["jev-latest", "jev-preview"] as const;
const BASE_CATALOG = ["gpt-6-sol", "jev-latest", "jev-preview", "deepseek-flash", "gpt-6-astra", "kimi-k3.1-pro"];
const FIXTURE_TOOLS = ["Agent", "probe_nested", "get_subagent_result", "steer_subagent"];

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

// 独立进程；HostSandbox 先隔离 env/网络，之后才动态 import SDK 与 pi-ai。
test("Pi 1.2 delegation：真实宿主分类选型、阻止与结果增强", { timeout: 90_000 }, async t => {
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
		const configure = (extra: AnyRecord = {}) => writeFileSync(join(sandbox.agentDir, "settings.json"),
			JSON.stringify({ tsgw: { baseUrl: TEST_ROOT, ...extra } }));
		configure();
		const guardedFetch = globalThis.fetch;
		const classifierRequests: CapturedClassifierRequest[] = [];
		const mainRequests: AnyRecord[] = [];
		const plan: { next?: { name: string; args: AnyRecord; callId: string; itemId: string } } = {};
		let callSequence = 0;
		let classificationMode: "select" | "error" | "invalid" | "remove-during" | "hang" = "select";
		let expectedKey = "";
		let expectedKind = "implement";
		let started: ReturnType<typeof makeGate> | undefined;
		const queueTool = (name: string, args: AnyRecord) => {
			const id = ++callSequence;
			plan.next = { name, args, callId: `call_fixture_${id}`, itemId: `fc_fixture_${id}` };
		};
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.origin === TEST_ROOT && url.pathname === "/v1/systemone") {
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				const body = await request.clone().json() as AnyRecord;
				classifierRequests.push({ body, headers: request.headers });
				started?.open();
				if (classificationMode === "error")
					return Response.json({ error: { message: "synthetic classifier failure" } }, { status: 500 });
				if (classificationMode === "hang") {
					await new Promise<void>(resolve => {
						const timer = setTimeout(resolve, 1_000);
						request.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
					});
					return Response.json({ error: { message: "synthetic cancellation" } }, { status: 499 });
				}
				if (classificationMode === "remove-during") {
					sandbox.catalogIds = BASE_CATALOG.filter(id => id !== "deepseek-flash");
					assert.ok(runtime);
					await runtime.refresh({ providers: ["tsgw"], allowNetwork: true, force: true });
					assert.equal(runtime.getModel("tsgw", "deepseek-flash"), undefined);
				}
				const selectionKey = classificationMode === "invalid" ? "option_not_a_candidate" : expectedKey;
				const answers = {
					kind: {
						type: "choice", choice: expectedKind,
						probabilities: { [expectedKind]: 0.9 }, confidence: 0.9,
					},
					selection: {
						type: "choice", choice: selectionKey,
						probabilities: { [selectionKey]: 0.9 }, confidence: 0.9,
					},
				};
				return Response.json({
					model: body.model,
					answers,
					usage: { input_tokens: 417, output_tokens: 68, total_tokens: 485 },
				});
			}
			if (url.origin === TEST_ROOT && url.pathname === "/v1/responses") {
				mainRequests.push(await request.clone().json() as AnyRecord);
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
			systemPrompt: "隔离 delegation 回归，仅调用合成 fixture。",
			extensionFactories: [pi => fixtureExtension(pi, fixture)] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		runtime = await Runtime.create({ authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			refreshOnCreate: false, allowModelNetwork: false });
		// 先建会话，让扩展加载时排队的 provider 注册落到这个 runtime，再刷新真实目录。
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
		const mainModel = runtime.getModel("tsgw", "gpt-6-sol");
		assert.ok(mainModel);
		const candidates = buildDelegationCandidates(
			await runtime.getAvailableOfType("chat", "tsgw"), getSupportedThinkingLevels);
		const deepseekHigh = candidates.find(candidate => candidate.id === "deepseek-flash" && candidate.level === "high");
		assert.ok(deepseekHigh, "固定选型表应提供常规工程候选");
		expectedKey = deepseekHigh.key;
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		session.setActiveToolsByName([...FIXTURE_TOOLS]);
		await session.setModel(mainModel);
		for (const name of FIXTURE_TOOLS) assert.ok(session.getActiveToolNames().includes(name), `${name} 应处于激活状态`);

		await t.test("新建 Agent：只分类一次，补 model 并保留原调用参数，结果合并 usage/摘要", async () => {
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", {
				subagent_type: "general-purpose", prompt: "实现 fixture 功能", description: "fixture 实现",
				run_in_background: true,
			});
			await session!.prompt("执行一次待选型的 Agent 任务");
			assert.equal(fixture.delegationGuidancePresent, true, "主会话应有简短派遣用法分区");
			assert.equal(classifierRequests.length, classifiersBefore + 1, "只允许一次分类请求");
			const classifierRequest = classifierRequests.at(-1)!;
			const body = classifierRequest.body;
			assert.ok(CLASSIFIER_IDS.includes(body.model as typeof CLASSIFIER_IDS[number]));
			const questions = body.questions as AnyRecord;
			assert.deepEqual(Object.keys(questions).sort(), ["kind", "selection"]);
			const kind = questions.kind as AnyRecord;
			const selection = questions.selection as AnyRecord;
			assert.equal(kind.type, "choice");
			assert.equal(selection.type, "choice");
			assert.deepEqual(Object.keys(kind.criteria as AnyRecord).sort(),
				["debug", "design_review", "dual_review", "implement", "inspect"]);
			const criteria = selection.criteria as AnyRecord;
			assert.ok(expectedKey in criteria, "分类问题必须包含当前 deepseek-flash/high 候选 key");
			assert.ok("unresolved" in criteria);
			const state = body.state as AnyRecord;
			assert.deepEqual(state.task, {
				prompt: "实现 fixture 功能", description: "fixture 实现",
				subagent_type: "general-purpose", run_in_background: true,
			});
			assert.equal(fixture.agentCalls.length, callsBefore + 1);
			const call = fixture.agentCalls.at(-1)!;
			assert.equal(call.params.model, deepseekHigh.model, "必须补入选型候选模型，不能沿用父模型");
			assert.equal(call.params.run_in_background, true, "不得改写原后台标志");
			assert.equal(call.params.prompt, "实现 fixture 功能");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, false);
			assert.equal(result.toolCallId, call.toolCallId, "原 executor 与 tool_result 必须使用同一实际 toolCallId");
			assert.match(result.toolCallId, new RegExp(`^call_fixture_${callSequence}\\|fc_fixture_`),
				"Responses 的 call_id 会附加 item.id，不能假定二者完全相等");
			const text = resultText(result);
			assert.match(text, /fixture agent executed/);
			const classifierId = `tsgw/${String(body.model)}`;
			assert.match(text, new RegExp(deepseekHigh.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(text, new RegExp(classifierId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			const details = result.details as AnyRecord;
			assert.equal(details.kind, "host-agent-result");
			assert.deepEqual(details.host, { profile: "general-purpose", marker: "keep-me" });
			const delegation = details.tsgwDelegation as AnyRecord;
			assert.equal(delegation.status, "selected");
			assert.equal(delegation.model, deepseekHigh.model);
			assert.equal(delegation.kind, "implement");
			assert.equal(delegation.classifier, classifierId);
			assert.equal(typeof delegation.durationMs, "number");
			const usage = result.usage!;
			assert.equal(usage.input, 10 + 417);
			assert.equal(usage.output, 2 + 68);
			assert.equal(usage.totalTokens, 12 + 485);
			const classifierInputCost = 417 / 1_000_000 * 0.042;
			assert.ok(Math.abs(usage.cost.input - (0.001 + classifierInputCost)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - 0.002) < 1e-12);
			assert.ok(Math.abs(usage.cost.total - (0.003 + classifierInputCost)) < 1e-12);
		});

		await t.test("新 Kimi 候选经真实宿主分类后补入原 Agent 调用", async () => {
			const kimiHigh = candidates.find(candidate => candidate.id === "kimi-k3.1-pro" && candidate.level === "high");
			assert.ok(kimiHigh);
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			expectedKey = kimiHigh.key;
			expectedKind = "inspect";
			try {
				queueTool("Agent", { subagent_type: "explore", prompt: "独立核对局部改动", description: "K3.1 局部核对", run_in_background: true });
				await session!.prompt("交给选择器安排局部核对");
				assert.equal(classifierRequests.length, classifiersBefore + 1);
				assert.equal(fixture.agentCalls.length, callsBefore + 1);
				const call = fixture.agentCalls.at(-1)!;
				assert.equal(call.params.model, "tsgw/kimi-k3.1-pro:high");
				assert.equal(call.params.subagent_type, "explore");
				assert.equal(call.params.prompt, "独立核对局部改动");
				const result = lastAgentResult(session!);
				assert.equal(result?.isError, false);
				const decision = (result!.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.kind, "inspect");
			} finally {
				expectedKey = deepseekHigh.key;
				expectedKind = "implement";
			}
		});

		await t.test("显式模型、resume、结果查询、steer 与非 Agent 均不分类", async () => {
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", {
				subagent_type: "general-purpose", prompt: "显式模型任务", description: "explicit",
				run_in_background: false, model: "tsgw/gpt-6-astra:max",
			});
			await session!.prompt("显式模型不选型");
			assert.equal(classifierRequests.length, classifiersBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 1);
			assert.equal(fixture.agentCalls.at(-1)!.params.model, "tsgw/gpt-6-astra:max");

			queueTool("Agent", { prompt: "续接任务", description: "resume", resume: "session_fixture" });
			await session!.prompt("resume 不选型");
			assert.equal(classifierRequests.length, classifiersBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 2);
			assert.equal(fixture.agentCalls.at(-1)!.params.resume, "session_fixture");
			assert.equal(fixture.agentCalls.at(-1)!.params.model, undefined);

			queueTool("get_subagent_result", { agent_id: "session_fixture" });
			await session!.prompt("结果查询不选型");
			queueTool("steer_subagent", { agent_id: "session_fixture", message: "继续" });
			await session!.prompt("steer 不选型");
			assert.equal(classifierRequests.length, classifiersBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 2);
			assert.deepEqual(fixture.resultQueries, [{ agent_id: "session_fixture" }]);
			assert.deepEqual(fixture.steers, [{ agent_id: "session_fixture", message: "继续" }]);
		});

		await t.test("model-only Agent 不能通过 ctx.executeTool 嵌套", async () => {
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("probe_nested", { nested: true });
			await session!.prompt("嵌套探测");
			assert.equal(classifierRequests.length, classifiersBefore, "不可嵌套的工具调用不应进入选型");
			assert.equal(fixture.agentCalls.length, callsBefore);
			assert.equal(fixture.nestedOutcomes.length, 1);
			assert.equal(fixture.nestedOutcomes[0].isError, true);
		});

		await t.test("分类 500 不重试且原 Agent 不执行", async () => {
			classificationMode = "error";
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "失败任务", description: "failure" });
			await session!.prompt("分类失败");
			assert.equal(classifierRequests.length, classifiersBefore + 1, "maxRetries=0 时不得重试");
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, true);
			assert.match(resultText(result), /分类请求未成功|未创建子代理/);
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.failureKind, "http");
			assert.ok(typeof decision.selectionGuide === "string" && decision.selectionGuide.length > 0);
			assert.ok(decision.selectionGuide.includes(deepseekHigh.model));
			assert.ok(decision.selectionGuide.includes("| tsgw/kimi-k3.1-pro:high | 可用 |"), "分类失败也必须提供新 Kimi 指导");
			assert.equal(decision.selectionGuide.includes("tsgw/kimi-k3:"), false, "失败指导不再推荐旧 K3");
			assert.equal(resultText(result).split(decision.selectionGuide).length - 1, 1, "宿主阻止结果仅保留一份选型表");
			assert.doesNotMatch(resultText(result), /synthetic classifier failure/);
			classificationMode = "select";
		});

		await t.test("非法 choice 阻止原 Agent 执行", async () => {
			classificationMode = "invalid";
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "非法选择任务", description: "invalid" });
			const tokensBefore = session!.getSessionStats().tokens.input;
			await session!.prompt("非法选择");
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /无效|未决|未创建子代理/);
			assert.equal(result!.usage?.totalTokens, 485, "执行前阻止不触发 tool_result，最终消息仍须计分类用量");
			assert.equal(((result!.details as AnyRecord).tsgwDelegation as AnyRecord).status, "blocked");
			const persisted = session!.sessionManager.getBranch().find(entry => entry.type === "message" &&
				entry.message.role === "toolResult" && entry.message.toolCallId === result!.toolCallId);
			assert.ok(persisted && persisted.type === "message" && persisted.message.role === "toolResult");
			assert.equal(persisted.message.usage?.totalTokens, 485, "失败选型用量须写入会话而非仅内存展示");
			assert.ok(session!.getSessionStats().tokens.input - tokensBefore >= 417, "会话统计须包含失败选型的输入 tokens");
			classificationMode = "select";
		});

		await t.test("分类期间目录移除阻止原 Agent 执行", async () => {
			classificationMode = "remove-during";
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "目录变化任务", description: "catalog removal" });
			await session!.prompt("目录移除");
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /不在当前可用候选|未创建子代理/);
			assert.equal(result!.usage?.totalTokens, 485, "目录失效不能抹去已完成的分类用量");
			classificationMode = "select";
			sandbox.catalogIds = [...BASE_CATALOG];
			await refresh();
		});

		await t.test("后续 permission handler 仍可阻止已选型的 Agent 创建", async () => {
			fixture.blockAgent = true;
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "权限阻止任务", description: "permission" });
			await session!.prompt("权限阻止");
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			assert.equal(fixture.agentCalls.length, callsBefore);
			assert.equal(fixture.permissionBlocks, 1);
			assert.equal(fixture.permissionSeenModel, deepseekHigh.model, "后续权限钩子应看到选型后的 model");
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /fixture permission handler blocked Agent/);
			assert.equal(result!.usage?.totalTokens, 485, "后续权限阻止时分类用量仍计入一次");
			assert.equal(((result!.details as AnyRecord).tsgwDelegation as AnyRecord).status, "selected");
			fixture.blockAgent = false;
		});

		await t.test("取消分类阻止原 Agent 执行", async () => {
			classificationMode = "hang";
			started = makeGate();
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "取消任务", description: "cancel" });
			const prompt = session!.prompt("取消选型");
			await started.promise;
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			await session!.abort();
			await prompt.catch(() => undefined);
			await session!.waitForIdle();
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.equal(((result!.details as AnyRecord).tsgwDelegation as AnyRecord).status, "blocked");
			const decision = (result!.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.failureKind, "cancelled");
			assert.equal(decision.selectionGuide, undefined, "取消不得引导自动重新派遣");
			classificationMode = "select";
			started = undefined;
		});

		await t.test("重载不会双注入或重复分类", async () => {
			await session!.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			session!.setActiveToolsByName([...FIXTURE_TOOLS]);
			// 重载会重新注册 provider，真实目录需要再次通过宿主刷新后才能参与选型。
			await refresh();
			const reloadedModel = runtime!.getModel("tsgw", "gpt-6-sol");
			assert.ok(reloadedModel);
			await session!.setModel(reloadedModel);
			const classifiersBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "重载后任务", description: "reload" });
			await session!.prompt("重载后再次选型");
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			assert.equal(fixture.agentCalls.length, callsBefore + 1);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, false);
			const text = resultText(result!);
			assert.equal((text.match(/TSGW 创建前选型/g) ?? []).length, 1, "重载后摘要只能追加一次");
			const details = result!.details as AnyRecord;
			assert.equal((details.tsgwDelegation as AnyRecord).model, deepseekHigh.model);
		});

		await t.test("会话范围显式档位参与候选过滤", async () => {
			const deepseek = runtime!.getModel("tsgw", "deepseek-flash");
			assert.ok(deepseek);
			const selected = buildDelegationCandidates([deepseek], getSupportedThinkingLevels)
				.find(candidate => candidate.level === "max");
			assert.ok(selected);
			session!.setScopedModels([{ model: deepseek, thinkingLevel: "max" }]);
			expectedKey = selected.key;
			try {
				queueTool("Agent", { prompt: "复杂实现任务", description: "scoped effort" });
				await session!.prompt("仅允许指定范围的档位");
				assert.equal(fixture.agentCalls.at(-1)!.params.model, selected.model);
				const questions = classifierRequests.at(-1)!.body.questions as AnyRecord;
				assert.deepEqual(Object.keys((questions.selection as AnyRecord).criteria as AnyRecord),
					[selected.key, "unresolved"], "不得把同模型的其他档位交给分类器");
			} finally {
				session!.setScopedModels([]);
				expectedKey = deepseekHigh.key;
			}
		});

		await t.test("带 Pi Web 子代理标记的会话即使有 Agent 也不选型或注入用法", async () => {
			// 标记模拟宿主在子会话 session_start 前写入的元数据，不启动真实子会话。
			session!.sessionManager.appendCustomEntry("pi-web:subagent", { version: 1, parentSessionId: "parent-fixture" });
			await session!.reload();
			session!.setActiveToolsByName([...FIXTURE_TOOLS]);
			await refresh();
			const reloadedModel = runtime!.getModel("tsgw", "gpt-6-sol");
			assert.ok(reloadedModel);
			await session!.setModel(reloadedModel);
			const classificationsBefore = classifierRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "子会话内部任务", description: "child role" });
			await session!.prompt("子代理角色不自动选型");
			assert.equal(classifierRequests.length, classificationsBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "不介入，不自行禁止宿主原工具");
			assert.equal(fixture.agentCalls.at(-1)!.params.model, undefined);
			assert.equal(fixture.delegationGuidancePresent, false);
		});

		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
