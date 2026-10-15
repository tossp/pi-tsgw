import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { HostSandbox } from "./host-test-support.test.ts";

// Always hand Pi/jiti the complete SOURCE entry, including from dist/extensions.
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

type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];
type Entry = Parameters<McpTransportFactory>[0];

// Only the transport is substituted: the real MCP client performs initialize,
// notification exchange and discovery, and the real host registers its tools.
class MemoryServer implements Transport {
	readonly messages: Message[] = [];
	starts = 0;
	closes = 0;
	private readonly listeners = new Set<(message: Message) => void>();
	private readonly errors = new Set<(error: Error) => void>();
	private readonly closing = new Set<() => void>();

	async start(): Promise<void> { this.starts++; }
	async close(): Promise<void> {
		this.closes++;
		for (const listener of this.closing) listener();
	}
	onMessage(listener: (message: Message) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}
	onError(listener: (error: Error) => void): () => void {
		this.errors.add(listener);
		return () => { this.errors.delete(listener); };
	}
	onClose(listener: () => void): () => void {
		this.closing.add(listener);
		return () => { this.closing.delete(listener); };
	}
	private receive(message: Message): void {
		// Serialize like a wire transport rather than sharing response objects.
		const wire = JSON.stringify(message);
		for (const listener of this.listeners) listener(JSON.parse(wire) as Message);
	}
	async send(message: Message): Promise<void> {
		this.messages.push(message);
		assert.equal(message.jsonrpc, "2.0");
		if (!("method" in message)) return; // Response to our server-side ping.
		if (!("id" in message)) {
			assert.equal(message.method, "notifications/initialized");
			this.receive({ jsonrpc: "2.0", id: "server-ping", method: "ping" });
			return;
		}
		let result: unknown;
		switch (message.method) {
			case "initialize": {
				const params = message.params as { protocolVersion: string; clientInfo: { name: string } };
				assert.equal(params.clientInfo.name, "pi");
				result = {
					protocolVersion: params.protocolVersion,
					capabilities: { tools: {}, resources: {} },
					serverInfo: { name: "in-memory-ts-oht", version: "1.0.0" },
					instructions: "Isolated MCP integration fixture.",
				};
				break;
			}
			case "ping": result = {}; break;
			case "tools/list": result = { tools: [{
				name: "lookup", description: "Look up fixture data",
				inputSchema: { type: "object", properties: {} },
				annotations: { readOnlyHint: true },
			}] }; break;
			case "resources/list": result = { resources: [] }; break;
			case "resources/templates/list": result = { resourceTemplates: [] }; break;
			default:
				throw new Error(`Unexpected fixture MCP request: ${message.method}`);
		}
		this.receive({ jsonrpc: "2.0", id: message.id, result });
	}
}

function snapshot(paths: string[]): Array<[string, string | undefined]> {
	return paths.map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : undefined]);
}

