/** Opt-in live acceptance. Not part of npm test; creates synthetic remote objects. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	createAgentSession, createMcpExtension, DefaultResourceLoader, getAgentDir,
	ModelRuntime, SessionManager, SettingsManager, type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { registerUploadTool } from "./index.ts";
import { putBytes } from "./transport.ts";
import { UploadError } from "./errors.ts";
import type { UploadParams, UploadResult } from "./uploader.ts";
import { SINGLE_LIMIT, UPLOAD_TOOL, URL_TOOL } from "./protocol.ts";

const MODEL_ROOT = "https://upload-live-fixture.invalid";

function modelResponse(args?: UploadParams): Response {
	const item = args
		? { type: "function_call", id: "fc_live", call_id: "call_live", name: "upload_local_file", arguments: JSON.stringify(args), status: "completed" }
		: { type: "message", id: "msg_live", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] };
	const events: unknown[] = [
		{ type: "response.created", response: { id: "resp_live", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: args ? { ...item, arguments: "" } : { ...item, content: [] } },
		args ? { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args) }
			: { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "done" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_live", status: "completed", output: [item],
			usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function main(): Promise<void> {
	if (process.env.TSGW_UPLOAD_LIVE !== "1") throw new Error("Set TSGW_UPLOAD_LIVE=1 only after authorizing synthetic uploads to the configured ts_oht server.");
	const root = await mkdtemp(join(tmpdir(), "pi-tsgw-upload-live-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const realFetch = globalThis.fetch;
	let session: AgentSession | undefined;
	let args: UploadParams;
	let issued = false;
	let result: UploadResult | undefined;
	let interrupt = false;
	let loseCompletion = false;
	let firstDone: (() => void) | undefined;
	let firstPart = Promise.resolve();
	const puts: number[] = [];
	const calls: string[] = [];
	const failures: string[] = [];
	try {
		// Read the host's existing MCP configuration through its own loader, in memory.
		// Only ts_oht is connected; no settings, credentials or URLs are copied to files.
		const configModule = await import(new URL("./extensions/mcp/config.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
		const config = configModule.loadMcpConfig({ agentDir: getAgentDir(), cwd: root, projectTrusted: false });
		assert.equal(config.errors.length, 0, "Host MCP configuration must load without errors");
		config.servers = config.servers.filter((entry: { name: string }) => entry.name === "ts_oht");
		assert.equal(config.servers.length, 1, "Expected an existing ts_oht configuration");
		assert.notEqual(config.servers[0].config.enabled, false);
		config.autoEnableCodemode = false;
		const settings = SettingsManager.inMemory({ packages: [], extensions: [], cacheWarming: "off",
			compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, transport: "sse" });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Synthetic upload acceptance; all model responses are local fixtures.",
			extensionFactories: [createMcpExtension({ loadConfig: () => config, logPath: join(root, "mcp.log") }), pi => {
				pi.registerProvider("upload-fixture", { api: "openai-responses", baseUrl: `${MODEL_ROOT}/v1`, apiKey: "fixture-only",
					models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 256,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
				registerUploadTool(pi, { async put(target, body, signal) {
					puts.push(target.size);
					if (interrupt && target.size <= SINGLE_LIMIT) {
						// First part is acknowledged before the injected interruption; no real retries.
						if (puts.length > 1) { await firstPart; throw new UploadError("test-interruption", "Synthetic interrupted batch."); }
						try { await putBytes(target, body, signal); } finally { firstDone?.(); }
						return;
					}
					await putBytes(target, body, signal);
				} });
				pi.on("tool_call", event => { if ([UPLOAD_TOOL, URL_TOOL].includes(event.toolName)) calls.push(event.toolName); });
				pi.on("tool_result", event => {
					if (event.toolName === UPLOAD_TOOL && loseCompletion) {
						const raw = event.structuredContent as { structuredContent?: { uploaded?: boolean } } | undefined;
						if (raw?.structuredContent?.uploaded === true) {
							loseCompletion = false;
							return { isError: true, content: [{ type: "text", text: "Synthetic lost completion response" }] };
						}
					}
					if (event.toolName === "upload_local_file") result = event.structuredContent as unknown as UploadResult;
				});
			}],
		});
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).origin !== MODEL_ROOT) return realFetch(input, init);
			const response = modelResponse(issued ? undefined : args);
			issued = true;
			return response;
		};
		await loader.reload();
		assert.equal(loader.getExtensions().errors.length, 0, "Extension loading failed");
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
		({ session } = await createAgentSession({ cwd: root, agentDir, modelRuntime: runtime, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(root), tools: ["upload_local_file", UPLOAD_TOOL, URL_TOOL], thinkingLevel: "off" }));
		await runtime.setRuntimeApiKey("upload-fixture", "fixture-only");
		const model = runtime.getModel("upload-fixture", "fixture");
		assert.ok(model);
		await session.setModel(model);
		await session.bindExtensions({ mode: "print", onError: () => failures.push("Host extension error") });
		for (let attempt = 0; attempt < 300 && !session.getAllTools().some(t => t.name === UPLOAD_TOOL); attempt++) await delay(100);
		if (!session.getAllTools().some(t => t.name === UPLOAD_TOOL)) console.log(`Live MCP not ready; host errors: ${failures.length}; registered tools: ${session.getAllTools().length}`);
		assert.ok(session.getAllTools().some(t => t.name === UPLOAD_TOOL), "ts_oht tools did not become ready");
		const invoke = async (input: UploadParams): Promise<UploadResult> => {
			args = input; issued = false; result = undefined;
			await session!.prompt("Execute the configured synthetic upload acceptance step.");
			assert.ok(result, "No upload result received through the real host pipeline");
			return result;
		};
		const verify = async (value: UploadResult, expectedHash: string, disposition: string, seconds: number) => {
			assert.equal(value.uploaded, true, value.error?.code ?? "Upload was not confirmed");
			assert.equal(value.linkStatus, "ready");
			assert.equal(value.expiresIn, seconds);
			assert.equal(value.disposition, disposition);
			assert.ok(value.url);
			const url = new URL(value.url);
			assert.equal(Number(url.searchParams.get("X-Amz-Expires")), seconds);
			const response = await realFetch(value.url, { redirect: "error", signal: AbortSignal.timeout(180_000) });
			assert.equal(response.status, 200);
			assert.ok(response.headers.get("content-disposition")?.startsWith(disposition));
			assert.ok(response.body);
			const hash = createHash("sha256");
			for await (const chunk of response.body) hash.update(chunk);
			assert.equal(hash.digest("hex"), expectedHash, "Downloaded bytes must match the synthetic source");
		};
		const small = Buffer.from("pi-tsgw synthetic upload acceptance\n".repeat(4));
		await writeFile(join(root, "inline.txt"), small);
		const digest = createHash("sha256").update(small).digest("hex");
		await verify(await invoke({ path: "inline.txt" }), digest, "inline", 86400);
		console.log("PASS single PUT: raw bytes, SHA-256, inline, 86400 seconds");
		await writeFile(join(root, "attachment.txt"), small);
		await verify(await invoke({ path: "attachment.txt", disposition: "attachment", expiresIn: 7200 }), digest, "attachment", 7200);
		console.log("PASS single PUT: attachment, custom 7200 seconds");

		const largePath = join(root, "multipart.bin");
		const handle = await open(largePath, "wx");
		const block = randomBytes(1024 * 1024);
		const largeHash = createHash("sha256");
		try { for (let i = 0; i < 33; i++) { await handle.write(block); largeHash.update(block); } }
		finally { await handle.close(); }
		puts.length = 0;
		interrupt = true;
		firstPart = new Promise<void>(resolve => { firstDone = resolve; });
		const interrupted = await invoke({ path: largePath });
		assert.equal(interrupted.error?.code, "test-interruption");
		assert.ok(interrupted.resume);
		assert.ok(interrupted.key);
		interrupt = false;
		puts.length = 0;
		loseCompletion = true;
		const uncertain = await invoke({ path: largePath, resume: interrupted.resume });
		assert.equal(uncertain.uploadStatus, "unknown");
		assert.equal(uncertain.phase, "complete");
		assert.equal(uncertain.key, interrupted.key);
		assert.ok(uncertain.resume);
		assert.equal(puts.length, 4, "Only the four missing parts are uploaded; the first part is not replayed");
		const before = calls.length;
		puts.length = 0;
		const recovered = await invoke({ path: largePath, resume: uncertain.resume, disposition: "attachment", expiresIn: 3600 });
		assert.deepEqual(calls.slice(before), [URL_TOOL], "Lost completion is recovered with HEAD/signing only");
		assert.equal(puts.length, 0);
		assert.equal(recovered.key, interrupted.key);
		await verify(recovered, largeHash.digest("hex"), "attachment", 3600);
		console.log("PASS 33 MiB multipart: interruption, missing-part resume, lost completion recovery, SHA-256, attachment, 3600 seconds");
		assert.deepEqual(failures, []);
		console.log("PASS real Pi host + configured ts_oht; synthetic objects remain for normal server retention");
	} finally {
		try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
		finally {
			session?.dispose();
			globalThis.fetch = realFetch;
			await rm(root, { recursive: true, force: true });
		}
	}
}

void main().catch((error: unknown) => {
	// Only local stack locations, never assertion values, URLs or network errors.
	console.error("Live upload acceptance failed. Sensitive diagnostics suppressed.");
	if (error instanceof Error) for (const line of error.stack?.split("\n") ?? []) {
		const location = line.match(/\/extensions\/upload\/live\.test\.js:(\d+):(\d+)\)?$/);
		if (location) console.error(`Location: live.test.js:${location[1]}:${location[2]}`);
	}
	process.exitCode = 1;
});
