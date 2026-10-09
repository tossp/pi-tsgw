import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import { modelsForRoot, PROVIDER_ID } from "./models/catalog.ts";
import { HostSandbox, TEST_KEY, TEST_ROOT, type CapturedRequest } from "./host-test-support.test.ts";

// Resolve both source execution and tsc's dist/extensions output without cwd or
// machine-specific paths. Always load the SOURCE entry through Pi/jiti.
function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "extensions", "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "Cannot locate pi-tsgw package root");
		dir = parent;
	}
}

function searchTool(request: CapturedRequest): Record<string, unknown> {
	assert.ok(Array.isArray(request.body.tools));
	const tools = request.body.tools as Record<string, unknown>[];
	const matches = tools.filter((tool) => tool.type === "web_search");
	assert.equal(matches.length, 1, "Exactly one native search tool must reach HTTP");
	return matches[0]!;
}

function trace(request: CapturedRequest): { thread: string; turn: string } {
	const thread = request.headers.get("AH-Thread-Id");
	const turn = request.headers.get("AH-Trace-Id");
	assert.match(thread ?? "", /^[0-9a-f-]{36}$/);
	assert.match(turn ?? "", /^[0-9a-f-]{36}$/);
	return { thread: thread!, turn: turn! };
}

// Run as its own node process: environment/network guards intentionally affect
// the whole process. No FakePi, mocked SDK methods, credentials or live server.
test("Pi 1.1 SDK: source loading, catalog refresh, commands, request hooks and reload", { timeout: 60_000 }, async () => {
	const entry = sourceEntry();
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	let session: AgentSession | undefined;
	try {
		// Dynamic import is essential: the SDK must initialize inside the sandbox.
		const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify({
			tsgw: { baseUrl: TEST_ROOT, tsSearch: "live", traceHeaders: true },
		}));
		const settings = SettingsManager.inMemory({
			packages: [], extensions: [],
			compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
			cacheWarming: "off",
			transport: "sse",
		});
		const lifecycle: string[] = [];
		const errors: ExtensionError[] = [];
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			noExtensions: true, additionalExtensionPaths: [entry],
			noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Reply briefly. This is an isolated host regression.",
			extensionFactories: [(pi) => {
				pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
				pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, 2, "Only project entry and lifecycle observer");
		assert.ok(loader.getExtensions().extensions.some((extension) => extension.path === entry));
		assert.equal(sandbox.catalogCalls, 0, "No stored credential: static startup must not fetch");
		const runtime = await ModelRuntime.create({
			authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			allowModelNetwork: false, refreshOnCreate: false,
		});
		assert.deepEqual(await runtime.listCredentials(), [], "No ambient or real stored credentials");
		({ session } = await createAgentSession({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
			resourceLoader: loader, settingsManager: settings,
			sessionManager: SessionManager.inMemory(sandbox.cwd), tools: [],
			thinkingLevel: "high",
		}));
		const staticModels = modelsForRoot(TEST_ROOT);
		assert.equal(staticModels.length, 54, "Update intentionally if the static catalog grows");
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

		// Real slash-command dispatch, including no-UI diagnostic guard.
		await session.prompt("/tsgw");
		assert.equal(sandbox.requests.length, 0);
		sandbox.catalogIds = [model.id, "deepseek-v4-pro", "not-in-static-catalog"];
		await session.prompt("/tsgw-refresh");
		assert.equal(sandbox.catalogCalls, 1);
		const expectedIds = staticModels.filter((m) => sandbox.catalogIds.includes(m.id)).map((m) => m.id).sort();
		assert.deepEqual(runtime.getModels(PROVIDER_ID).map((m) => m.id).sort(), expectedIds);
		assert.ok(expectedIds.length < staticModels.length);
		// No hand-written cache: failure reuses state produced by the real refresh.
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
		// Delayed callbacks from the invalidated runner still use its scalar snapshot.
		// Invoke the actual runner dispatcher, never the extension handler directly.
		const latePayload = await oldRunner.emitBeforeProviderRequest({ model: model.id, tools: [] });
		const lateHeaders = await oldRunner.emitBeforeProviderHeaders({});
		assert.equal(searchTool({ body: latePayload as Record<string, unknown>, headers: new Headers() }).external_web_access, false);
		assert.equal(lateHeaders["AH-Thread-Id"], firstTrace.thread);
		await session.prompt("After reload: settings must restore live search");
		assert.equal(session.getLastAssistantText(), "fixture reply");
		assert.equal(sandbox.requests.length, 3);
		assert.equal(searchTool(sandbox.requests[2]!).external_web_access, true);
		assert.notEqual(trace(sandbox.requests[2]!).thread, firstTrace.thread);
		assert.deepEqual(errors, [], "Real extension runner must not swallow lifecycle/hook errors");
		assert.deepEqual(sandbox.blocked, [], "No unexpected network attempts, even if caught by Pi");
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
