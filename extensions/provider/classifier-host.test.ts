import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import type { ClassifierContext } from "@earendil-works/pi-ai";
import { HostSandbox, TEST_KEY, TEST_ROOT, type CapturedRequest } from "#tsgw/host-test-support.test";
import { TYPESAFE_CLASSIFIER_MODEL_IDS as CLASSIFIER_MODEL_IDS } from "#tsgw/models/vendors/typesafe";

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

const context: ClassifierContext = {
	state: { message: "I was charged twice. Please refund me today." },
	questions: {
		urgent: { type: "bool", instructions: "Is this urgent?", criteria: { true: "Today", false: "Can wait" } },
		department: { type: "choice", instructions: "Which team?", criteria: { billing: "Refunds", technical: "Bugs", other: "Other" } },
		severity: { type: "score", instructions: "Severity?", criteria: ["Minor", "Workaround", "Blocked"] },
	},
};
const wireAnswers = {
	urgent: { type: "noul", noul: 0.85 },
	department: { type: "choice", choice: "billing", probabilities: { billing: 0.9, technical: 0.05, other: 0.05 }, confidence: 0.85 },
	severity: { type: "score", score: 0.32, confidence: 0.52 },
};

/** 由真实 Responses 适配器触发一次真实 codemode 执行，不伪造工具执行结果。 */
function codemodeResponse(code: string, custom: boolean): Response {
	const item = custom
		? { id: "ctc_classifier", type: "custom_tool_call", call_id: "call_classifier", name: "codemode", input: code, status: "completed" }
		: { id: "fc_classifier", type: "function_call", call_id: "call_classifier", name: "codemode", arguments: JSON.stringify({ code }), status: "completed" };
	const events = [
		{ type: "response.created", response: { id: "resp_classifier", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: custom ? { ...item, input: "" } : { ...item, arguments: "" } },
		custom ? { type: "response.custom_tool_call_input.delta", output_index: 0, delta: code }
			: { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify({ code }) },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_classifier", status: "completed", output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

// 独立进程，SDK 仅在 HostSandbox 隔离环境和网络后导入；不读个人配置、不请求生产。
test("Pi 1.2 classifier：源码加载、原生认证/解析、codemode、过滤刷新与重载", { timeout: 60_000 }, async t => {
	const entry = sourceEntry();
	const sandbox = new HostSandbox();
	let session: AgentSession | undefined;
	try {
		const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } =
			await import("@earendil-works/pi-coding-agent");
		assert.match(VERSION, /^1\.2\./, "此宿主集成回归的已验证基线是 Pi 1.2 SDK");
		const configure = (extra = {}) => writeFileSync(join(sandbox.agentDir, "settings.json"),
			JSON.stringify({ tsgw: { baseUrl: TEST_ROOT, ...extra } }));
		configure();
		const guardedFetch = globalThis.fetch;
		const requests: CapturedRequest[] = [];
		let mode: "ok" | "error" = "ok";
		let script: string | undefined;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${TEST_ROOT}/v1/systemone`) {
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				const body = await request.json() as Record<string, unknown>;
				requests.push({ body, headers: request.headers });
				assert.ok(CLASSIFIER_MODEL_IDS.includes(body.model as typeof CLASSIFIER_MODEL_IDS[number]));
				assert.deepEqual(body.state, context.state);
				assert.deepEqual(body.questions, { ...context.questions, urgent: { ...context.questions.urgent, type: "noul" } });
				assert.equal(body.tools, undefined, "分类请求不混入聊天搜索工具");
				assert.equal(body.reasoning, undefined);
				if (mode === "error") return Response.json({ error: { message: "synthetic internal response" } }, { status: 500 });
				return Response.json({ model: body.model, answers: wireAnswers, usage: { input_tokens: 417, output_tokens: 68 } });
			}
			if (request.url === `${TEST_ROOT}/v1/responses` && script !== undefined) {
				const body = await request.json() as { tools: { name?: string; type?: string }[] };
				const tool = body.tools.find(tool => tool.name === "codemode");
				assert.ok(tool);
				const code = script;
				script = undefined;
				return codemodeResponse(code, tool.type === "custom");
			}
			return guardedFetch(request);
		};
		const errors: ExtensionError[] = [];
		const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse" });
		const loader = new DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "隔离 classifier 回归，仅调用合成 fixture。", extensionFactories: [createCodemodeExtension()] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			refreshOnCreate: false, allowModelNetwork: false });
		({ session } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
			resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd),
			tools: ["codemode"], thinkingLevel: "off" }));
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		const activeSession = session;
		const classifiers = () => runtime.getModelsOfType("classifier", "tsgw");
		const classifier = (id = "jev-latest") => {
			const model = runtime.getModelOfType("classifier", "tsgw", id);
			assert.ok(model);
			return model;
		};
		const refresh = async () => {
			const result = await runtime.refresh({ providers: ["tsgw"], allowNetwork: true, force: true });
			assert.deepEqual([...result.errors], []);
			assert.equal(result.aborted, false);
		};

		await t.test("无凭据不静态恢复；交集只登记两款 Jev，非聊天/图片身份", async () => {
			assert.deepEqual(classifiers(), []);
			assert.equal(sandbox.catalogCalls, 0);
			await runtime.setRuntimeApiKey("tsgw", TEST_KEY);
			sandbox.catalogIds = ["gpt-6-sol", "gpt-image-2.5-flare", ...CLASSIFIER_MODEL_IDS, "Kev-4B", "SemIf"];
			await refresh();
			assert.deepEqual(classifiers().map(m => m.id), [...CLASSIFIER_MODEL_IDS]);
			assert.equal(runtime.getAllModels("tsgw").length, 4);
			for (const id of CLASSIFIER_MODEL_IDS) {
				assert.equal(runtime.getModel("tsgw", id), undefined);
				assert.equal(runtime.getModelOfType("image", "tsgw", id), undefined);
			}
		});
		await t.test("逐 ID 复用宿主凭据、三种问题转换、usage 与公开参考价", async () => {
			for (const id of CLASSIFIER_MODEL_IDS) {
				const count = requests.length;
				const result = await runtime.classify(classifier(id), context);
				assert.equal(requests.length, count + 1);
				assert.equal(result.stopReason, "stop");
				assert.deepEqual(result.answers, { ...wireAnswers, urgent: { type: "bool", probability: 0.85 } });
				assert.equal(result.usage?.input, 417);
				assert.equal(result.usage?.output, 68, "不丢弃上游实际报告的输出 tokens");
				assert.equal(result.usage?.totalTokens, 485);
				assert.equal(result.usage?.cost.input, 417 / 1_000_000 * 0.042);
				assert.equal(result.usage?.cost.output, 0, "官方参考输出价为零，不证明网关免费");
			}
		});
		await t.test("真实 codemode 发现并运行 classifier，聊天调用保持 Responses", async () => {
			await activeSession.setModel(runtime.getModel("tsgw", "gpt-6-sol")!);
			script = `const list=await models.getAvailableOfType("classifier","tsgw");\n` +
				`const m=await models.getModelOfType("classifier","tsgw","jev-preview");\n` +
				`const r=await models.classify(m,${JSON.stringify(context)});\n` +
				`text({ids:list.map(m=>m.id),stopReason:r.stopReason,answers:r.answers});`;
			const before = requests.length;
			await activeSession.prompt("运行隔离分类回归脚本");
			assert.equal(requests.length, before + 1);
			const result = [...activeSession.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "codemode");
			assert.ok(result && result.role === "toolResult");
			assert.equal(result.isError, false);
			const output = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
			assert.match(output, /jev-preview/);
			assert.match(output, /billing/);
		});
		await t.test("500 不自动重试；刷新失败保持 classifier，再刷新可撤下", async () => {
			mode = "error";
			const before = requests.length;
			assert.equal((await runtime.classify(classifier(), context)).stopReason, "error");
			assert.equal(requests.length, before + 1);
			mode = "ok";
			sandbox.catalogFails = true;
			const failed = await runtime.refresh({ providers: ["tsgw"], force: true, allowNetwork: true });
			assert.equal(failed.errors.has("tsgw"), true);
			assert.deepEqual(classifiers().map(m => m.id), [...CLASSIFIER_MODEL_IDS]);
			sandbox.catalogFails = false;
			sandbox.catalogIds = ["gpt-6-sol"];
			await refresh();
			assert.deepEqual(classifiers(), []);
		});
		await t.test("重载和 include/exclude 过滤不绕过交集，未知型号不可恢复", async () => {
			configure({ excludeModels: ["jev-*"], includeModels: ["jev-preview", "Kev-4B"] });
			await activeSession.reload();
			assert.deepEqual(classifiers(), []);
			sandbox.catalogIds = ["gpt-6-sol", ...CLASSIFIER_MODEL_IDS, "Kev-4B"];
			await refresh();
			assert.deepEqual(classifiers().map(m => m.id), ["jev-preview"]);
			sandbox.catalogIds = ["gpt-6-sol", "jev-latest", "Kev-4B"];
			await refresh();
			assert.deepEqual(classifiers(), [], "include 无法恢复网关缺席的预览型号或未登记的 Kev");
		});
		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
