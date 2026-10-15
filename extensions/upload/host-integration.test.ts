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
}

/** Genuine Responses events: the real adapter must parse and dispatch the tool call. */
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

// Run in its own process, like ../host-integration.test.ts: the sandbox changes
// process-wide globals. Only model HTTP and the byte PUT boundary are faked;
// Pi's session, nested call pipeline, MCP wrapper/client and JSON-RPC are real.
test("Pi 1.1 SDK upload: real MCP nested execution, permissions and redaction", { timeout: 60_000 }, async (t) => {
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	try {
		// SDK and production imports happen only after ambient configuration and sockets are isolated.
		const { createAgentSession, createMcpExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const { createInMemoryTransportPair } = await import("@earendil-works/pi-mcp/testing");
		const { registerUploadTool } = await import("./index.ts");
		writeFileSync(join(sandbox.cwd, "report.txt"), CONTENT);
		const guardedFetch = globalThis.fetch;
		const scenarios: Scenario[] = [
			{ name: "default inline uses the plan link after one PUT" },
			{ name: "custom attachment follows upload_file → PUT → get_file_url", custom: true },
			{ name: "outer permission denial prevents all remote and byte operations", block: OUTER },
			{ name: "nested prepare permission denial prevents PUT", block: UPLOAD },
			{ name: "nested link permission denial preserves uploaded state", custom: true, block: LINK },
			{ name: "prepare redaction drops structured MCP result and fails closed", redact: UPLOAD },
			{ name: "link redaction drops structured MCP result and fails closed", custom: true, redact: LINK },
			{ name: "raw MCP structured prepare error becomes a safe business error", remoteError: UPLOAD },
			{ name: "raw MCP structured link error preserves uploaded state", custom: true, remoteError: LINK },
			{ name: "missing MCP produces safe error without creating a connection", missing: true },
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
			const args = { path: "report.txt", ...(scenario.custom ? { expiresIn: 3600, disposition: "attachment" } : {}) };
			const plan = { key: KEY, url: DOWNLOAD, expiresAt: EXPIRES, expiresIn: 86400,
				mode: "single", uploaded: false, uploads: [{ partNumber: 1, offset: 0, size: Buffer.byteLength(CONTENT),
					url: PUT, method: "PUT", headers: {}, expiresAt: EXPIRES }] };
			const link = { key: KEY, url: `${DOWNLOAD}&attachment=true`, expiresAt: EXPIRES, expiresIn: 3600 };
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
				} else throw new Error(`Unexpected MCP method: ${message.method}`);
				await pair.server.send({ jsonrpc: "2.0", id: message.id, result });
			};
			pair.server.onMessage(message => { void serve(message).catch(error => transportErrors.push(error)); });
			await pair.server.start();
			globalThis.fetch = async (input, init) => {
				const request = new Request(input, init);
				// All non-model requests still go through HostSandbox's deny/record guard.
				if (request.url !== `${TEST_ROOT}/v1/responses`) return guardedFetch(request);
				assert.equal(request.method, "POST");
				assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				modelRequests.push(await request.json() as Record<string, unknown>);
				assert.ok(modelRequests.length <= 2, "No unplanned model retries or tool loops");
				return responseSse(modelRequests.length === 1, args);
			};
			try {
				const settings = SettingsManager.inMemory({ packages: [], extensions: [],
					compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
					cacheWarming: "off", transport: "sse" });
				const loader = new DefaultResourceLoader({
					cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
					noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
					systemPrompt: "Execute only the explicitly requested isolated fixture upload.",
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
								assert.ok(body instanceof Uint8Array, "Single upload must use a fixed snapshot");
								assert.equal(Buffer.from(body).toString(), CONTENT);
								putCount++;
								chain.push("PUT");
							} });
							pi.on("tool_call", event => {
								calls.push(event);
								hints.set(event.toolName, pi.getAllTools().find(tool => tool.name === event.toolName)?.annotations);
								if (event.toolName === scenario.block) return { block: true, reason: "Fixture permission denied" };
							});
							pi.on("tool_result", event => {
								results.push({ ...event });
								// Even valid JSON text must not be recovered when the host removes the
								// structured wrapper. Returning only content triggers Pi's redaction rule.
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
				await session.prompt("I authorize uploading report.txt with the fixture options.");
				assert.equal(session.getLastAssistantText(), "Upload fixture finished.");
				assert.equal(modelRequests.length, 2);
				assert.ok((modelRequests[0]!.tools as { name?: string }[]).some(tool => tool.name === OUTER));
				assert.deepEqual(hints.get(OUTER), annotations, "Permission handlers observe public upload annotations");
				assert.equal(transportCreations, scenario.missing ? 0 : 1);
				if (scenario.redact) {
					assert.equal(redactedResults.length, 1);
					assert.equal(redactedResults[0]!.structuredContent, undefined, "Real host redaction removes structured output");
					assert.ok(redactedResults[0]!.content.some(block => block.type === "text"), "Text cannot bypass redaction");
				}
				const outerCall = calls.find(call => call.toolName === OUTER)!;
				assert.ok(outerCall);
				assert.equal(outerCall.parentToolCallId, undefined);
				for (const nested of calls.filter(call => call.toolName !== OUTER)) {
					assert.equal(nested.parentToolCallId, outerCall.toolCallId);
					assert.ok(nested.toolCallId.startsWith(`${outerCall.toolCallId}/`));
					assert.deepEqual(hints.get(nested.toolName), annotations, "MCP annotations survive the real wrapper");
				}
				const transcriptResults = session.messages.filter(message => message.role === "toolResult");
				assert.equal(transcriptResults.length, 1, "Nested MCP result bodies must not become transcript entries");
				const output = transcriptResults[0]!;
				assert.equal(output.toolName, OUTER);
				assert.equal(JSON.stringify(modelRequests).includes(SECRET), false);
				if (scenario.block === OUTER) {
					assert.equal(output.isError, true);
					assert.match(JSON.stringify(output.content), /Fixture permission denied/);
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
							expiresIn: scenario.custom ? 3600 : 86400, disposition: scenario.custom ? "attachment" : "inline" });
						assert.equal(putCount, 1);
						assert.deepEqual(chain, scenario.custom ? ["upload_file", "PUT", "get_file_url"] : ["upload_file", "PUT"]);
					}
					if (scenario.missing || scenario.block === UPLOAD) assert.deepEqual(remote, []);
					if (scenario.block === LINK) assert.deepEqual(chain, ["upload_file", "PUT"]);
					for (const result of results.filter(result => result.toolName !== OUTER)) {
						if (result.toolName === scenario.block) continue;
						// This is the actual AgentToolCallOutcome.result.structuredContent:
						// one complete raw MCP CallToolResult, not the inner business object.
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
					if (signing) assert.deepEqual(signing.args, { key: KEY, expiresIn: 3600, disposition: "attachment" });
				}
				assert.deepEqual(errors, [], "No swallowed extension errors");
				assert.deepEqual(transportErrors, [], "All JSON-RPC fixture requests were handled");
				assert.deepEqual(sandbox.blocked, [], "No real network or unexpected HTTP attempts");
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
