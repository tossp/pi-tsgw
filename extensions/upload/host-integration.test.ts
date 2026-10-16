import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession, ExtensionError, ToolCallEvent, ToolResultEvent, ToolAnnotations } from "@earendil-works/pi-coding-agent";
import type { CallToolResult, JsonRpcMessage } from "@earendil-works/pi-mcp";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "../host-test-support.test.ts";

const OUTER = "upload_local_file";
const UPLOAD = "mcp__ts_oht__upload_file";
const LINK = "mcp__ts_oht__get_file_url";
const CONTENT = "isolated upload fixture\n";
const SECRET = "synthetic-remote-secret-must-not-reach-model";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const KEY = "fixture/report.txt";
const DOWNLOAD = "https://upload-fixture.invalid/report.txt?fixture=download";
const PUT = "https://upload-fixture.invalid/report.txt?fixture=put";
const annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

interface Scenario {
	name: string;
	custom?: boolean;
	missing?: boolean;
	block?: string;
	redact?: string;
	remoteError?: string;
	args?: Record<string, unknown>;
	seconds?: number;
	invalidInput?: boolean;
}

/** 真实的 Responses 事件：必须由真实适配器解析并分派工具调用。 */
function responseSse(call: boolean, args: Record<string, unknown>): Response {
	const item = call
		? { id: "fc_fixture", type: "function_call", call_id: "call_upload", name: OUTER,
			arguments: JSON.stringify(args), status: "completed" }
		: { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
			content: [{ type: "output_text", text: "Upload fixture finished.", annotations: [] }] };
	const events = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0,
			item: call ? { ...item, arguments: "" } : { ...item, content: [] } },
		call
			? { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args) }
			: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Upload fixture finished." },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

function success(data: Record<string, unknown>): CallToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, isError: false };
}

