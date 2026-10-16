import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, BuildSystemPromptOptions, ExtensionError } from "@earendil-works/pi-coding-agent";
import { modelsForRoot, PROVIDER_ID } from "./extensions/models/catalog.ts";
import { MEMORY_RULES } from "./prompts/memory.ts";
import { HostSandbox, TEST_KEY, TEST_ROOT, type CapturedRequest } from "./extensions/host-test-support.test.ts";

// 同时兼容源码执行与 tsc 的 dist 输出，不依赖 cwd 或机器特定路径。
// 始终通过 Pi/jiti 加载源码入口。
function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位 pi-tsgw 包根目录");
		dir = parent;
	}
}

function searchTool(request: CapturedRequest): Record<string, unknown> {
	assert.ok(Array.isArray(request.body.tools));
	const tools = request.body.tools as Record<string, unknown>[];
	const matches = tools.filter((tool) => tool.type === "web_search");
	assert.equal(matches.length, 1, "HTTP 请求中必须恰有一个原生搜索工具");
	return matches[0]!;
}

function trace(request: CapturedRequest): { thread: string; turn: string } {
	const thread = request.headers.get("AH-Thread-Id");
	const turn = request.headers.get("AH-Trace-Id");
	assert.match(thread ?? "", /^[0-9a-f-]{36}$/);
	assert.match(turn ?? "", /^[0-9a-f-]{36}$/);
	return { thread: thread!, turn: turn! };
}

