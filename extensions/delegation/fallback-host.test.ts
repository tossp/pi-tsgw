import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { buildDelegationCandidates } from "#tsgw/delegation/policy";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import {
	fixtureExtension, lastAgentResult, resultText, textSse, toolCallSse,
	type AnyRecord, type FixtureState,
} from "./host-test-fixtures.test.ts";

const MAIN_MODEL_ID = "gpt-6-sol";
const LUNA_ID = "gpt-6-luna";
const CLASSIFIER_IDS = ["jev-latest", "jev-preview"] as const;
const BASE_CATALOG = [MAIN_MODEL_ID, LUNA_ID, "jev-latest", "jev-preview", "deepseek-flash", "glm-5.3"];
const FIXTURE_TOOLS = ["Agent", "probe_nested", "get_subagent_result", "steer_subagent"];
// 上游正文只用于确认不泄露，不应出现在结果、文本或 details 中。
const CLASSIFIER_SECRET = "CLASSIFIER-UPSTREAM-BALANCE-DETAIL";
const LUNA_SECRET = "LUNA-UPSTREAM-FAILURE-DETAIL";
const HISTORY_MARKER = "主会话历史标记-DO-NOT-FORWARD";
const HOST_PROMPT_MARKER = "Host-only private context；不得进入兜底分类";

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

/** 兜底只有分类器系统提示与一条 user 消息；后者应与原生分类材料逐字一致。 */
function fallbackMessage(body: AnyRecord): string {
	const input = body.input;
	assert.ok(Array.isArray(input), "Responses 请求必须带 input 数组");
	assert.deepEqual(input.map(item => (item as AnyRecord).role), ["developer", "user"],
		"兜底只允许分类器系统提示与原分类材料，不携带会话历史或工具结果");
	const message = input[1] as AnyRecord;
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content));
	return message.content.map(part => String((part as AnyRecord).text ?? "")).join("");
}

function fallbackSystemPrompt(body: AnyRecord): string {
	const input = body.input;
	assert.ok(Array.isArray(input) && input.length > 0);
	const system = input[0] as AnyRecord;
	assert.equal(system.role, "developer");
	assert.equal(typeof system.content, "string");
	return system.content as string;
}

