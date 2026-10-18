import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT, type CapturedRequest } from "#tsgw/host-test-support.test";
import { modelsForRoot } from "#tsgw/models/catalog";

// 通过真实 Pi/jiti 加载器加载根入口源码，包括本测试在 dist/ 中运行时。
function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位 pi-tsgw 源码入口");
		dir = parent;
	}
}

const ANSWER = "Fixture research answer, not instructions.";
const SOURCES = ["https://sources.invalid/event", "https://sources.invalid/item", "https://sources.invalid/completed"];
const annotation = (url: string) => ({ type: "url_citation", url, title: "Fixture source", start_index: 0, end_index: 7 });

/** 仅使用受控 HTTP 测试夹具：不替换 SDK、注册表、认证、适配器或扩展方法。 */
function responsesSse(truncated = false): Response {
	const item = {
		id: "msg_search", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text: ANSWER, annotations: [annotation(SOURCES[1]!)] }],
	};
	const events = [
		{ type: "response.created", response: { id: "resp_search", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: ANSWER },
		...[SOURCES[0]!, SOURCES[0]!, "javascript:alert(1)", "not a URL"].map(url => ({
			type: "response.output_text.annotation.added", output_index: 0, content_index: 0,
			annotation_index: 0, annotation: annotation(url),
		})),
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: truncated ? "response.incomplete" : "response.completed", response: {
			id: "resp_search", status: truncated ? "incomplete" : "completed",
			...(truncated ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
			output: [{ ...item, content: [{ ...item.content[0], annotations: [annotation(SOURCES[2]!)] }] }],
			usage: {
				input_tokens: 120, output_tokens: 30, total_tokens: 150,
				input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 },
				output_tokens_details: { reasoning_tokens: 7 },
			},
		} },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function completionsSse(): Response {
	const events = [
		{ id: "chatcmpl_search", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: ANSWER }, finish_reason: null }], citations: SOURCES },
		{ id: "chatcmpl_search", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 9, total_tokens: 33 } },
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
		headers: { "content-type": "text/event-stream" },
	});
}