// 在独立 Node 进程中运行：环境与网络防护有意作用于整个进程。
// 不使用 FakePi、模拟 SDK 方法、凭据或真实服务器。
test("Pi 1.2 SDK：源码加载、目录刷新、命令、请求钩子、记忆规则与重载", { timeout: 60_000 }, async () => {
	const entry = sourceEntry();
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	let session: AgentSession | undefined;
	try {
		// 必须动态导入：SDK 必须在沙箱内初始化。
		const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify({
			tsgw: { baseUrl: TEST_ROOT, tsSearch: "live", traceHeaders: true, mcpUrl: "https://obsolete-mcp.invalid/mcp" },
		}));
		const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8"));
		assert.deepEqual(manifest.pi.extensions, ["./index.ts"], "包清单只登记根插件入口");
		const settings = SettingsManager.inMemory({
			packages: [{ source: dirname(entry), skills: [], prompts: [], themes: [] }], extensions: [],
			compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
			cacheWarming: "off",
			transport: "sse",
		});
		const lifecycle: string[] = [];
		const errors: ExtensionError[] = [];
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			// 通过包清单发现根入口，防止能力模块被当作独立扩展重复加载。
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "简短回答。这是隔离的宿主回归测试。",
			extensionFactories: [(pi) => {
				pi.on("session_start", (event) => {
					assert.deepEqual(pi.getMcpServers(), [], "插件不得登记 MCP；旧 mcpUrl 也不生效");
					lifecycle.push(`start:${event.reason}`);
				});
				pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, 2, "仅加载项目入口和生命周期观察器");
		assert.ok(loader.getExtensions().extensions.some((extension) => extension.path === entry));
		assert.equal(sandbox.catalogCalls, 0, "无已存储凭据：静态启动不得发起请求");
		const runtime = await ModelRuntime.create({
			authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		assert.deepEqual(await runtime.listCredentials(), [], "不得存在环境凭据或真实已存储凭据");
		({ session } = await createAgentSession({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
			resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(sandbox.cwd), tools: [],
			thinkingLevel: "high",
		}));
		const staticModels = modelsForRoot(TEST_ROOT);
		assert.deepEqual(runtime.getModels(PROVIDER_ID).map((model) => model.id).sort(),
			staticModels.map((model) => model.id).sort());
		assert.equal(runtime.getAllModels(PROVIDER_ID).length, staticModels.length);
		assert.equal(runtime.getModelsOfType("chat", PROVIDER_ID).length, staticModels.length);
		assert.equal(runtime.getModelsOfType("image", PROVIDER_ID).length, 0);
		assert.equal(runtime.getModelsOfType("classifier", PROVIDER_ID).length, 0);
		const names = session.extensionRunner.getRegisteredCommands().map((command) => command.name).sort();
		assert.deepEqual(names, ["tsgw", "tsgw-refresh", "tsgw-search"]);
		await runtime.setRuntimeApiKey(PROVIDER_ID, TEST_KEY);
		const model = runtime.getModel(PROVIDER_ID, "gpt-6.1-sol");
		assert.ok(model);
		await session.setModel(model);
		await session.bindExtensions({ mode: "print", onError: (error) => { errors.push(error); } });
		assert.equal(lifecycle.length, 1);
		assert.match(lifecycle[0]!, /^start:/);

		// 不依赖模型 provider 或技能主动加载；通过真实运行器确认结构化分区。
		const basePrompt = {
			cwd: sandbox.cwd, customPrompt: "保留宿主前缀",
			appendSystemPrompt: "保留用户追加提示词", sections: { fixture: "保留其他扩展分区" },
		};
		for (const trigger of [
			{ messageType: "user" as const, prompt: "注入测试" },
			{ messageType: "custom" as const, message: {
				role: "custom" as const, customType: "fixture", content: "自定义启动测试",
				display: false, timestamp: 0,
			} },
		]) {
			const result: { systemPromptOptions: BuildSystemPromptOptions } =
				await session.extensionRunner.emitBeforeAgentStart(trigger, basePrompt);
			assert.deepEqual(result.systemPromptOptions.sections,
				{ fixture: "保留其他扩展分区", tsgw_memory: MEMORY_RULES });
			assert.equal(result.systemPromptOptions.customPrompt, basePrompt.customPrompt);
			assert.equal(result.systemPromptOptions.appendSystemPrompt, basePrompt.appendSystemPrompt);
			assert.equal(result.systemPromptOptions.forceSystemPrompt, undefined);
		}

		// 真实斜杠命令分发，包括无 UI 时的诊断防护。
		await session.prompt("/tsgw");
		assert.equal(sandbox.requests.length, 0);
		sandbox.catalogIds = [model.id, "deepseek-v4-pro", "not-in-static-catalog"];
		await session.prompt("/tsgw-refresh");
		assert.equal(sandbox.catalogCalls, 1);
		const expectedIds = staticModels.filter((m) => sandbox.catalogIds.includes(m.id)).map((m) => m.id).sort();
		assert.deepEqual(runtime.getModels(PROVIDER_ID).map((m) => m.id).sort(), expectedIds);
		assert.ok(expectedIds.length < staticModels.length);
		// 不手工构造缓存：失败时复用真实刷新产生的状态。
		sandbox.catalogFails = true;
		await session.prompt("/tsgw-refresh");
		assert.equal(sandbox.catalogCalls, 2);
		assert.deepEqual(runtime.getModels(PROVIDER_ID).map((m) => m.id).sort(), expectedIds);
		sandbox.catalogFails = false;

		await session.prompt("/tsgw-search cached");
		await session.prompt("First fixture request");
		assert.equal(session.getLastAssistantText(), "fixture reply");
		assert.equal(sandbox.requests.length, 1);
		assert.equal(sandbox.requests[0]!.body.model, model.id);
		assert.equal(searchTool(sandbox.requests[0]!).external_web_access, false);
		const firstTrace = trace(sandbox.requests[0]!);
		await session.prompt("/tsgw-search live");
		await session.prompt("Second fixture request");
		assert.equal(sandbox.requests.length, 2);
		assert.equal(searchTool(sandbox.requests[1]!).external_web_access, true);
		const secondTrace = trace(sandbox.requests[1]!);
		assert.equal(secondTrace.thread, firstTrace.thread);
		assert.notEqual(secondTrace.turn, firstTrace.turn);

		await session.prompt("/tsgw-search cached");
		const oldRunner = session.extensionRunner;
		await session.reload();
		assert.notEqual(session.extensionRunner, oldRunner);
		assert.deepEqual(lifecycle.slice(1), ["shutdown:reload", "start:reload"]);
		assert.deepEqual(loader.getExtensions().errors, []);
		// 已失效运行器的迟到回调仍使用自身标量快照。
		// 调用真实运行器的分发器，不直接调用扩展处理器。
		const latePayload = await oldRunner.emitBeforeProviderRequest({ model: model.id, tools: [] });
		const lateHeaders = await oldRunner.emitBeforeProviderHeaders({});
		assert.equal(searchTool({ body: latePayload as Record<string, unknown>, headers: new Headers() }).external_web_access, false);
		assert.equal(lateHeaders["AH-Thread-Id"], firstTrace.thread);
		await session.prompt("After reload: settings must restore live search");
		assert.equal(session.getLastAssistantText(), "fixture reply");
		assert.equal(sandbox.requests.length, 3);
		assert.equal(searchTool(sandbox.requests[2]!).external_web_access, true);
		assert.notEqual(trace(sandbox.requests[2]!).thread, firstTrace.thread);
		for (const request of sandbox.requests) {
			const body = JSON.stringify(request.body);
			const encodedRules = JSON.stringify(MEMORY_RULES).slice(1, -1);
			assert.equal(body.split(encodedRules).length - 1, 1,
				"每次请求必须包含一份完整记忆规则，连续运行与重载不得累加");
			assert.match(body, /简短回答。这是隔离的宿主回归测试。/);
		}
		assert.deepEqual(errors, [], "真实扩展运行器不得吞掉生命周期或钩子错误");
		assert.deepEqual(sandbox.blocked, [], "不得出现意外网络访问，即使错误被 Pi 捕获");
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