// 与根 index.test.ts 一样在独立进程中运行：沙箱会更改
// 进程级全局状态。仅模拟模型 HTTP 和字节 PUT 边界；
// Pi 会话、嵌套调用流水线、MCP 包装器及客户端和 JSON-RPC 均为真实实现。
test("Pi SDK 上传：真实 MCP 嵌套执行、权限、校验及脱敏", { timeout: 60_000 }, async (t) => {
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	try {
		// 仅在环境配置和套接字隔离后，才导入 SDK 和生产代码。
		const { createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const { createInMemoryTransportPair } = await import("@earendil-works/pi-mcp/testing");
		const { registerUploadTool } = await import("./index.ts");
		writeFileSync(join(sandbox.cwd, "report.txt"), CONTENT);
		const guardedFetch = globalThis.fetch;
		const scenarios: Scenario[] = [
			{ name: "默认 inline 在一次 PUT 后使用计划中的链接" },
			{ name: "自定义 attachment 按 upload_file → PUT → get_file_url 顺序执行", custom: true },
			{ name: "外层权限拒绝阻止所有远程操作和字节操作", block: OUTER },
			{ name: "嵌套准备调用被拒绝时阻止 PUT", block: UPLOAD },
			{ name: "嵌套链接调用被拒绝时保留已上传状态", custom: true, block: LINK },
			{ name: "准备结果脱敏移除结构化 MCP 结果并安全拒绝继续", redact: UPLOAD },
			{ name: "链接结果脱敏移除结构化 MCP 结果并安全拒绝继续", custom: true, redact: LINK },
			{ name: "原始 MCP 结构化准备错误转换为安全业务错误", remoteError: UPLOAD },
			{ name: "原始 MCP 结构化链接错误保留已上传状态", custom: true, remoteError: LINK },
			{ name: "缺少 MCP 时返回安全错误而不创建连接", missing: true },
			{ name: "主机在执行上传前将小数有效期转换为 1", custom: true, args: { expiresIn: 1.5 }, seconds: 1 },
			{ name: "主机在执行上传前转换字符串有效期", custom: true, args: { expiresIn: "3600" } },
			{ name: "主机移除可选 null 并使用默认链接", args: { expiresIn: null, resume: null, contentType: null } },
			{ name: "主机在任何上传操作前拒绝无效 MIME", args: { contentType: "text/plain; charset=utf-8" }, invalidInput: true },
			{ name: "主机在任何上传操作前拒绝凭条中的无效字符", args: { resume: "bad/receipt=" }, invalidInput: true },
		];
		for (const scenario of scenarios) await t.test(scenario.name, async () => {
			const pair = createInMemoryTransportPair();
			const errors: ExtensionError[] = [];
			const transportErrors: unknown[] = [];
			const calls: ToolCallEvent[] = [];
			const results: ToolResultEvent[] = [];
			const redactedResults: ToolResultEvent[] = [];
			const hints = new Map<string, ToolAnnotations | undefined>();
			const chain: string[] = [];
			const remote: { name: string; args: Record<string, unknown> }[] = [];
			const modelRequests: Record<string, unknown>[] = [];
			let transportCreations = 0;
			let putCount = 0;
			let session: AgentSession | undefined;
			const seconds = scenario.seconds ?? 3600;
			const args = { path: "report.txt", ...(scenario.custom ? { expiresIn: seconds, disposition: "attachment" } : {}), ...scenario.args };
			const plan = { key: KEY, url: DOWNLOAD, expiresAt: EXPIRES, expiresIn: 86400,
				mode: "single", uploaded: false, uploads: [{ partNumber: 1, offset: 0, size: Buffer.byteLength(CONTENT),
					url: PUT, method: "PUT", headers: {}, expiresAt: EXPIRES }] };
			const link = { key: KEY, url: `${DOWNLOAD}&attachment=true`, expiresAt: EXPIRES, expiresIn: seconds };
			const serve = async (message: JsonRpcMessage) => {
				if (!("method" in message) || !("id" in message)) return;
				let result: unknown;
				if (message.method === "initialize") {
					result = { protocolVersion: "2025-11-25", capabilities: { tools: {} },
						serverInfo: { name: "isolated-ts-oht-fixture", version: "1.0.0" } };
				} else if (message.method === "tools/list") {
					result = { tools: ["upload_file", "get_file_url"].map(name => ({ name,
						inputSchema: { type: "object", properties: {}, additionalProperties: true },
						outputSchema: { type: "object", additionalProperties: true }, annotations })) };
				} else if (message.method === "tools/call") {
					const params = message.params as { name: string; arguments: Record<string, unknown> };
					assert.ok(["upload_file", "get_file_url"].includes(params.name));
					remote.push({ name: params.name, args: params.arguments });
					chain.push(params.name);
					result = scenario.remoteError === `mcp__ts_oht__${params.name}`
						? { content: [{ type: "text", text: "Remote fixture rejected the request" }], isError: true,
							structuredContent: { error: { code: "denied", message: SECRET } } }
						: success(params.name === "upload_file" ? plan : link);
				} else throw new Error(`意外的 MCP 方法：${message.method}`);
				await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
			};
			pair.server.onMessage(message => { void serve(message).catch(error => transportErrors.push(error)); });
			await pair.server.start();
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				// 所有非模型请求仍经过 HostSandbox 的拒绝及记录防护。
				if (request.url !== `${TEST_ROOT}/v1/responses`) return guardedFetch(request);
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				modelRequests.push(await request.json() as Record<string, unknown>);
				assert.ok(modelRequests.length <= 2, "不得出现计划外的模型重试或工具循环");
				return responseSse(modelRequests.length === 1, args);
			};
			try {
				const settings = SettingsManager.inMemory({ packages: [], extensions: [],
					compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
					cacheWarming: "off", transport: "sse" });
				const loader = new DefaultResourceLoader({
					cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
					noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
					systemPrompt: "仅执行明确请求的隔离测试上传。",
					extensionFactories: [
						createMcpExtension({
							loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: scenario.missing ? [] : [{
								name: "ts_oht", source: "in-memory-fixture", scope: "extension",
								config: { url: "https://mcp-fixture.invalid/mcp", exposure: "direct" },
							}] }),
							createTransport: (entry, cwd) => {
								assert.equal(entry.name, "ts_oht");
								assert.equal(cwd, sandbox.cwd);
								transportCreations++;
								return pair.client;
							},
						}),
						pi => {
							pi.registerProvider("upload-fixture", { baseUrl: `${TEST_ROOT}/v1`, api: "openai-responses", apiKey: TEST_KEY,
								models: [{ id: "fixture-model", name: "Fixture model", input: ["text"], reasoning: false,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
							registerUploadTool(pi, { put: async (target, body, signal) => {
								assert.equal(signal.aborted, false);
								assert.equal(target.url, PUT);
								assert.ok(body instanceof Uint8Array, "单次上传必须使用固定快照");
								assert.equal(Buffer.from(body).toString(), CONTENT);
								putCount++;
								chain.push("PUT");
							} });
							pi.on("tool_call", event => {
								calls.push(event);
								hints.set(event.toolName, pi.getAllTools().find(tool => tool.name === event.toolName)?.annotations);
								if (event.toolName === scenario.block) return { block: true, reason: "测试权限被拒绝" };
							});
							pi.on("tool_result", event => {
								results.push({ ...event });
								// 主机移除结构化包装后，即使文本为有效 JSON，也不得从中恢复结果。
								// 仅返回 content 会触发 Pi 的脱敏规则。
								if (event.toolName === scenario.redact) return { content: event.content };
							});
							pi.on("tool_result", event => {
								if (event.toolName === scenario.redact) redactedResults.push({ ...event });
							});
						},
					],
				});
				await loader.reload();
				assert.deepEqual(loader.getExtensions().errors, []);
				const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"),
					modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
					allowModelNetwork: false, refreshOnCreate: false });
				assert.deepEqual(await runtime.listCredentials(), []);
				({ session } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
					modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
					sessionManager: SessionManager.inMemory(sandbox.cwd), tools: [OUTER, UPLOAD, LINK], thinkingLevel: "off" }));
				const model = runtime.getModel("upload-fixture", "fixture-model");
				assert.ok(model);
				await session.setModel(model);
				await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
				await session.prompt("我授权使用测试选项上传 report.txt。");
				assert.equal(session.getLastAssistantText(), "Upload fixture finished.");
				assert.equal(modelRequests.length, 2);
				assert.ok((modelRequests[0]!.tools as { name?: string }[]).some(tool => tool.name === OUTER));
				if (scenario.invalidInput) {
					const output = session.messages.find(message => message.role === "toolResult");
					assert.equal(output?.role, "toolResult");
					assert.equal(output.isError, true);
					assert.match(JSON.stringify(output.content), /Validation failed/);
					assert.equal(putCount, 0);
					assert.deepEqual(remote, []);
					assert.deepEqual(chain, []);
					assert.deepEqual(errors, []);
					assert.deepEqual(sandbox.blocked, []);
					return;
				}
				assert.deepEqual(hints.get(OUTER), annotations, "权限处理器可观察公开的上传注解");
				assert.equal(transportCreations, scenario.missing ? 0 : 1);
				if (scenario.redact) {
					assert.equal(redactedResults.length, 1);
					assert.equal(redactedResults[0]!.structuredContent, undefined, "真实主机脱敏会移除结构化输出");
					assert.ok(redactedResults[0]!.content.some(block => block.type === "text"), "文本不能绕过脱敏");
				}
				const outerCall = calls.find(call => call.toolName === OUTER)!;
				assert.ok(outerCall);
				assert.equal(outerCall.parentToolCallId, undefined);
				for (const nested of calls.filter(call => call.toolName !== OUTER)) {
					assert.equal(nested.parentToolCallId, outerCall.toolCallId);
					assert.ok(nested.toolCallId.startsWith(`${outerCall.toolCallId}/`));
					assert.deepEqual(hints.get(nested.toolName), annotations, "MCP 注解经过真实包装器后仍保留");
				}
				const transcriptResults = session.messages.filter(message => message.role === "toolResult");
				assert.equal(transcriptResults.length, 1, "嵌套 MCP 结果正文不得成为会话记录条目");
				const output = transcriptResults[0]!;
				assert.equal(output.toolName, OUTER);
				assert.equal(JSON.stringify(modelRequests).includes(SECRET), false);
				if (scenario.block === OUTER) {
					assert.equal(output.isError, true);
					assert.match(JSON.stringify(output.content), /测试权限被拒绝/);
					assert.deepEqual(calls.map(call => call.toolName), [OUTER]);
					assert.deepEqual(chain, []);
					assert.equal(putCount, 0);
				} else {
					const outer = results.find(result => result.toolName === OUTER)!;
					assert.ok(outer);
					const business = outer.structuredContent as Record<string, unknown>;
					assert.deepEqual(outer.details, business);
					assert.deepEqual(JSON.parse(outer.content.filter(block => block.type === "text").map(block => block.text).join("")), JSON.parse(JSON.stringify(business)));
					const failure = scenario.block || scenario.redact || scenario.remoteError || scenario.missing;
					const failedAtLink = scenario.custom && [scenario.block, scenario.redact, scenario.remoteError].includes(LINK);
					if (failure) {
						assert.equal(output.isError, true);
						assert.equal((business.error as { code: string }).code, scenario.remoteError ? "mcp-error" : "mcp-unavailable");
						assert.equal(business.uploaded, Boolean(failedAtLink));
						assert.equal(business.phase, failedAtLink ? "link" : "prepare");
						assert.equal(business.linkStatus, failedAtLink ? "failed" : "not-ready");
						assert.equal(business.url, undefined);
						assert.equal(putCount, failedAtLink ? 1 : 0);
						assert.equal(JSON.stringify(business).includes(SECRET), false);
						if (failedAtLink) {
							assert.equal(business.key, KEY);
							assert.equal(typeof business.resume, "string");
							assert.equal((business.fallback as { url: string }).url, DOWNLOAD);
						}
					} else {
						assert.equal(output.isError, false, JSON.stringify({ business, calls, remote, errors, transportErrors }));
						assert.deepEqual(business, { uploaded: true, uploadStatus: "uploaded", phase: "link", linkStatus: "ready",
							key: KEY, url: scenario.custom ? link.url : DOWNLOAD, expiresAt: EXPIRES,
							expiresIn: scenario.custom ? seconds : 86400, disposition: scenario.custom ? "attachment" : "inline" });
						assert.equal(putCount, 1);
						assert.deepEqual(chain, scenario.custom ? ["upload_file", "PUT", "get_file_url"] : ["upload_file", "PUT"]);
					}
					if (scenario.missing || scenario.block === UPLOAD) assert.deepEqual(remote, []);
					if (scenario.block === LINK) assert.deepEqual(chain, ["upload_file", "PUT"]);
					for (const result of results.filter(result => result.toolName !== OUTER)) {
						if (result.toolName === scenario.block) continue;
						// 这是实际的 AgentToolCallOutcome.result.structuredContent：
						// 完整的原始 MCP CallToolResult，而非内部业务对象。
						const raw = result.structuredContent as unknown as CallToolResult;
						assert.ok(Array.isArray(raw.content));
						if (result.toolName === scenario.remoteError) {
							assert.equal(result.isError, true);
							assert.equal(raw.isError, true);
							assert.deepEqual(raw.structuredContent, { error: { code: "denied", message: SECRET } });
						} else assert.deepEqual(raw.structuredContent, result.toolName === UPLOAD ? plan : link);
					}
					const preparation = remote.find(call => call.name === "upload_file");
					if (preparation) {
						assert.equal(preparation.args.filename, "report.txt");
						assert.equal(preparation.args.size, Buffer.byteLength(CONTENT));
						assert.equal(preparation.args.contentType, "text/plain");
						assert.equal(typeof preparation.args.mtimeMs, "number");
						assert.equal(typeof preparation.args.ctimeMs, "number");
					}
					const signing = remote.find(call => call.name === "get_file_url");
					if (signing) assert.deepEqual(signing.args, { key: KEY, expiresIn: seconds, disposition: "attachment" });
				}
				assert.deepEqual(errors, [], "不得吞掉扩展错误");
				assert.deepEqual(transportErrors, [], "所有 JSON-RPC 测试请求均已处理");
				assert.deepEqual(sandbox.blocked, [], "不得尝试真实网络访问或意外 HTTP 请求");
			} finally {
				try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
				finally {
					session?.dispose();
					await pair.server.close();
					globalThis.fetch = guardedFetch;
				}
			}
		});
	} finally { sandbox.restore(); }
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