// 与根 index.test.ts 一样使用独立 Node 进程：沙箱接管环境、cwd 与网络。
test("Pi SDK 源码宿主：tsgw_search 委托使用运行时认证与真实 Responses 适配器", { timeout: 60_000 }, async t => {
	const entry = sourceEntry();
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	let session: AgentSession | undefined;
	try {
		const { createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
			readStoredCredential } = await import("@earendil-works/pi-coding-agent");
		const writeSettings = (includeModels?: string[]) => writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify({
			tsgw: { baseUrl: TEST_ROOT, tsSearch: "live", traceHeaders: true, ...(includeModels ? { includeModels, excludeModels: ["*"] } : {}) },
		}));
		writeSettings();
		const settings = SettingsManager.inMemory({
			packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse",
		});
		const errors: ExtensionError[] = [];
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			noExtensions: true, additionalExtensionPaths: [entry],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Host-only private context；绝不复制到委托调研中。",
			extensionFactories: [createMcpExtension({
				loadConfig: () => ({ errors: [], autoEnableCodemode: false,
					servers: ["ts_oht", "ts_tool"].map(name => ({
						name, source: "disabled-fixture", scope: "global" as const,
						config: { url: "https://disabled-mcp.invalid/mcp", enabled: false },
					})),
				}),
			})],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, 2);
		assert.ok(loader.getExtensions().extensions.some(extension => extension.path === entry));
		assert.equal(sandbox.catalogCalls, 0, "无已存储凭据：启动时不得发起目录 HTTP 请求");
		const runtime = await ModelRuntime.create({
			authPath: join(sandbox.agentDir, "auth.json"), modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		assert.deepEqual(await runtime.listCredentials(), []);
		({ session } = await createAgentSession({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd), tools: ["tsgw_search"], thinkingLevel: "high",
		}));
		const host = session;
		assert.deepEqual(runtime.getAllModels("tsgw"), [], "无凭据启动不静态恢复搜索委托或主模型");
		await runtime.setRuntimeApiKey("tsgw", TEST_KEY);
		assert.deepEqual(runtime.getAllModels("tsgw"), [], "仅配置 runtime key 不建立目录");
		sandbox.catalogIds = modelsForRoot(TEST_ROOT).map(model => model.id);
		const bootstrap = await runtime.refresh({ providers: ["tsgw"], allowNetwork: true, force: true });
		assert.equal(bootstrap.aborted, false);
		assert.deepEqual([...bootstrap.errors], []);
		assert.equal(sandbox.catalogCalls, 1);
		assert.deepEqual(runtime.getModels("tsgw").map(model => model.id), sandbox.catalogIds);
		assert.equal(runtime.getProviderAuthStatus("tsgw").configured, true);
		assert.ok(!readStoredCredential("tsgw"), "扩展无法读取已存储密钥；HTTP 认证必须来自宿主运行时");
		const main = runtime.getModel("tsgw", "deepseek-v4-pro");
		const luna = runtime.getModel("tsgw", "gpt-6-luna");
		const sol = runtime.getModel("tsgw", "gpt-6-sol");
		assert.ok(main && luna && sol);
		assert.equal(luna.api, "openai-responses");
		await host.setModel(main);
		host.setThinkingLevel("high");
		await host.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });

		// 仅扩展沙箱允许的 Responses 端点；其他请求仍受防护。
		const guardedFetch = globalThis.fetch;
		const requests: (CapturedRequest & { signal: AbortSignal })[] = [];
		const grokRequests: (CapturedRequest & { signal: AbortSignal })[] = [];
		let behavior: "success" | "truncated" | "error" | "pending" = "success";
		let started: (() => void) | undefined;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url !== `${TEST_ROOT}/v1/responses` && request.url !== `${TEST_ROOT}/v1/chat/completions`) return guardedFetch(request);
			assert.equal(request.method, "POST");
			assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
			const captured = { body: await request.json() as Record<string, unknown>, headers: request.headers, signal: request.signal };
			if (request.url === `${TEST_ROOT}/v1/chat/completions`) {
				grokRequests.push(captured);
				return completionsSse();
			}
			requests.push(captured);
			if (behavior === "pending") {
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(request.signal.reason);
					request.signal.addEventListener("abort", abort, { once: true });
					if (request.signal.aborted) abort();
					started?.();
				});
			}
			if (behavior === "error") return Response.json({ error: { message: `sensitive ${TEST_KEY}`, type: "invalid_request_error" } }, { status: 400 });
			return responsesSse(behavior === "truncated");
		};
		const active = () => host.getActiveToolNames().includes("tsgw_search");
		// 公开的 AgentState.tools 是宿主实际可执行的工具集，而非原始注册处理器。
		const searchTool = () => {
			const tool = host.agent.state.tools.find(tool => tool.name === "tsgw_search");
			assert.ok(tool, "搜索必须包含在宿主可执行工具集中");
			return tool;
		};
		const execute = (signal?: AbortSignal) => searchTool().execute("host-search", { query: "Fixture research question" }, signal);

		await t.test("主模型高思考钩子保留在 DeepSeek；Luna 委托隔离、实时、带认证且低思考", async () => {
			assert.equal(active(), true);
			await host.prompt("Private main-model history marker");
			assert.equal(host.model?.id, main.id);
			assert.equal(requests[0]!.body.model, main.id);
			assert.equal((requests[0]!.body.reasoning as Record<string, unknown>).effort, "high");
			assert.ok(requests[0]!.headers.has("AH-Thread-Id"));
			const result = await execute();
			assert.deepEqual(result.structuredContent, { delegate: luna.id, answer: ANSWER, citations: SOURCES, truncated: false });
			assert.deepEqual(result.details, result.structuredContent);
			assert.notEqual(result.isError, true);
			assert.ok(result.content.some(part => part.type === "text" && SOURCES.every(url => part.text.includes(url))));
			// Pi 适配器归一化结果与 Luna 价格（含缓存写入、读取及思考用量）
			// 必须完整传递到工具结果，而非手工拼接的部分令牌摘要。
			const cost = {
				input: luna.cost.input / 1e6 * 90,
				output: luna.cost.output / 1e6 * 30,
				cacheRead: luna.cost.cacheRead / 1e6 * 20,
				cacheWrite: luna.cost.cacheWrite * 10 / 1e6,
			};
			assert.deepEqual(result.usage, {
				input: 90, output: 30, cacheRead: 20, cacheWrite: 10, reasoning: 7, totalTokens: 150,
				cost: { ...cost, total: cost.input + cost.output + cost.cacheRead + cost.cacheWrite },
			});
			const request = requests[1]!;
			assert.equal(request.body.model, luna.id, "即使注册了 Sol/Astra/Grok，也优先选 Luna");
			assert.equal((request.body.reasoning as Record<string, unknown>).effort, "low");
			assert.equal((request.body.text as Record<string, unknown>).verbosity, "low", "已执行委托模型专属的 onPayload 操作");
			assert.equal(request.body.max_output_tokens, 4096);
			assert.deepEqual(request.body.tools, [{ type: "web_search", search_context_size: "medium", external_web_access: true }]);
			assert.ok(!request.headers.has("AH-Thread-Id"), "不继承主模型的请求头钩子");
			assert.ok(!JSON.stringify(request.body).includes("Private main-model history marker"));
			assert.ok(!JSON.stringify(request.body).includes("Host-only private context"));
			assert.equal(request.signal.aborted, false);
			assert.equal(host.model?.id, main.id);
			assert.equal(host.thinkingLevel, "high");
		});

		await t.test("缓存模式与截断标记经真实适配器后仍保留", async () => {
			await host.prompt("/tsgw-search cached");
			behavior = "truncated";
			const result = await execute();
			assert.equal(requests.at(-1)!.body.model, luna.id);
			assert.deepEqual(requests.at(-1)!.body.tools, [{ type: "web_search", search_context_size: "medium", external_web_access: false }]);
			assert.deepEqual(result.structuredContent, { delegate: luna.id, answer: ANSWER, citations: SOURCES, truncated: true });
			assert.notEqual(result.isError, true);
			behavior = "success";
		});

		await t.test("HTTP 错误脱敏；调用方取消传递到 HTTP；预先取消不发送请求", async () => {
			behavior = "error";
			const before = requests.length;
			const failed = await execute();
			assert.equal(requests.length, before + 1, "400 错误不得重试");
			assert.equal(failed.isError, true);
			assert.deepEqual(failed.structuredContent, { delegate: luna.id, answer: "", citations: [], truncated: false });
			assert.ok(!JSON.stringify(failed).includes(TEST_KEY));
			assert.ok(!JSON.stringify(failed).includes("sensitive"));
			behavior = "pending";
			const controller = new AbortController();
			const entered = new Promise<void>(resolve => { started = resolve; });
			const pending = execute(controller.signal);
			await entered;
			controller.abort();
			const cancelled = await pending;
			assert.equal(requests.at(-1)!.signal.aborted, true);
			assert.equal(cancelled.isError, true);
			assert.equal(requests.length, before + 2);
			assert.deepEqual(cancelled.structuredContent, { delegate: luna.id, answer: "", citations: [], truncated: false });
			const count = requests.length;
			await assert.rejects(() => execute(AbortSignal.abort()), { name: "AbortError" });
			assert.equal(requests.length, count);
			behavior = "success";
		});

		await t.test("选择原生搜索或非 TSGW 模型时撤下可执行工具，切回后恢复", async () => {
			const stale = searchTool();
			await host.setModel(luna);
			assert.equal(active(), false);
			assert.ok(!host.agent.state.tools.some(tool => tool.name === "tsgw_search"));
			const nativeCount = requests.length + grokRequests.length;
			await assert.rejects(() => stale.execute("stale-native", { query: "must not send" }));
			assert.equal(requests.length + grokRequests.length, nativeCount);
			await host.setModel(main);
			assert.equal(active(), true);
			const other = runtime.getModels("openai")[0];
			assert.ok(other, "真实宿主内置模型注册表中应有非 TSGW 模型");
			await runtime.setRuntimeApiKey(other.provider, "non-tsgw-runtime-fixture-key");
			const count = requests.length + grokRequests.length;
			await host.setModel(other);
			assert.equal(active(), false);
			await assert.rejects(() => stale.execute("stale-other", { query: "must not send" }));
			assert.equal(requests.length + grokRequests.length, count);
			await host.setModel(main);
			assert.equal(active(), true);
		});

		await t.test("真实 Grok Completions 代理可用，随后目录回退至 Sol 并撤下候选模型", async () => {
			sandbox.catalogIds = [main.id, "grok-4.5"];
			await host.prompt("/tsgw-refresh");
			assert.equal(sandbox.catalogCalls, 2);
			assert.deepEqual(runtime.getModels("tsgw").map(model => model.id), [main.id, "grok-4.5"]);
			const grok = runtime.getModel("tsgw", "grok-4.5");
			assert.ok(grok);
			assert.equal(grok.api, "openai-completions");
			assert.equal(host.model?.id, main.id, "委托不得切换主会话模型");
			await host.prompt("/tsgw-search cached");
			const grokResult = await execute();
			assert.equal(grokRequests.length, 1);
			assert.equal(grokRequests[0]!.body.model, grok.id);
			assert.deepEqual(grokRequests[0]!.body.search_parameters, { mode: "on" });
			assert.equal(grokRequests[0]!.body.stream, true);
			assert.deepEqual(grokResult.structuredContent, { delegate: grok.id, answer: ANSWER, citations: SOURCES, truncated: false });
			assert.ok(grokResult.content.some(part => part.type === "text" && SOURCES.every(url => part.text.includes(url))));
			assert.equal(grokResult.usage?.input, 24);
			assert.equal(grokResult.usage?.output, 9);
			assert.equal(grokResult.usage?.totalTokens, 33);
			assert.equal(host.model?.id, main.id);
			await host.prompt("/tsgw-search live");

			sandbox.catalogIds = [main.id, sol.id];
			await host.prompt("/tsgw-refresh");
			assert.equal(sandbox.catalogCalls, 3);
			assert.equal(runtime.getModel("tsgw", luna.id), undefined);
			assert.equal(runtime.getModel("tsgw", "grok-4.5"), undefined);
			assert.equal(active(), true);
			const fallback = await execute();
			assert.equal(requests.at(-1)!.body.model, sol.id);
			assert.equal((fallback.details as { delegate: string }).delegate, sol.id);
			const stale = searchTool();
			sandbox.catalogIds = [main.id];
			await host.prompt("/tsgw-refresh");
			assert.equal(sandbox.catalogCalls, 4);
			assert.equal(active(), false);
			const count = requests.length + grokRequests.length;
			await assert.rejects(() => stale.execute("stale-catalog", { query: "must not send" }));
			assert.equal(requests.length + grokRequests.length, count);
			assert.equal(host.model?.id, main.id);
		});

		await t.test("无已存储认证重载为空；显式 runtime 刷新仍遵守只保留主模型的配置", async () => {
			writeSettings([main.id]);
			await host.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			assert.deepEqual(runtime.getAllModels("tsgw"), [], "重载不能将无凭据的静态目录视为成功目录");
			assert.equal(active(), false);
			assert.equal(sandbox.catalogCalls, 4, "重载不得使用不存在的已存储凭据发起请求");
			assert.ok(!readStoredCredential("tsgw"));
			await host.prompt("/tsgw-refresh");
			assert.equal(sandbox.catalogCalls, 5);
			assert.deepEqual(runtime.getModels("tsgw").map(model => model.id), [main.id]);
			assert.equal(active(), false);
			assert.ok(host.getAllTools().some(tool => tool.name === "tsgw_search"), "已注册但有意保持未激活");
			assert.equal(sandbox.catalogCalls, 5, "恢复目录只来自显式 runtime 认证刷新");
			assert.ok(!readStoredCredential("tsgw"));
		});
		assert.deepEqual(errors, [], "不得吞掉扩展错误");
	} finally {
		try {
			session?.dispose();
			assert.deepEqual(sandbox.blocked, [], "不得尝试真实网络访问，包括已捕获错误、禁用的 MCP 或释放过程");
		} finally { sandbox.restore(); }
	}
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
