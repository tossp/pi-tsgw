import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { HostSandbox, TEST_KEY, TEST_ROOT, type CapturedRequest } from "../host-test-support.test.ts";
import { IMAGE_API, IMAGE_MODEL_IDS } from "./models.ts";
import { modelsForRoot, PROVIDER_ID } from "../models/catalog.ts";

// 已知有效的 1×1 灰度透明 PNG；CRC、像素与完整原始字节都可独立断言。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const BYTES = Buffer.from(PNG, "base64");
const PROMPT = "isolated synthetic pixel, not a paid generation";
const EXISTING_TOOLS = ["codemode", "tsgw_search", "upload_local_file"];
const context = { input: [{ type: "text" as const, text: PROMPT }] };

/** 无论运行源码还是 dist，始终交给真实 DefaultResourceLoader/jiti 加载源码入口。 */
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

function assertPng(block: ImageContent): void {
	assert.equal(block.mimeType, "image/png");
	assert.deepEqual(Buffer.from(block.data, "base64"), BYTES, "不得损坏或替换原始图片字节");
	assert.deepEqual([...BYTES.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
	assert.equal(BYTES.readUInt32BE(16), 1);
	assert.equal(BYTES.readUInt32BE(20), 1);
	assert.deepEqual(inflateSync(BYTES.subarray(41, 52)), Buffer.from([1, 0, 255]));
}

/** 只替代 HTTP 边界，工具声明、SSE 解析、调度和 codemode 均由 SDK 真正执行。 */
function codemodeSse(code: string, custom: boolean): Response {
	const item = custom
		? { id: "ctc_images", type: "custom_tool_call", call_id: "call_images", name: "codemode", input: code, status: "completed" }
		: { id: "fc_images", type: "function_call", call_id: "call_images", name: "codemode", arguments: JSON.stringify({ code }), status: "completed" };
	const events = [
		{ type: "response.created", response: { id: "resp_images", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: custom ? { ...item, input: "" } : { ...item, arguments: "" } },
		custom
			? { type: "response.custom_tool_call_input.delta", output_index: 0, delta: code }
			: { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify({ code }) },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_images", status: "completed", output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

// 必须独立 Node 进程运行：HostSandbox 有意修改进程环境、cwd 和套接字入口。
// SDK 只能在沙箱构造后动态导入；不加载个人配置、MCP 扩展或真实凭据。
test("Pi 1.2 原生图片：真实 SDK 宿主、codemode、目录和取消", { timeout: 60_000 }, async (t) => {
	const entry = sourceEntry();
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	// codemode 的 image() 会保存临时 PNG，也纳入沙箱目录与 finally 清理。
	process.env.TMPDIR = sandbox.root;
	let session: AgentSession | undefined;
	try {
		const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } =
			await import("@earendil-works/pi-coding-agent");
		assert.match(VERSION, /^1\.2\./, "此集成回归的已验证基线是 Pi 1.2 SDK");
		const configure = (extra: Record<string, unknown> = {}) => writeFileSync(join(sandbox.agentDir, "settings.json"),
			JSON.stringify({ tsgw: { baseUrl: TEST_ROOT, traceHeaders: true, ...extra } }));
		configure();
		const guardedFetch = globalThis.fetch;
		const imageRequests: CapturedRequest[] = [];
		let mode: "ok" | "network" | "http" | "wait" = "ok";
		let entered: ((signal: AbortSignal) => void) | undefined;
		let script: string | undefined;
		let scriptRequest: CapturedRequest | undefined;
		const fixtureFetch: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${TEST_ROOT}/v1/images/generations`) {
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				imageRequests.push({ body: await request.json() as Record<string, unknown>, headers: request.headers });
				if (mode === "network") throw new TypeError("synthetic network failure");
				if (mode === "http") return new Response("synthetic retryable error", { status: 503 });
				if (mode === "wait") {
					entered?.(request.signal);
					return new Promise<Response>((_resolve, reject) => {
						const abort = () => reject(request.signal.reason);
						if (request.signal.aborted) abort();
						else request.signal.addEventListener("abort", abort, { once: true });
					});
				}
				return Response.json({ data: [{ b64_json: PNG }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } },
					{ headers: { "x-images-fixture": "yes" } });
			}
			if (request.url === `${TEST_ROOT}/v1/responses` && script !== undefined) {
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				scriptRequest = { body: await request.json() as Record<string, unknown>, headers: request.headers };
				const tools = scriptRequest.body.tools as { name?: string; type?: string }[];
				const tool = tools.find(tool => tool.name === "codemode");
				assert.ok(tool, "没有 MCP 扩展也必须声明 codemode");
				const code = script;
				script = undefined;
				return codemodeSse(code, tool.type === "custom");
			}
			// /models、普通 /responses 以及所有意外 HTTP 继续受原沙箱约束。
			return guardedFetch(request);
		};
		globalThis.fetch = fixtureFetch;
		const errors: ExtensionError[] = [];
		const settings = SettingsManager.inMemory({ packages: [], extensions: [],
			compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
			cacheWarming: "off", transport: "sse" });
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "隔离图片宿主测试，只调用合成 fixture。",
			extensionFactories: [createCodemodeExtension(), pi => {
				pi.on("session_start", () => assert.deepEqual(pi.getMcpServers(), [], "不注册或加载 MCP"));
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.ok(loader.getExtensions().extensions.some(extension => extension.path === entry));
		const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false });
		assert.deepEqual(await runtime.listCredentials(), []);
		({ session } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
			modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(sandbox.cwd), tools: ["codemode"], thinkingLevel: "off" }));
		await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		const activeSession = session;
		const images = () => runtime.getModelsOfType("image", PROVIDER_ID);
		const image = (id: string) => {
			const model = runtime.getModelOfType("image", PROVIDER_ID, id);
			assert.ok(model, `缺少图片模型 ${id}`);
			return model;
		};
		const tools = () => activeSession.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name).sort();

		await t.test("混合注册保持 36 chat + 2 image，聊天选择目录不含 image；图片不注册新工具", async () => {
			assert.equal(modelsForRoot(TEST_ROOT).length, 36);
			assert.deepEqual(runtime.getModels(PROVIDER_ID).map(model => model.id).sort(), modelsForRoot(TEST_ROOT).map(model => model.id).sort());
			assert.equal(runtime.getAllModels(PROVIDER_ID).length, 38);
			assert.equal(runtime.getModelsOfType("chat", PROVIDER_ID).length, 36);
			assert.deepEqual(images().map(model => model.id), [...IMAGE_MODEL_IDS]);
			for (const id of IMAGE_MODEL_IDS) {
				assert.equal(runtime.getModel(PROVIDER_ID, id), undefined);
				assert.equal(image(id).api, IMAGE_API);
				assert.deepEqual(image(id).input, ["text"]);
			}
			assert.deepEqual(tools(), EXISTING_TOOLS, "只允许既有搜索/上传工具与显式宿主 codemode");
			assert.deepEqual([...loader.getExtensions().extensions.find(extension => extension.path === entry)!.tools.keys()].sort(),
				["tsgw_search", "upload_local_file"]);
		});

		await t.test("无认证图片不可用，失败不发 HTTP；同一个 runtime key 解锁 chat 和 image", async () => {
			assert.deepEqual(await runtime.getAvailableOfType("image", PROVIDER_ID), []);
			for (const id of IMAGE_MODEL_IDS) {
				const result = await runtime.generateImages(image(id), context);
				assert.equal(result.stopReason, "error");
				assert.ok(result.errorMessage);
				assert.deepEqual(result.output, []);
			}
			assert.equal(imageRequests.length + sandbox.requests.length + sandbox.catalogCalls, 0);
			await runtime.setRuntimeApiKey(PROVIDER_ID, TEST_KEY);
			assert.deepEqual(runtime.getProviderAuthStatus(PROVIDER_ID), { configured: true, source: "runtime" });
			assert.equal((await runtime.getAvailableOfType("chat", PROVIDER_ID)).length, 36);
			assert.deepEqual((await runtime.getAvailableOfType("image", PROVIDER_ID)).map(model => model.id), [...IMAGE_MODEL_IDS]);
			assert.ok((await runtime.getAvailable(PROVIDER_ID)).every(model => !IMAGE_MODEL_IDS.includes(model.id as typeof IMAGE_MODEL_IDS[number])));
			const chat = runtime.getModel(PROVIDER_ID, "gpt-6.1-sol");
			assert.ok(chat);
			await activeSession.setModel(chat);
			await activeSession.prompt("验证相同的虚拟 runtime key 可用于聊天。");
			assert.equal(activeSession.getLastAssistantText(), "fixture reply");
			assert.equal(sandbox.requests.length, 1);
			assert.ok(sandbox.requests[0].headers.has("AH-Thread-Id"), "聊天追踪仍然生效");
		});

		await t.test("两个模型单次 PNG n=1；宿主凭据、headers、payload/response hook 与 raw bytes", async () => {
			for (const id of IMAGE_MODEL_IDS) {
				const before = imageRequests.length;
				let payloadCalls = 0, responseCalls = 0, headerCalls = 0, injectedCalls = 0;
				const result = await runtime.generateImages(image(id), context, {
					fetch: (input, init) => { injectedCalls++; return fixtureFetch(input, init); },
					headers: { "X-Host-Fixture": id },
					transformHeaders: async headers => { headerCalls++; return { ...headers, "X-Host-Transform": "yes" }; },
					onPayload: async (payload, model) => {
						payloadCalls++;
						assert.equal(model.id, id);
						return { ...payload as Record<string, unknown>, prompt: `${PROMPT} [hook]` };
					},
					onResponse: async (response, model) => {
						responseCalls++;
						assert.equal(model.id, id);
						assert.equal(response.status, 200);
						assert.equal(response.headers["x-images-fixture"], "yes");
					},
				});
				assert.equal(result.stopReason, "stop", result.errorMessage ?? "图片生成应成功");
				assert.equal(result.provider, PROVIDER_ID);
				assert.equal(result.model, id);
				assert.equal(result.api, IMAGE_API);
				assert.equal(result.output.length, 1);
				const block = result.output[0]!;
				assert.equal(block.type, "image");
				if (block.type === "image") assertPng(block);
				assert.deepEqual([payloadCalls, responseCalls, headerCalls, injectedCalls], [1, 1, 1, 1]);
				assert.equal(imageRequests.length, before + 1);
				const request = imageRequests.at(-1)!;
				assert.equal(request.body.model, id);
				assert.equal(request.body.prompt, `${PROMPT} [hook]`);
				assert.equal(request.body.n, 1);
				assert.equal(request.body.output_format, "png");
				assert.equal(request.headers.get("x-host-fixture"), id);
				assert.equal(request.headers.get("x-host-transform"), "yes");
				assert.deepEqual(Object.keys(request.body).sort(), ["model", "n", "output_format", "prompt", "quality", "size"],
					"图片请求不继承聊天历史、工具或思考参数");
				assert.equal(request.headers.has("AH-Thread-Id"), false, "原生图片不借用主聊天的追踪头");
				assert.equal(request.headers.has("AH-Trace-Id"), false);
				assert.equal(result.usage?.input, 3);
				assert.equal(result.usage?.output, 4);
				assert.equal(result.usage?.totalTokens, 7);
			}
		});

		await t.test("无 MCP：真实 codemode getModelOfType/generateImages/image() 将两张图片写入父工具结果", async () => {
			script = `const available = await models.getAvailableOfType("image", "tsgw");
if (available.length !== 2) throw new Error("expected two authenticated images");
for (const id of ${JSON.stringify(IMAGE_MODEL_IDS)}) {
  const model = await models.getModelOfType("image", "tsgw", id);
  const result = await models.generateImages(model, ${JSON.stringify(context)});
  if (result.stopReason !== "stop") throw new Error(result.errorMessage);
  for (const block of result.output) if (block.type === "image") image(block);
}
text("native-images-completed");`;
			const before = imageRequests.length;
			await activeSession.prompt("执行隔离 codemode 图片测试，并展示两个模型的合成像素。");
			assert.ok(scriptRequest);
			assert.equal(script, undefined, "SSE 必须已由真实聊天适配器消费");
			assert.equal(imageRequests.length, before + 2, "每个模型恰好一次 HTTP");
			const results = activeSession.messages.filter(message => message.role === "toolResult");
			assert.equal(results.length, 1, "不新增图片工具或嵌套 transcript 工具结果");
			const parent = results[0]!;
			assert.equal(parent.toolName, "codemode");
			assert.equal(parent.isError, false, JSON.stringify(parent.content));
			assert.equal(parent.usage?.input, 6, "两次原生图片请求的真实用量进入父工具结果");
			assert.equal(parent.usage?.output, 8);
			assert.equal(parent.usage?.totalTokens, 14);
			const blocks = parent.content.filter(block => block.type === "image");
			assert.equal(blocks.length, 2, "不是只检查 adapter 返回值：父工具 result 必须含真实 image block");
			for (const block of blocks) assertPng(block);
			assert.match(JSON.stringify(parent.content.filter(block => block.type === "text")), /native-images-completed/);
			assert.equal(activeSession.getLastAssistantText(), "fixture reply");
			assert.deepEqual(tools(), EXISTING_TOOLS);
		});

		await t.test("预取消不发 HTTP；进行中取消、网络错误及 503 都不自动重试", async () => {
			const model = image(IMAGE_MODEL_IDS[0]);
			let before = imageRequests.length;
			const cancelled = new AbortController();
			cancelled.abort();
			assert.equal((await runtime.generateImages(model, context, { signal: cancelled.signal })).stopReason, "aborted");
			assert.equal(imageRequests.length, before);
			const controller = new AbortController();
			mode = "wait";
			const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
			const pending = runtime.generateImages(model, context, { signal: controller.signal });
			const forwarded = await started;
			assert.equal(forwarded.aborted, false);
			controller.abort();
			assert.equal((await pending).stopReason, "aborted");
			assert.equal(forwarded.aborted, true, "宿主取消必须传播到 HTTP signal");
			assert.equal(imageRequests.length, before + 1);
			for (const failure of ["network", "http"] as const) {
				mode = failure;
				before = imageRequests.length;
				const result = await runtime.generateImages(model, context);
				assert.equal(result.stopReason, "error");
				assert.deepEqual(result.output, []);
				assert.ok(result.errorMessage);
				assert.equal(imageRequests.length, before + 1, `${failure} 不得自动重复付费生成`);
			}
			mode = "ok";
		});

		await t.test("include 图片通配覆盖 exclude gpt-*，不恢复其它 image 别名，reload 保持过滤", async () => {
			configure({ excludeModels: ["gpt-*"], includeModels: ["gpt-image-2.5*"] });
			await activeSession.reload();
			assert.deepEqual(images().map(model => model.id), [...IMAGE_MODEL_IDS]);
			assert.ok(runtime.getModels(PROVIDER_ID).every(model => !model.id.startsWith("gpt-")));
			for (const alias of ["gpt-image-1", "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5", "dall-e-3"])
				assert.equal(runtime.getModelOfType("image", PROVIDER_ID, alias), undefined);
			configure({ excludeModels: ["gpt-*"], includeModels: [IMAGE_MODEL_IDS[0]] });
			await activeSession.reload();
			assert.deepEqual(images().map(model => model.id), [IMAGE_MODEL_IDS[0]], "不自动拉回另一个图片别名");
		});

		await t.test("gateway refresh 只保留静态交集，失败保留目录，reload 不丢生效 image", async () => {
			configure({ excludeModels: ["gpt-*"], includeModels: ["gpt-image-2.5*"] });
			await activeSession.reload();
			const chatId = modelsForRoot(TEST_ROOT).find(model => !model.id.startsWith("gpt-"))!.id;
			sandbox.catalogIds = [chatId, IMAGE_MODEL_IDS[0], "gpt-image-unknown", "unknown-chat"];
			await activeSession.prompt("/tsgw-refresh");
			assert.equal(sandbox.catalogCalls, 1);
			const expected = [chatId, IMAGE_MODEL_IDS[0]].sort();
			assert.deepEqual(runtime.getAllModels(PROVIDER_ID).map(model => model.id).sort(), expected);
			assert.deepEqual(images().map(model => model.id), [IMAGE_MODEL_IDS[0]], "include 不突破网关交集恢复 sunburst");
			sandbox.catalogFails = true;
			await activeSession.prompt("/tsgw-refresh");
			assert.equal(sandbox.catalogCalls, 2);
			assert.deepEqual(runtime.getAllModels(PROVIDER_ID).map(model => model.id).sort(), expected);
			sandbox.catalogFails = false;
			await activeSession.reload();
			assert.ok(image(IMAGE_MODEL_IDS[0]), "重载后生效图片模型及其实现必须仍可调度");
			const result = await runtime.generateImages(image(IMAGE_MODEL_IDS[0]), context);
			assert.equal(result.stopReason, "stop", result.errorMessage ?? "重载后图片应仍可生成");
			assert.deepEqual(tools(), EXISTING_TOOLS);
		});
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(errors, [], "真实运行器不得吞掉扩展异常");
		assert.deepEqual(sandbox.blocked, [], "禁止真实 socket、生产网关或计划外 HTTP");
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
