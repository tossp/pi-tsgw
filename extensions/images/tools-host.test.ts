import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "../host-test-support.test.ts";
import { REAL_IMAGE_FIXTURES } from "./image-fixtures.test.ts";
import type { ImageToolDetails } from "./tools.ts";
import { imageToolResultSchema } from "./tool-schema.ts";
import { Compile } from "typebox/compile";

// 合成的有效透明 PNG；原始字节用于检验编辑与保存，不调用付费服务。
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const BYTES = Buffer.from(PNG, "base64");
const GENERATED = "tsgw_generate_image", EDITED = "tsgw_edit_image";

function toolDetails(value: unknown): ImageToolDetails {
	assert.equal(Compile(imageToolResultSchema).Check(value), true, "宿主工具结果须符合结果schema");
	return value as ImageToolDetails;
}

function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const p = join(dir, "package.json");
		if (existsSync(p) && JSON.parse(readFileSync(p, "utf8")).name === "pi-tsgw") return join(dir, "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位包根目录");
		dir = parent;
	}
}

function toolSse(name: string, args: unknown, sequence: number): Response {
	const item = { id: `fc_image_${sequence}`, type: "function_call", call_id: `image_call_${sequence}`,
		name, arguments: JSON.stringify(args), status: "completed" };
	const events = [
		{ type: "response.created", response: { id: `resp_${sequence}`, status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: `resp_${sequence}`, status: "completed", output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

// 仅替代HTTP响应。宿主、工具schema、权限钩子、认证、调度及tool result均真实执行。
// 这不是自然语言模型选择技能/工具的验收。
test("Pi 1.2 图片工具：没有 codemode 也能生成、编辑、展示并记录用量", { timeout: 60_000 }, async t => {
	const entry = sourceEntry();
	const skill = readFileSync(join(dirname(entry), "skills/tsgw-image-generation/SKILL.md"), "utf8");
	const examples = [...skill.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!) as Record<string, unknown>);
	assert.equal(examples.length, 3, "技能应提供最简生成、草稿和蒙版编辑示例");
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	process.env.TMPDIR = sandbox.root;
	let session: AgentSession | undefined;
	try {
		const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const configure = (extra: Record<string, unknown> = {}) => writeFileSync(join(sandbox.agentDir, "settings.json"),
			JSON.stringify({ tsgw: { baseUrl: TEST_ROOT, ...extra } }));
		configure();
		writeFileSync(join(sandbox.cwd, "source.png"), BYTES);
		writeFileSync(join(sandbox.cwd, "mask.png"), BYTES);
		const guardedFetch = globalThis.fetch;
		const imageRequests: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
		let next: { name: string; args: Record<string, unknown> } | undefined;
		let sequence = 0, blockedByPolicy = false;
		let mode: "ok" | "bad-image" | "http" | "wait" = "ok";
		let entered: ((signal: AbortSignal) => void) | undefined;
		const seenTools = new Set<string>();
		globalThis.fetch = async (input, init) => {
			const req = new Request(input, init);
			const url = new URL(req.url);
			if (url.origin === TEST_ROOT && ["/v1/images/generations", "/v1/images/edits"].includes(url.pathname)) {
				assert.equal(req.method, "POST");
				assert.equal(req.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				const body = await req.json() as Record<string, unknown>;
				imageRequests.push({ path: url.pathname, body, headers: req.headers });
				assert.equal(req.headers.has("AH-Thread-Id"), false);
				if (mode === "http") return new Response("synthetic failure", { status: 503 });
				if (mode === "wait") {
					entered?.(req.signal);
					return new Promise<Response>((_resolve, reject) => {
						const abort = () => reject(req.signal.reason);
						if (req.signal.aborted) abort();
						else req.signal.addEventListener("abort", abort, { once: true });
					});
				}
				const count = Number(body.n ?? 1);
				const format = body.output_format ?? "png";
				const data = format === "png" ? PNG : REAL_IMAGE_FIXTURES.find(fixture => fixture.format === format)!.data;
				const size = format === "png" ? "1x1" : "3x2";
				const usage = { input_tokens: 3, output_tokens: 4 * count, total_tokens: 3 + 4 * count };
				if (body.stream === true) {
					const prefix = url.pathname.endsWith("/edits") ? "image_edit" : "image_generation";
					const events = [
						{ type: `${prefix}.partial_image`, b64_json: data, partial_image_index: 0, output_format: format, size },
						...Array.from({ length: count }, () => ({ type: `${prefix}.completed`, b64_json: data, usage, output_format: format, size })),
					];
					return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
						headers: { "content-type": "text/event-stream" },
					});
				}
				return Response.json({ data: Array.from({ length: count }, () => ({ b64_json: mode === "bad-image" ? "invalid" : data })),
					usage, output_format: format, size });
			}
			if (req.url === `${TEST_ROOT}/v1/responses` && next) {
				const body = await req.json() as { tools: { name?: string }[] };
				for (const tool of body.tools ?? []) if (tool.name) seenTools.add(tool.name);
				assert.ok(body.tools.some(tool => tool.name === next!.name));
				assert.ok(!body.tools.some(tool => tool.name === "codemode"));
				const call = next;
				next = undefined;
				return toolSse(call.name, call.args, ++sequence);
			}
			return guardedFetch(req);
		};
		const errors: ExtensionError[] = [];
		const settings = SettingsManager.inMemory({ packages: [], extensions: [],
			compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse" });
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "执行合成工具fixture。",
			extensionFactories: [pi => {
				pi.on("session_start", () => assert.deepEqual(pi.getMcpServers(), []));
				pi.on("tool_call", event => {
					if (blockedByPolicy && [GENERATED, EDITED].includes(event.toolName)) return { block: true, reason: "fixture policy block" };
				});
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false });
		({ session } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
			resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd), thinkingLevel: "off" }));
		await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
		await runtime.setRuntimeApiKey("tsgw", TEST_KEY);
		const chat = runtime.getModel("tsgw", "gpt-6.1-sol");
		assert.ok(chat);
		await session.setModel(chat);
		const active = session;
		const invoke = async (name: string, args: Record<string, unknown>) => {
			const before = active.messages.filter(message => message.role === "toolResult").length;
			next = { name, args };
			await active.prompt("执行当前合成图片工具调用。");
			assert.equal(next, undefined, JSON.stringify({ tools: [...seenTools],
				last: active.messages.filter(message => message.role === "assistant").at(-1), errors, blocked: sandbox.blocked }));
			const results = active.messages.filter(message => message.role === "toolResult");
			assert.equal(results.length, before + 1);
			return results.at(-1)!;
		};

		await t.test("技能最简生成与草稿示例实际执行；默认Sunburst并直接附图", async () => {
			for (const [i, args] of examples.slice(0, 2).entries()) {
				const before = imageRequests.length;
				const result = await invoke(GENERATED, args);
				assert.equal(result.isError, false, JSON.stringify(result.content));
				assert.equal(imageRequests.length, before + 1);
				const request = imageRequests.at(-1)!;
				assert.equal(request.path, "/v1/images/generations");
				assert.equal(request.body.model, i === 0 ? "gpt-image-2.5-sunburst" : "gpt-image-2.5-flare");
				assert.equal(request.body.quality, i === 0 ? "auto" : "low");
				assert.equal(result.content.filter(block => block.type === "image").length, 1);
				assert.equal(result.usage?.totalTokens, 7);
			}
			assert.ok(seenTools.has(GENERATED) && seenTools.has(EDITED));
			assert.equal(seenTools.has("codemode"), false);
		});

		await t.test("技能蒙版编辑示例读取原文件，保留参考图顺序与alpha原字节", async () => {
			const args = { ...examples[2]!, images: [{ path: "source.png" }, { path: "source.png" }] };
			const result = await invoke(EDITED, args);
			assert.equal(result.isError, false, JSON.stringify(result.content));
			const request = imageRequests.at(-1)!;
			assert.equal(request.path, "/v1/images/edits");
			assert.deepEqual(request.body.images, [{ image_url: `data:image/png;base64,${PNG}` }, { image_url: `data:image/png;base64,${PNG}` }]);
			assert.deepEqual(request.body.mask, { image_url: `data:image/png;base64,${PNG}` });
			assert.deepEqual(readFileSync(join(sandbox.cwd, "source.png")), BYTES);
			assert.deepEqual(readFileSync(join(sandbox.cwd, "mask.png")), BYTES);
			assert.equal(result.content.filter(block => block.type === "image").length, 1);
			assert.equal(result.usage?.totalTokens, 7);
		});

		await t.test("可选参数到达HTTP，批量最终图片进入结果且usage只计一次", async () => {
			const result = await invoke(GENERATED, { prompt: "fixture", quality: "xhigh", size: "1536x1024", background: "transparent",
				n: 2, output_format: "png", moderation: "low", safety_identifier: "anonymous-fixture", user: "old-fixture" });
			assert.equal(result.isError, false, JSON.stringify(result.content));
			const body = imageRequests.at(-1)!.body;
			for (const [key, expected] of Object.entries({ quality: "xhigh", size: "1536x1024", background: "transparent", n: 2,
				output_format: "png", moderation: "low", safety_identifier: "anonymous-fixture", user: "old-fixture" })) assert.equal(body[key], expected);
			assert.equal(result.content.filter(block => block.type === "image").length, 2);
			assert.equal(result.usage?.input, 3);
			assert.equal(result.usage?.output, 8);
			assert.equal(result.usage?.totalTokens, 11);
		});

		await t.test("编辑URL/file_id直接交上游，不在本机额外下载图片", async () => {
			const sources = [{ image_url: "https://images.example/source.png" }, { file_id: "file-fixture" }];
			const mask = { file_id: "file-mask-fixture" };
			const result = await invoke(EDITED, { prompt: "fixture edit", images: sources, mask });
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.deepEqual(imageRequests.at(-1)!.body.images, sources);
			assert.deepEqual(imageRequests.at(-1)!.body.mask, mask);
			assert.deepEqual(sandbox.blocked, []);
		});

		await t.test("两个端点的流式响应返回最终图，过程图不冒充额外生成数量", async () => {
			for (const name of [GENERATED, EDITED]) {
				const result = await invoke(name, { prompt: "fixture stream", stream: true, partial_images: 1,
					...(name === EDITED ? { images: [{ path: "source.png" }] } : {}) });
				assert.equal(result.isError, false, JSON.stringify(result.content));
				assert.equal(result.content.filter(block => block.type === "image").length, 1);
				assert.equal(result.usage?.totalTokens, 7);
			}
		});

		await t.test("JPEG/WebP真实编码夹具经宿主附图，保存文件保留上游原字节", async () => {
			for (const format of ["jpeg", "webp"] as const) {
				const result = await invoke(GENERATED, { prompt: "fixture format", output_format: format, output_compression: 75 });
				assert.equal(result.isError, false, JSON.stringify(result.content));
				assert.equal(result.content.filter(block => block.type === "image").length, 1);
				const info = toolDetails(result.details);
				const fixture = REAL_IMAGE_FIXTURES.find(image => image.format === format)!;
				assert.equal(info.files.length, 1);
				assert.equal(info.files[0].mimeType, `image/${format}`);
				assert.deepEqual(readFileSync(info.files[0].path), Buffer.from(fixture.data, "base64"));
				assert.equal(imageRequests.at(-1)!.body.output_compression, 75);
			}
		});

		await t.test("多图SSE允许相同完成图片，用量保留逐事件报告而不伪造总量", async () => {
			const result = await invoke(GENERATED, { prompt: "fixture multi stream", n: 2, stream: true, partial_images: 1 });
			assert.equal(result.isError, false, JSON.stringify(result.content));
			assert.equal(result.content.filter(block => block.type === "image").length, 2);
			assert.equal(result.usage, undefined);
			const info = toolDetails(result.details);
			assert.match(info.usage_note ?? "", /未.*会话总量/);
			assert.equal(info.usage_reports?.length, 2);
			assert.deepEqual(info.usage_reports?.map(report => report.totalTokens), [11, 11]);
			assert.equal(info.files.length, 2);
		});

		await t.test("schema错误与宿主权限阻止不发图片请求", async () => {
			let before = imageRequests.length;
			const invalid = await invoke(GENERATED, { prompt: "fixture", n: 11 });
			assert.equal(invalid.isError, true);
			assert.equal(imageRequests.length, before);
			blockedByPolicy = true;
			const blocked = await invoke(EDITED, { prompt: "fixture", images: [{ path: "does-not-exist.png" }] });
			assert.equal(blocked.isError, true);
			assert.match(JSON.stringify(blocked.content), /fixture policy block/);
			assert.equal(imageRequests.length, before);
			blockedByPolicy = false;
		});

		await t.test("坏图保留有效usage，HTTP失败不重试，过滤模型不能被工具恢复", async () => {
			mode = "bad-image";
			const bad = await invoke(GENERATED, { prompt: "fixture bad image" });
			assert.equal(bad.isError, true);
			assert.equal(bad.usage?.totalTokens, 7);
			assert.equal(bad.content.filter(block => block.type === "image").length, 0);
			mode = "http";
			const before = imageRequests.length;
			const http = await invoke(GENERATED, { prompt: "fixture http" });
			assert.equal(http.isError, true);
			assert.equal(imageRequests.length, before + 1);
			mode = "ok";
			configure({ excludeModels: ["gpt-image-2.5-sunburst"] });
			await active.reload();
			const filtered = await invoke(GENERATED, { prompt: "fixture unavailable" });
			assert.equal(filtered.isError, true);
			assert.equal(imageRequests.length, before + 1);
			configure();
			await active.reload();
		});

		await t.test("宿主取消传播到图片HTTP，返回后不继续请求", async () => {
			mode = "wait";
			const before = imageRequests.length;
			const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
			const pending = invoke(GENERATED, { prompt: "fixture cancel" });
			const signal = await started;
			await active.abort();
			await pending;
			assert.equal(signal.aborted, true);
			assert.equal(imageRequests.length, before + 1);
		});
		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