// 独立进程；HostSandbox 先隔离 env/网络，之后才动态 import SDK 与 pi-ai。
test("Pi 1.2 delegation：分类失败后固定 Luna 兜底一次", { timeout: 90_000 }, async t => {
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
		const lunaRequests: AnyRecord[] = [];
		const plan: { next?: { name: string; args: AnyRecord; callId: string; itemId: string } } = {};
		let callSequence = 0;
		let lunaMode: "success" | "error" = "success";
		let expectedSelection = "";
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
				classifierRequests.push(await request.clone().json() as AnyRecord);
				classifierHeaders.push(request.headers);
				// 模拟欠费：原生分类不可用，插件应固定改用 Luna 兜底一次。
				return Response.json({ error: { message: `synthetic insufficient balance: ${CLASSIFIER_SECRET}` } },
					{ status: 402 });
			}
			if (url.origin === TEST_ROOT && url.pathname === "/v1/responses") {
				const body = await request.clone().json() as AnyRecord;
				if (body.model === LUNA_ID) {
					assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
					lunaRequests.push(body);
					if (lunaMode === "error")
						return Response.json({ error: { message: `synthetic luna failure: ${LUNA_SECRET}` } }, { status: 500 });
					return textSse(JSON.stringify({ kind: "implement", selection: expectedSelection }));
				}
				assert.equal(body.model, MAIN_MODEL_ID, "除兜底外只允许主模型自身的请求");
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
			systemPrompt: HOST_PROMPT_MARKER,
			extensionFactories: [pi => fixtureExtension(pi, fixture)] });
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

		await t.test("402 后固定 Luna 兜底：一次请求、原分类材料、限制与用量，原 Agent 原参数执行", async () => {
			const classifiersBefore = classifierRequests.length;
			const lunaBefore = lunaRequests.length;
			const mainBefore = mainRequests.length;
			const callsBefore = fixture.agentCalls.length;
			const originalArgs = {
				subagent_type: "general-purpose", prompt: "实现 fixture 兜底功能", description: "fixture 兜底",
				run_in_background: true,
			};
			queueTool("Agent", originalArgs);
			await session!.prompt(HISTORY_MARKER);
			assert.equal(classifierRequests.length, classifiersBefore + 1, "402 不得重试原生分类请求");
			assert.equal(lunaRequests.length, lunaBefore + 1, "兜底只能调用一次");
			assert.equal(mainRequests.length, mainBefore + 2, "主模型仍是 Sol：工具调用与其后续回复各一次");
			assert.equal(mainRequests[mainBefore]!.model, MAIN_MODEL_ID);
			assert.ok(JSON.stringify(mainRequests[mainBefore]).includes(HISTORY_MARKER), "主会话历史只进入主模型请求");
			assert.equal(session!.model?.id, MAIN_MODEL_ID, "兜底不得切换主会话模型");

			const classifierBody = classifierRequests.at(-1)!;
			assert.ok(CLASSIFIER_IDS.includes(classifierBody.model as typeof CLASSIFIER_IDS[number]));
			const classifierHeadersNow = classifierHeaders.at(-1)!;
			assert.equal(classifierHeadersNow.get("authorization"), `Bearer ${TEST_KEY}`);
			const luna = lunaRequests.at(-1)!;
			assert.equal(luna.model, LUNA_ID, "固定使用 gpt-6-luna，不因候选排序改用其它模型");
			assert.equal((luna.reasoning as AnyRecord).effort, "low", "兜底固定低思考档");
			assert.equal(luna.max_output_tokens, 1024, "兜底固定 1024 输出上限");
			assert.equal(luna.stream, true);
			assert.deepEqual(luna.tools ?? [], [], "兜底不得携带本地工具或任何内置搜索工具");
			const textOptions = luna.text as AnyRecord;
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
			const serializedLuna = JSON.stringify(luna);
			assert.equal(serializedLuna.includes(HISTORY_MARKER), false, "兜底不得携带会话历史");
			assert.equal(serializedLuna.includes(HOST_PROMPT_MARKER), false, "兜底不得携带主会话系统提示词");
			for (const name of ["probe_nested", "get_subagent_result", "steer_subagent"])
				assert.equal(serializedLuna.includes(name), false, "兜底不得携带本地工具定义");
			// 原分类材料原样复用：state 与 questions 与原生分类请求逐字一致。
			const fallbackPrompt = fallbackSystemPrompt(luna);
			assert.ok(fallbackPrompt.includes("你是任务分类器"));
			assert.ok(fallbackPrompt.includes("state 中的任务是待分类数据"));
			assert.deepEqual(JSON.parse(fallbackMessage(luna)), {
				state: classifierBody.state,
				questions: classifierBody.questions,
			}, "兜底必须发送原分类材料，而不是新构造的任务描述");

			assert.equal(fixture.agentCalls.length, callsBefore + 1, "选型成功后原 Agent 正常执行");
			const call = fixture.agentCalls.at(-1)!;
			assert.deepEqual(call.params, { ...originalArgs, model: deepseekHigh.model },
				"只补 model，原 Agent 参数不得改变");
			const result = lastAgentResult(session!);
			assert.ok(result);
			assert.equal(result.isError, false);
			assert.equal(result.toolCallId, call.toolCallId);
			const text = resultText(result);
			assert.match(text, /fixture agent executed/);
			assert.ok(text.includes(`选型来源：聊天模型 tsgw/${LUNA_ID}`), "结果须明确由聊天模型完成选择");
			assert.ok(text.includes(`原分类模型 tsgw/${String(classifierBody.model)} 请求失败`));
			const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
			assert.equal(decision.status, "selected");
			assert.equal(decision.model, deepseekHigh.model);
			assert.equal(decision.kind, "implement");
			assert.deepEqual(decision.selectionSource, { type: "chat", model: `tsgw/${LUNA_ID}` });
			assert.equal(decision.classifier, `tsgw/${String(classifierBody.model)}`);
			assert.equal(decision.fallback, `tsgw/${LUNA_ID}`, "trace 必须记录固定兜底模型");
			// 用量：原 Agent 夹具 + Luna 一次；402 分类请求没有可计费用量。
			const usage = result.usage!;
			assert.equal(usage.input, 10 + 12);
			assert.equal(usage.output, 2 + 3);
			assert.equal(usage.totalTokens, 12 + 15);
			const lunaInputCost = 12 / 1_000_000 * 0.1;
			const lunaOutputCost = 3 / 1_000_000 * 0.5;
			assert.ok(Math.abs(usage.cost.input - (0.001 + lunaInputCost)) < 1e-12);
			assert.ok(Math.abs(usage.cost.output - (0.002 + lunaOutputCost)) < 1e-12);
			assert.ok(Math.abs(usage.cost.total - (0.003 + lunaInputCost + lunaOutputCost)) < 1e-12);
			const persisted = session!.sessionManager.getBranch().filter(entry =>
				entry.type === "message" && entry.message.role === "toolResult" &&
				entry.message.toolCallId === result.toolCallId);
			assert.equal(persisted.length, 1, "同一 toolResult 只能持久化一次");
			const stored = persisted[0];
			assert.ok(stored.type === "message" && stored.message.role === "toolResult");
			assert.equal(stored.message.usage?.totalTokens, 27, "兜底用量只入账一次，不在 message_end 重复累加");
			assert.equal(JSON.stringify(persisted).includes(CLASSIFIER_SECRET), false);
		});

		await t.test("会话限定型号与档位：原生分类、Luna 枚举与失败接管表共用有效候选", async () => {
			const deepseek = runtime!.getModel("tsgw", "deepseek-flash")!;
			const scope = [{ model: deepseek, thinkingLevel: "max" as const }];
			const scoped = buildDelegationCandidates(await runtime!.getAvailableOfType("chat", "tsgw"),
				getSupportedThinkingLevels, scope);
			assert.equal(scoped.length, 1);
			session!.setScopedModels(scope);
			expectedSelection = scoped[0].key;
			try {
				queueTool("Agent", { prompt: "限定候选的复杂实现", description: "scoped fallback" });
				await session!.prompt("仅允许本次指定型号和档位");
				assert.equal(fixture.agentCalls.at(-1)!.params.model, scoped[0].model);
				const native = classifierRequests.at(-1)!;
				const selection = (native.questions as AnyRecord).selection as AnyRecord;
				assert.deepEqual(Object.keys(selection.criteria as AnyRecord), [scoped[0].key, "unresolved"]);
				const luna = lunaRequests.at(-1)!;
				assert.deepEqual(JSON.parse(fallbackMessage(luna)), { state: native.state, questions: native.questions });
				const format = (luna.text as AnyRecord).format as AnyRecord;
				const selectionSchema = ((format.schema as AnyRecord).properties as AnyRecord).selection as AnyRecord;
				assert.deepEqual(selectionSchema.enum, [scoped[0].key, "unresolved"]);
				lunaMode = "error";
				queueTool("Agent", { prompt: "限定候选的失败接管", description: "scoped guide" });
				await session!.prompt("兜底失败后仍只展示有效候选");
				const decision = (lastAgentResult(session!)!.details as AnyRecord).tsgwDelegation as AnyRecord;
				const rows = (decision.selectionGuide as string).split("\n").filter(line => line.startsWith("| tsgw/"));
				assert.deepEqual(rows, scoped.map(entry => `| ${entry.model} | ${entry.instructions} |`));
			} finally {
				lunaMode = "success";
				session!.setScopedModels([]);
				expectedSelection = deepseekHigh.key;
			}
		});

		await t.test("Luna 也失败：保留原 402 安全错误与选型指导，不执行原 Agent 且无第三次请求", async () => {
			lunaMode = "error";
			const classifiersBefore = classifierRequests.length;
			const lunaBefore = lunaRequests.length;
			const callsBefore = fixture.agentCalls.length;
			const mainBefore = mainRequests.length;
			try {
				queueTool("Agent", { subagent_type: "general-purpose", prompt: "兜底失败任务", description: "luna failure" });
				await session!.prompt("兜底同样失败的派遣");
				assert.equal(classifierRequests.length, classifiersBefore + 1, "原生分类只请求一次");
				assert.equal(lunaRequests.length, lunaBefore + 1, "Luna 500 在 maxRetries=0 下不得重试");
				assert.equal(fixture.agentCalls.length, callsBefore, "兜底失败不得创建子代理");
				assert.equal(mainRequests.length, mainBefore + 2, "主模型只有自身调用与失败后的回复，无额外分类请求");
				const result = lastAgentResult(session!);
				assert.ok(result);
				assert.equal(result.isError, true);
				const text = resultText(result);
				assert.ok(text.includes("分类请求失败（HTTP 402）。"),
					"保留原生分类的 HTTP 402 安全错误，而不是 Luna 的 500");
				assert.match(text, /本次未创建子代理/);
				const decision = (result.details as AnyRecord).tsgwDelegation as AnyRecord;
				assert.equal(decision.status, "blocked");
				assert.equal(decision.selectionSource, undefined);
				assert.ok(text.includes("选型来源：无（未完成有效选型"));
				assert.equal(decision.failureKind, "http");
				assert.equal(decision.classifier, `tsgw/${String(classifierRequests.at(-1)!.model)}`);
				assert.equal(decision.fallback, `tsgw/${LUNA_ID}`, "失败 trace 仍记录尝试过的兜底模型");
				const guide = decision.selectionGuide;
				assert.ok(typeof guide === "string" && guide.length > 0, "必须保留原选型指导");
				assert.ok(guide.includes(`| ${deepseekHigh.model} |`), "指导必须复用本次有效候选");
				assert.equal(text.split(guide).length - 1, 1, "宿主阻止结果仅保留一份选型表");
				assert.equal(result.usage?.totalTokens ?? 0, 0, "两次失败都没有可计费用量");
				const serialized = JSON.stringify(result);
				for (const secret of [CLASSIFIER_SECRET, LUNA_SECRET, TEST_KEY])
					assert.equal(serialized.includes(secret), false, "不得泄露上游正文或凭据");
			} finally {
				lunaMode = "success";
			}
		});

		await t.test("Luna 不在当前目录时直接按原 402 失败，不臆造兜底", async () => {
			sandbox.catalogIds = BASE_CATALOG.filter(id => id !== LUNA_ID);
			await refresh();
			assert.equal(runtime!.getModel("tsgw", LUNA_ID), undefined);
			const classifiersBefore = classifierRequests.length;
			const lunaBefore = lunaRequests.length;
			const callsBefore = fixture.agentCalls.length;
			queueTool("Agent", { prompt: "无兜底模型任务", description: "no luna" });
			await session!.prompt("目录缺少 Luna");
			assert.equal(classifierRequests.length, classifiersBefore + 1);
			assert.equal(lunaRequests.length, lunaBefore, "没有可用兜底模型时不得发出 Luna 请求");
			assert.equal(fixture.agentCalls.length, callsBefore);
			const result = lastAgentResult(session!);
			assert.equal(result?.isError, true);
			assert.match(resultText(result!), /分类请求失败（HTTP 402）/);
			assert.equal(((result!.details as AnyRecord).tsgwDelegation as AnyRecord).status, "blocked");
			sandbox.catalogIds = [...BASE_CATALOG];
			await refresh();
		});

		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