// Separate process, like host-integration: the sandbox guards the whole process.
test("Pi SDK MCP: source defaults, settings URL, file precedence, disabled servers and cleanup", { timeout: 60_000 }, async (t) => {
	const entry = sourceEntry();
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	try {
		// SDK initialization must happen AFTER HostSandbox installs its guards.
		const { createAgentSession, createCodemodeExtension, createMcpExtension,
			DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const { TS_OHT_NAME, TS_OHT_URL } = await import("./mcp.ts");
		assert.equal(TS_OHT_NAME, "ts_oht");
		assert.equal(TS_OHT_URL, "https://xn--oht.cc/mcp");
		const customUrl = "https://settings-mcp.invalid/custom/mcp";
		const globalConfig = { url: "https://global-mcp.invalid/complete/mcp", exposure: "direct", timeout: 17 };
		const projectConfig = { url: "https://project-mcp.invalid/complete/mcp", exposure: "direct", timeout: 23 };
		const scenarios = [
			{ name: "no configuration registers the fixed codemode default", expected: { url: TS_OHT_URL, exposure: "codemode" } },
			{ name: "settings.tsgw.mcpUrl supplies the session default", configuredUrl: customUrl,
				expected: { url: customUrl, exposure: "codemode" } },
			{ name: "global mcp.json fully overrides registration and settings", configuredUrl: customUrl,
				global: globalConfig, expected: globalConfig, scope: "global" },
			{ name: "same-name enabled false suppresses the default connection", configuredUrl: customUrl,
				global: { ...globalConfig, enabled: false }, expected: { ...globalConfig, enabled: false }, scope: "global" },
			{ name: "trusted project mcp.json replaces the same-name global server", configuredUrl: customUrl,
				global: globalConfig, project: projectConfig, trusted: true, expected: projectConfig, scope: "project" },
			{ name: "untrusted project cannot override the global server", configuredUrl: customUrl,
				global: globalConfig, project: projectConfig, trusted: false, expected: globalConfig, scope: "global" },
		];
		for (const [index, scenario] of scenarios.entries()) {
			await t.test(scenario.name, async () => {
				// Independent files and session per scenario, but one process-wide sandbox.
				const agentDir = join(sandbox.agentDir, String(index));
				const cwd = join(sandbox.cwd, String(index));
				mkdirSync(agentDir, { recursive: true });
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				// ModelRuntime owns auth.json and initializes it even without credentials.
				writeFileSync(join(agentDir, "auth.json"), "{}");
				process.env.PI_CODING_AGENT_DIR = agentDir;
				const globalPath = join(agentDir, "mcp.json");
				const projectPath = join(cwd, ".pi", "mcp.json");
				if (scenario.configuredUrl) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
					tsgw: { mcpUrl: scenario.configuredUrl },
				}));
				if (scenario.global) writeFileSync(globalPath, JSON.stringify({ mcpServers: { [TS_OHT_NAME]: scenario.global } }, null, 2));
				if (scenario.project) writeFileSync(projectPath, JSON.stringify({ mcpServers: { [TS_OHT_NAME]: scenario.project } }, null, 2));
				const protectedPaths = [globalPath, projectPath, ...["settings.json", "auth.json", "mcp-auth.json"]
					.flatMap((name) => [join(agentDir, name), join(cwd, ".pi", name)])];
				const before = snapshot(protectedPaths);
				const settings = SettingsManager.inMemory({
					packages: [], extensions: [], cacheWarming: "off",
					compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
				});
				settings.setProjectTrusted(scenario.trusted === true);
				const transports: Array<{ entry: Entry; cwd: string; server: MemoryServer }> = [];
				const errors: ExtensionError[] = [];
				const lifecycle: string[] = [];
				const notices: string[] = [];
				const loader = new DefaultResourceLoader({
					cwd, agentDir, settingsManager: settings,
					noExtensions: true, additionalExtensionPaths: [entry],
					noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
					systemPrompt: "Isolated MCP host regression; never invoke a model.",
					extensionFactories: [
						createCodemodeExtension({ mode: "on" }),
						createMcpExtension({
							// Deliberately no loadConfig override: exercise real file loading.
							createTransport: (entry, cwd) => {
								const server = new MemoryServer();
								transports.push({ entry, cwd, server });
								return server;
							},
						}),
						(pi) => {
							pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
							pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
						},
					],
				});
				let session: AgentSession | undefined;
				try {
					await loader.reload();
					assert.deepEqual(loader.getExtensions().errors, []);
					assert.ok(loader.getExtensions().extensions.some((extension) => extension.path === entry));
					assert.equal(transports.length, 0, "Extension loading must not connect");
					const runtime = await ModelRuntime.create({
						authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
						modelsStorePath: join(agentDir, "models-store.json"),
						allowModelNetwork: false, refreshOnCreate: false,
					});
					assert.deepEqual(await runtime.listCredentials(), []);
					({ session } = await createAgentSession({
						cwd, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
						sessionManager: SessionManager.inMemory(cwd),
						// Unlike tools: [], this does not filter away registered MCP tools.
						tools: ["codemode"],
					}));
					assert.equal(transports.length, 0, "Session creation must wait for session_start");
					await session.bindExtensions({
						mode: "print", onError: (error) => { errors.push(error); },
						uiContext: { ...session.extensionRunner.getUIContext(),
							notify: (message) => { notices.push(message); } },
					});
					assert.equal(lifecycle.length, 1);
					assert.match(lifecycle[0]!, /^start:/);
					assert.ok(session.extensionRunner.getRegisteredCommands().some((command) => command.name === "mcp"));

					// Real slash dispatch waits for background discovery without model calls.
					await session.prompt("/mcp");
					await session.prompt("/mcp");
					const disabled = "enabled" in scenario.expected && scenario.expected.enabled === false;
					const statuses = notices.filter((message) => message.startsWith(`${TS_OHT_NAME}:`));
					assert.equal(statuses.length, 2, "Both /mcp invocations must report status");
					assert.equal(statuses[0], statuses[1]);
					assert.match(statuses[0]!, disabled ? /^ts_oht: disabled/ : /^ts_oht: connected, 1 tools/);
					assert.ok(statuses[0]!.includes(`(${scenario.expected.exposure})`));
					if (scenario.scope) {
						assert.ok(statuses[0]!.includes("overridden:"));
						assert.ok(statuses[0]!.includes(scenario.scope === "project" ? projectPath : globalPath));
					} else assert.ok(!statuses[0]!.includes("overridden:"));
					assert.equal(transports.length, disabled ? 0 : 1, "At most one connection; /mcp must not reconnect");
					const tool = session.getAllTools().find((tool) => tool.name === "mcp__ts_oht__lookup");
					if (disabled) assert.equal(tool, undefined);
					else {
						const captured = transports[0]!;
						assert.equal(captured.cwd, cwd);
						assert.equal(captured.entry.name, TS_OHT_NAME);
						assert.deepEqual(captured.entry.config, scenario.expected, "URL, exposure and timeout must come from the winner, not merge");
						assert.equal(captured.entry.scope, scenario.scope ?? "extension");
						assert.equal(captured.entry.source, scenario.scope === "project" ? projectPath : scenario.scope === "global" ? globalPath : entry);
						assert.equal(captured.server.starts, 1);
						assert.equal(captured.server.closes, 0);
						const methods = captured.server.messages.flatMap((message) => "method" in message ? [message.method] : []);
						assert.deepEqual(methods.slice(0, 2), ["initialize", "notifications/initialized"]);
						for (const method of ["initialize", "tools/list"])
							assert.equal(methods.filter((name) => name === method).length, 1, `${method} once, despite two /mcp calls`);
						// Pi 1.2 advertises resource support without eager enumeration.
						for (const method of ["resources/list", "resources/templates/list"])
							assert.ok(methods.filter((name) => name === method).length <= 1, `No repeated ${method}`);
						assert.ok(captured.server.messages.some((message) => "id" in message && message.id === "server-ping" && "result" in message));
						if (scenario.expected.exposure === "codemode")
							assert.ok(["deferred", "codemode"].includes(tool?.exposure ?? ""), "Indirect exposure across Pi 1.1/1.2");
						else assert.equal(tool?.exposure, scenario.expected.exposure);
						assert.equal(tool?.annotations?.readOnlyHint, true);
						assert.ok(session.getAllTools().some((tool) => tool.name === "list_mcp_resources"));
					}
					assert.deepEqual(session.messages, [], "Slash commands must not start any agent turn");
				} finally {
					// dispose() invalidates contexts but does not await MCP shutdown. Drain
					// the real runner's lifecycle first, before replacing files/environment.
					try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
					finally { session?.dispose(); }
				}
				assert.deepEqual(lifecycle.slice(1), ["shutdown:quit"]);
				for (const { server } of transports) assert.equal(server.closes, 1, "Shutdown closes each transport once");
				assert.deepEqual(errors, [], "The real runner must not swallow MCP lifecycle errors");
				assert.deepEqual(snapshot(protectedPaths), before, "No fixture mcp/settings/auth file may be changed or created");
				assert.deepEqual(sandbox.requests, [], "No model requests");
				assert.equal(sandbox.catalogCalls, 0, "No model catalog requests");
				assert.deepEqual(sandbox.blocked, [], "No unexpected HTTP or socket attempts, even if caught");
			});
		}
	} finally { sandbox.restore(); }
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
