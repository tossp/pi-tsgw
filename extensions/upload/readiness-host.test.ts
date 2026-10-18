import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";

const OUTER = "upload_local_file";
const UPLOAD = "mcp__ts_oht__upload_file";
const LINK = "mcp__ts_oht__get_file_url";
const CONTENT = "readiness fixture\n";
const SECRET = "synthetic-connection-error-secret";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const PUT = "https://readiness-fixture.invalid/put";
const DOWNLOAD = "https://readiness-fixture.invalid/download";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

// 必须使用独立进程：HostSandbox 在导入真实 SDK 前隔离环境、cwd、fetch
// 及 TCP/TLS/UDP。不使用个人配置，也不执行真实上传。
test("Pi 1.2 SDK：上传 reachesTools 等待真实 MCP 工具发现", { timeout: 30_000 }, async t => {
	const env = { ...process.env };
	const cwd = process.cwd();
	const fetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	try {
		const { createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const { createInMemoryTransportPair } = await import("@earendil-works/pi-mcp/testing");
		const { registerUploadTool } = await import("./index.ts");
		writeFileSync(join(sandbox.cwd, "report.txt"), CONTENT);
		for (const scenario of ["ready", "failed", "disabled", "cancelled", "reconnect"] as const) {
			await t.test(({ ready: "就绪", failed: "失败", disabled: "已禁用", cancelled: "已取消", reconnect: "重连" })[scenario], async () => {
				const errors: ExtensionError[] = [];
				const wireErrors: unknown[] = [];
				const seen = deferred();
				const release = deferred();
				const reached = deferred();
				const pairs: ReturnType<typeof createInMemoryTransportPair>[] = [];
				const chain: string[] = [];
				let creations = 0;
				let parentExecutions = 0;
				let session: AgentSession | undefined;
				let context!: ReturnType<AgentSession["extensionRunner"]["createToolContext"]>;
				const plan = { key: "fixture/report.txt", url: DOWNLOAD, expiresAt: EXPIRES, expiresIn: 86400,
					mode: "single", uploaded: false, uploads: [{ partNumber: 1, offset: 0, size: Buffer.byteLength(CONTENT),
						url: PUT, method: "PUT", headers: {}, expiresAt: EXPIRES }] };
				const settings = SettingsManager.inMemory({ packages: [], extensions: [],
					compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" });
				const loader = new DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
					noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
					systemPrompt: "隔离的就绪状态测试场景。",
					extensionFactories: [
						// 在真实内置就绪处理器之前观察入口；绝不实现或替换该处理器。
						pi => { pi.on("tool_call", event => { if (event.toolName === OUTER) reached.resolve(); }); },
						createMcpExtension({
							loadConfig: () => ({ errors: [], autoEnableCodemode: false, servers: [{ name: "ts_oht",
								source: "readiness-fixture", scope: "extension", config: {
									url: "https://readiness-fixture.invalid/mcp", exposure: "codemode", enabled: scenario !== "disabled",
								} }] }),
							createTransport: entry => {
								assert.equal(entry.name, "ts_oht");
								const generation = ++creations;
								const pair = createInMemoryTransportPair();
								pairs.push(pair);
								const serve = async (message: JsonRpcMessage) => {
									if (!("method" in message) || !("id" in message)) return;
									let result: unknown;
									if (message.method === "initialize") result = { protocolVersion: "2025-11-25",
										capabilities: { tools: {} }, serverInfo: { name: "readiness", version: "1" } };
									else if (message.method === "tools/list") {
										// 延迟实际 JSON-RPC 工具发现响应，而非模拟钩子或就绪 Promise。
										if (scenario !== "reconnect" || generation === 2) {
											seen.resolve();
											await release.promise;
										}
										if (scenario === "failed") {
											await pair.server.send({ jsonrpc: "2.0", id: message.id,
												error: { code: -32603, message: SECRET } });
											return;
										}
										result = { tools: ["upload_file", "get_file_url"].map(name => ({ name,
											inputSchema: { type: "object", properties: {}, additionalProperties: true },
											outputSchema: { type: "object", additionalProperties: true } })) };
									} else if (message.method === "tools/call") {
										const params = message.params as { name: string };
										chain.push(params.name);
										assert.equal(params.name, "upload_file");
										result = { content: [{ type: "text", text: JSON.stringify(plan) }], structuredContent: plan };
									} else throw new Error(`意外的 MCP 方法 ${message.method}`);
									await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
								};
								pair.server.onMessage(message => { void serve(message).catch(error => wireErrors.push(error)); });
								void pair.server.start();
								return pair.client;
							},
						}),
						pi => {
							pi.registerProvider("readiness-fixture", { baseUrl: `${TEST_ROOT}/v1`, api: "openai-responses", apiKey: TEST_KEY,
								models: [{ id: "fixture", name: "Fixture", input: ["text"], reasoning: false,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
							// 仅在真实父工具的 execute 边界插桩；不替换就绪机制或客户端。
							registerUploadTool({ ...pi, registerTool(tool) {
								assert.deepEqual(tool.reachesTools?.({}), [UPLOAD, LINK]);
								pi.registerTool({ ...tool, async execute(...args) {
									parentExecutions++;
									return tool.execute(...args);
								} });
							} }, { put: async (target, body, signal) => {
								assert.equal(signal.aborted, false);
								assert.equal(target.url, PUT);
								assert.ok(body instanceof Uint8Array);
								assert.equal(Buffer.from(body).toString(), CONTENT);
								chain.push("PUT");
							} });
						},
					],
				});
				try {
					await loader.reload();
					assert.deepEqual(loader.getExtensions().errors, []);
					const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"),
						modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
						allowModelNetwork: false, refreshOnCreate: false });
					({ session } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
						resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd), tools: [OUTER] }));
					const model = runtime.getModel("readiness-fixture", "fixture");
					assert.ok(model);
					await session.setModel(model);
					await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
					// 嵌套流水线需要实际的助手消息。先通过真实 HTTP SSE 适配器
					// 创建消息，再使用公开的上下文执行 API。
					await session.prompt("我授权在隔离测试场景中上传 report.txt。");
					const cancel = new AbortController();
					context = session.extensionRunner.createToolContext("readiness-parent", cancel.signal);
					let reconnect: Promise<void> | undefined;
					if (scenario === "reconnect") {
						// 公开的 /mcp 命令重连真实客户端，并在新传输连接上发现工具。
						reconnect = session.prompt("/mcp reconnect ts_oht");
					}
					if (scenario !== "disabled") await seen.promise;
					assert.equal(context.tools.some(tool => tool.name === UPLOAD), scenario === "reconnect");
					let settled = false;
					const pending = context.executeTool(OUTER, { path: "report.txt" }).then(outcome => { settled = true; return outcome; });
					await reached.promise;
					if (scenario !== "disabled") {
						await sleep(30);
						assert.equal(settled, false, "父工具调用仍在等待 tools/list");
						assert.equal(parentExecutions, 0, "工具发现完成前不能开始执行父工具");
						assert.deepEqual(chain, [], "工具发现完成前不得调用 MCP 或执行字节 PUT");
					}
					if (scenario === "cancelled") {
						cancel.abort();
						// Pi 1.2 空闲时的 ctx.executeTool 路径不会将本次操作的
						// signal 传给 tool_call ctx.signal。取消不会解除就绪等待。
						await sleep(30);
						assert.equal(settled, false, "上游边界：仅取消操作不会结束就绪等待");
					}
					release.resolve();
					const outcome = await pending;
					await reconnect;
					if (scenario === "ready" || scenario === "reconnect") {
						assert.equal(outcome.isError, false, JSON.stringify(outcome));
						assert.equal(parentExecutions, 1);
						assert.deepEqual(chain, ["upload_file", "PUT"]);
						assert.equal((outcome.result.structuredContent as { url: string }).url, DOWNLOAD);
						assert.ok(context.tools.some(tool => tool.name === UPLOAD));
						assert.equal(session.getActiveToolNames().includes(UPLOAD), false, "Codemode 工具无需激活");
					} else {
						assert.equal(outcome.isError, true);
						assert.deepEqual(chain, []);
						assert.equal(JSON.stringify(outcome).includes(SECRET), false, "连接诊断信息不得通过上传泄露");
						if (scenario === "cancelled") {
							await sleep(30);
							assert.equal(parentExecutions, 0, "工具发现完成后，主机会阻止执行已取消的父工具");
							assert.deepEqual(chain, [], "取消并放行工具发现后，不得出现延迟的 MCP 调用或 PUT");
						}
					}
					assert.equal(creations, scenario === "disabled" ? 0 : scenario === "reconnect" ? 2 : 1);
					assert.deepEqual(errors, []);
					assert.deepEqual(wireErrors, []);
					assert.deepEqual(sandbox.blocked, []);
				} finally {
					release.resolve();
					try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
					finally { session?.dispose(); await Promise.all(pairs.map(pair => pair.server.close())); }
				}
			});
		}
	} finally { sandbox.restore(); }
	assert.deepEqual({ ...process.env }, env);
	assert.equal(process.cwd(), cwd);
	assert.equal(globalThis.fetch, fetch);
});
