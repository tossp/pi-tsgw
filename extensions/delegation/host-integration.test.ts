import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import {
	fixtureExtension, lastAgentResult, resultText, textSse, toolCallSse,
	type AnyRecord, type FixtureState,
} from "./host.test-support.ts";
import {
	CHAT_TOKENS, GLM_ID, HUNYUAN_ID, MAIN_MODEL_ID, assertHunyuanLane, chatCompletionMessage,
	chatCompletionSse, laneCost, laneModel, type ChatQuestions,
} from "./parallel-host.test-support.ts";

const DEEPSEEK_ID = "deepseek-flash";
const BASE_CATALOG = [MAIN_MODEL_ID, HUNYUAN_ID, "jev-latest", "jev-preview", DEEPSEEK_ID, GLM_ID,
	"glm-5.3", "gpt-6-astra", "gpt-6.2-astra", "gpt-6.2-sol"];
const FIXTURE_TOOLS = ["Agent", "probe_nested", "get_subagent_result", "steer_subagent"];

type CapturedLaneRequest = { body: AnyRecord; headers: Headers };

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
test("Pi SDK delegation：混元选型、阻止与结果增强", { timeout: 90_000 }, async t => {
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
		const mainRequests: AnyRecord[] = [];
		const hunyuanRequests: CapturedLaneRequest[] = [];
		const fallbackRequests: { model: string; path: string }[] = [];
		const systemoneRequests: AnyRecord[] = [];
		const plan: { next?: { name: string; args: AnyRecord; callId: string; itemId: string } } = {};
		let callSequence = 0;
		let classificationMode: "select" | "invalid" | "scope-during" = "select";
		let selectedModel = "";
		let scopedModelId = "";
		const queueTool = (name: string, args: AnyRecord) => {
			const id = ++callSequence;
			plan.next = { name, args, callId: `call_fixture_${id}`, itemId: `fc_fixture_${id}` };
		};
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.origin === TEST_ROOT && url.pathname === "/v1/chat/completions") {
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				const body = await request.clone().json() as AnyRecord;
				hunyuanRequests.push({ body, headers: request.headers });
				assert.equal(body.model, HUNYUAN_ID);
				if (classificationMode === "scope-during") {
					const other = (await runtime!.getAvailableOfType("chat", "tsgw"))
						.find(model => !selectedModel.startsWith(`tsgw/${model.id}:`));
					assert.ok(other);
					scopedModelId = other.id;
					session!.setScopedModels([{ model: other }]);
				}
				const selectionKey = classificationMode === "invalid" ? "option_not_a_candidate" : "option_0";
				return chatCompletionSse(JSON.stringify({ kind: "implement", selection: selectionKey }));
			}
			if (url.origin === TEST_ROOT && url.pathname === "/v1/responses") {
				const body = await request.clone().json() as AnyRecord;
				if (body.model === MAIN_MODEL_ID) {
					mainRequests.push(body);
					const call = plan.next;
					plan.next = undefined;
					return call ? toolCallSse(call) : textSse("fixture main reply");
				}
				fallbackRequests.push({ model: String(body.model), path: url.pathname });
				assert.equal(body.model, DEEPSEEK_ID, "除主模型与 DeepSeek 后备外不应有其它 Responses 请求");
				return Response.json({ error: { message: "synthetic fallback failure" } }, { status: 500 });
			}
			if (url.origin === TEST_ROOT && url.pathname === "/v1/messages") {
				const body = await request.clone().json() as AnyRecord;
				fallbackRequests.push({ model: String(body.model), path: url.pathname });
				assert.equal(body.model, GLM_ID, "Anthropic Messages 只允许 GLM 后备");
				return Response.json({ error: { message: "synthetic fallback failure" } }, { status: 500 });
			}
			if (url.origin === TEST_ROOT && url.pathname === "/v1/systemone") {
				systemoneRequests.push(await request.clone().json() as AnyRecord);
				throw new Error("委派选型不应再请求原生分类通道");
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
		const mainModel = runtime.getModel("tsgw", MAIN_MODEL_ID);
		assert.ok(mainModel);
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		session.setActiveToolsByName([...FIXTURE_TOOLS]);
		await session.setModel(mainModel);
		for (const name of FIXTURE_TOOLS) assert.ok(session.getActiveToolNames().includes(name), `${name} 应处于激活状态`);

		await t.test("新建 Agent：只请求一次混元，补 model 并保留原调用参数，结果合并 usage/摘要", async () => {
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			const original = {
				subagent_type: "general-purpose", prompt: "实现 fixture 功能", description: "fixture 实现",
				run_in_background: true,
			};
			queueTool("Agent", original);
			await session!.prompt("执行一次待选型的 Agent 任务");
			assert.equal(fixture.delegationGuidancePresent, true, "主会话应有简短派遣用法分区");
			assert.equal(hunyuanRequests.length, hunyuanBefore + 1, "只允许一次混元选型请求");
			assert.equal(fallbackRequests.length, 0, "混元成功时两条后备都不发起");
			assert.equal(systemoneRequests.length, 0, "委派选型不再调用原生分类");
			const body = hunyuanRequests.at(-1)!.body;
			const material = chatCompletionMessage(body);
			const context = JSON.parse(material.user) as AnyRecord;
			assertHunyuanLane(body, context.questions as ChatQuestions);
			assert.deepEqual(context.state, { task: original });
			assert.equal(fixture.agentCalls.length, callsBefore + 1);
			const call = fixture.agentCalls.at(-1)!;
			assert.equal(typeof call.params.model, "string");
			selectedModel = call.params.model as string;
			assert.match(selectedModel, /^tsgw\/[^:]+:[^:]+$/);
			assert.deepEqual(call.params, { ...original, model: selectedModel }, "只补 model，原参数不得改变");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, false);
			assert.equal(result.toolCallId, call.toolCallId, "原 executor 与 tool_result 必须使用同一实际 toolCallId");
			assert.match(result.toolCallId, new RegExp(`^call_fixture_${callSequence}\\|fc_fixture_`),
				"Responses 的 call_id 会附加 item.id，不能假定二者完全相等");
			const text = resultText(result);
			assert.match(text, /fixture agent executed/);
			assert.ok(text.includes(selectedModel));
			assert.ok(text.includes(`选型来源：聊天模型 ${laneModel(HUNYUAN_ID)}`));
			const details = result.details as AnyRecord;
			assert.equal(details.kind, "host-agent-result");
			assert.deepEqual(details.host, { profile: "general-purpose", marker: "keep-me" });
			const delegation = details.tsgwDelegation as AnyRecord;
			assert.equal(delegation.status, "selected");
			assert.equal(delegation.model, selectedModel);
			assert.equal(delegation.kind, "implement");
			assert.equal(delegation.classifier, undefined, "不再记录已移除的原生分类通道");
			assert.deepEqual(delegation.selectionSource, { type: "chat", model: laneModel(HUNYUAN_ID) });
			assert.deepEqual(delegation.chatModels, [laneModel(HUNYUAN_ID)]);
			assert.equal(typeof delegation.durationMs, "number");
			const usage = result.usage!;
			assert.equal(usage.input, 10 + CHAT_TOKENS.input);
			assert.equal(usage.output, 2 + CHAT_TOKENS.output);
			assert.equal(usage.totalTokens, 12 + CHAT_TOKENS.total);
			const cost = laneCost(runtime!, HUNYUAN_ID);
			assert.ok(Math.abs(usage.cost.input - (0.001 + cost.input)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + cost.output)) < 1e-12);
			assert.ok(Math.abs(usage.cost.total - (0.003 + cost.input + cost.output)) < 1e-12);
			const persisted = session!.sessionManager.getBranch().filter(entry => entry.type === "message" &&
				entry.message.role === "toolResult" && entry.message.toolCallId === result.toolCallId);
			assert.equal(persisted.length, 1, "同一 toolResult 只能持久化一次");
			const stored = persisted[0];
			assert.ok(stored.type === "message" && stored.message.role === "toolResult");
			assert.equal(stored.message.usage?.totalTokens, 12 + CHAT_TOKENS.total, "选型用量落盘且不重复累加");
		});

		await t.test("显式模型、resume、结果查询、steer 与非 Agent 均不分类", async () => {
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			const fallbacksBefore = fallbackRequests.length;
			queueTool("Agent", {
				subagent_type: "general-purpose", prompt: "显式模型任务", description: "explicit",
				run_in_background: false, model: "tsgw/gpt-6-astra:max",
			});
			await session!.prompt("显式模型不选型");
			assert.equal(hunyuanRequests.length, hunyuanBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 1);
			assert.equal(fixture.agentCalls.at(-1)!.params.model, "tsgw/gpt-6-astra:max");

			queueTool("Agent", { prompt: "续接任务", description: "resume", resume: "session_fixture" });
			await session!.prompt("resume 不选型");
			assert.equal(hunyuanRequests.length, hunyuanBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 2);
			assert.equal(fixture.agentCalls.at(-1)!.params.resume, "session_fixture");
			assert.equal(fixture.agentCalls.at(-1)!.params.model, undefined);

			queueTool("get_subagent_result", { agent_id: "session_fixture" });
			await session!.prompt("结果查询不选型");
			queueTool("steer_subagent", { agent_id: "session_fixture", message: "继续" });
			await session!.prompt("steer 不选型");
			assert.equal(hunyuanRequests.length, hunyuanBefore);
			assert.equal(fallbackRequests.length, fallbacksBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 2);
			assert.deepEqual(fixture.resultQueries, [{ agent_id: "session_fixture" }]);
			assert.deepEqual(fixture.steers, [{ agent_id: "session_fixture", message: "继续" }]);
		});

		await t.test("model-only Agent 不能通过 ctx.executeTool 嵌套", async () => {
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("probe_nested", { nested: true });
			await session!.prompt("嵌套探测");
			assert.equal(hunyuanRequests.length, hunyuanBefore, "不可嵌套的工具调用不应进入选型");
			assert.equal(fixture.agentCalls.length, callsBefore);
			assert.equal(fixture.nestedOutcomes.length, 1);
			assert.equal(fixture.nestedOutcomes[0].isError, true);
		});

		await t.test("非法 choice 阻止原 Agent 执行，混元用量仍写入会话", async () => {
			classificationMode = "invalid";
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			const tokensBefore = session!.getSessionStats().tokens.input;
			queueTool("Agent", { prompt: "非法选择任务", description: "invalid" });
			try {
				await session!.prompt("非法选择");
			} finally {
				classificationMode = "select";
			}
			assert.equal(hunyuanRequests.length, hunyuanBefore + 1);
			assert.deepEqual(fallbackRequests.map(request => request.model).sort(), [DEEPSEEK_ID, GLM_ID].sort(),
				"混元非法结果必须转入两条后备");
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /无效|未决|未创建子代理/);
			assert.equal(result!.usage?.totalTokens, CHAT_TOKENS.total, "执行前阻止不触发 tool_result，最终消息仍须计混元用量");
			const decision = (result!.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "blocked");
			assert.equal(decision.failureKind, "selection_failed");
			assert.equal(decision.selectionSource, undefined);
			assert.equal((decision.selectionErrors as AnyRecord[]).length, 3, "混元非法与两条后备失败都进入安全摘要");
			const persisted = session!.sessionManager.getBranch().find(entry => entry.type === "message" &&
				entry.message.role === "toolResult" && entry.message.toolCallId === result!.toolCallId);
			assert.ok(persisted && persisted.type === "message" && persisted.message.role === "toolResult");
			assert.equal(persisted.message.usage?.totalTokens, CHAT_TOKENS.total, "失败选型用量须写入会话而非仅内存展示");
			assert.ok(session!.getSessionStats().tokens.input - tokensBefore >= CHAT_TOKENS.input,
				"会话统计须包含失败选型的输入 tokens");
		});

		await t.test("后续 permission handler 仍可阻止已选型的 Agent 创建", async () => {
			fixture.blockAgent = true;
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "权限阻止任务", description: "permission" });
			try {
				await session!.prompt("权限阻止");
			} finally {
				fixture.blockAgent = false;
			}
			assert.equal(hunyuanRequests.length, hunyuanBefore + 1);
			assert.equal(fixture.agentCalls.length, callsBefore);
			assert.equal(fixture.permissionBlocks, 1);
			assert.equal(fixture.permissionSeenModel, selectedModel, "后续权限钩子应看到选型后的 model");
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /fixture permission handler blocked Agent/);
			assert.equal(result!.usage?.totalTokens, CHAT_TOKENS.total, "后续权限阻止时选型用量仍计入一次");
			const decision = (result!.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: laneModel(HUNYUAN_ID) });
		});

		await t.test("重载不会双注入或重复分类", async () => {
			await session!.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			session!.setActiveToolsByName([...FIXTURE_TOOLS]);
			// 重载会重新注册 provider，真实目录需要再次通过宿主刷新后才能参与选型。
			await refresh();
			const reloadedModel = runtime!.getModel("tsgw", MAIN_MODEL_ID);
			assert.ok(reloadedModel);
			await session!.setModel(reloadedModel);
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "重载后任务", description: "reload" });
			await session!.prompt("重载后再次选型");
			assert.equal(hunyuanRequests.length, hunyuanBefore + 1);
			assert.equal(fixture.agentCalls.length, callsBefore + 1);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, false);
			const text = resultText(result!);
			assert.equal((text.match(/TSGW 创建前选型/g) ?? []).length, 1, "重载后摘要只能追加一次");
			const details = result!.details as AnyRecord;
			assert.equal((details.tsgwDelegation as AnyRecord).model, selectedModel);
		});

		await t.test("选型期间会话范围变化：执行前重新过滤，接管表只列最新有效候选", async () => {
			classificationMode = "scope-during";
			const callsBefore = fixture.agentCalls.length;
			try {
				queueTool("Agent", { prompt: "核验动态会话范围", description: "scope changed" });
				await session!.prompt("选型过程中收窄会话范围");
				assert.equal(fixture.agentCalls.length, callsBefore);
				const result = lastAgentResult(session!)!;
				const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.failureKind, "model_unavailable");
				const rows = (decision.selectionGuide as string).split("\n").filter(line => line.startsWith("| tsgw/"));
				assert.ok(rows.length > 0);
				assert.ok(rows.every(row => row.startsWith(`| tsgw/${scopedModelId}:`)),
					"接管表只能包含实际收窄范围中的型号，不限定该型号的推荐档位或行数");
				assert.equal((decision.selectionGuide as string).includes(`| ${selectedModel} |`), false);
			} finally {
				classificationMode = "select";
				session!.setScopedModels([]);
			}
		});

		await t.test("带 Pi Web 子代理标记的会话即使有 Agent 也不选型或注入用法", async () => {
			// 标记模拟宿主在子会话 session_start 前写入的元数据，不启动真实子会话。
			session!.sessionManager.appendCustomEntry("pi-web:subagent", { version: 1, parentSessionId: "parent-fixture" });
			await session!.reload();
			session!.setActiveToolsByName([...FIXTURE_TOOLS]);
			await refresh();
			const reloadedModel = runtime!.getModel("tsgw", MAIN_MODEL_ID);
			assert.ok(reloadedModel);
			await session!.setModel(reloadedModel);
			const hunyuanBefore = hunyuanRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "子会话内部任务", description: "child role" });
			await session!.prompt("子代理角色不自动选型");
			assert.equal(hunyuanRequests.length, hunyuanBefore);
			assert.equal(fixture.agentCalls.length, callsBefore + 1, "不介入，不自行禁止宿主原工具");
			assert.equal(fixture.agentCalls.at(-1)!.params.model, undefined);
			assert.equal(fixture.delegationGuidancePresent, false);
		});

		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
		assert.equal(systemoneRequests.length, 0);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
