import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError, McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { HostSandbox } from "./host-test-support.test.ts";

// 始终向 Pi/jiti 传入完整源码入口，包括从 dist/extensions 执行时。
function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "extensions", "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位 pi-tsgw 包根目录");
		dir = parent;
	}
}

type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];
type Entry = Parameters<McpTransportFactory>[0];

// 仅替换传输层：真实 MCP 客户端执行初始化、通知交换与发现，
// 由真实宿主注册工具。
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
		// 像真实传输一样序列化，而非共享响应对象。
		const wire = JSON.stringify(message);
		for (const listener of this.listeners) listener(JSON.parse(wire) as Message);
	}
	async send(message: Message): Promise<void> {
		this.messages.push(message);
		assert.equal(message.jsonrpc, "2.0");
		if (!("method" in message)) return; // 对服务端 ping 的响应。
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
				throw new Error(`测试夹具收到意外 MCP 请求：${message.method}`);
		}
		this.receive({ jsonrpc: "2.0", id: message.id, result });
	}
}

function snapshot(paths: string[]): Array<[string, string | undefined]> {
	return paths.map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : undefined]);
}

// 与宿主集成测试一样使用独立进程：沙箱防护覆盖整个进程。
test("Pi SDK MCP：源码默认值、配置 URL、文件优先级、禁用服务器与清理", { timeout: 60_000 }, async (t) => {
	const entry = sourceEntry();
	const originalEnv = { ...process.env };
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const sandbox = new HostSandbox();
	try {
		// SDK 必须在 HostSandbox 安装防护之后初始化。
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
			{ name: "无配置时注册固定的 codemode 默认值", expected: { url: TS_OHT_URL, exposure: "codemode" } },
			{ name: "settings.tsgw.mcpUrl 提供会话默认值", configuredUrl: customUrl,
				expected: { url: customUrl, exposure: "codemode" } },
			{ name: "全局 mcp.json 完整覆盖注册值与设置", configuredUrl: customUrl,
				global: globalConfig, expected: globalConfig, scope: "global" },
			{ name: "同名配置 enabled 为 false 时阻止默认连接", configuredUrl: customUrl,
				global: { ...globalConfig, enabled: false }, expected: { ...globalConfig, enabled: false }, scope: "global" },
			{ name: "受信任项目的 mcp.json 替换同名全局服务器", configuredUrl: customUrl,
				global: globalConfig, project: projectConfig, trusted: true, expected: projectConfig, scope: "project" },
			{ name: "不受信任的项目不能覆盖全局服务器", configuredUrl: customUrl,
				global: globalConfig, project: projectConfig, trusted: false, expected: globalConfig, scope: "global" },
		];
		for (const [index, scenario] of scenarios.entries()) {
			await t.test(scenario.name, async () => {
				// 每个场景使用独立文件与会话，但共享进程级沙箱。
				const agentDir = join(sandbox.agentDir, String(index));
				const cwd = join(sandbox.cwd, String(index));
				mkdirSync(agentDir, { recursive: true });
				mkdirSync(join(cwd, ".pi"), { recursive: true });
				// ModelRuntime 管理 auth.json，即使没有凭据也会初始化它。
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
					systemPrompt: "隔离的 MCP 宿主回归测试；绝不调用模型。",
					extensionFactories: [
						createCodemodeExtension({ mode: "on" }),
						createMcpExtension({
							// 有意不覆盖 loadConfig：验证真实文件加载。
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
					assert.equal(transports.length, 0, "加载扩展时不得建立连接");
					const runtime = await ModelRuntime.create({
						authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
						modelsStorePath: join(agentDir, "models-store.json"),
						allowModelNetwork: false, refreshOnCreate: false,
					});
					assert.deepEqual(await runtime.listCredentials(), []);
					({ session } = await createAgentSession({
						cwd, agentDir, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
						sessionManager: SessionManager.inMemory(cwd),
						// 与 tools: [] 不同，这不会滤除已注册的 MCP 工具。
						tools: ["codemode"],
					}));
					assert.equal(transports.length, 0, "创建会话后必须等待 session_start 才能连接");
					await session.bindExtensions({
						mode: "print", onError: (error) => { errors.push(error); },
						uiContext: { ...session.extensionRunner.getUIContext(),
							notify: (message) => { notices.push(message); } },
					});
					assert.equal(lifecycle.length, 1);
					assert.match(lifecycle[0]!, /^start:/);
					assert.ok(session.extensionRunner.getRegisteredCommands().some((command) => command.name === "mcp"));

					// 真实斜杠命令分发等待后台发现，不调用模型。
					await session.prompt("/mcp");
					await session.prompt("/mcp");
					const disabled = "enabled" in scenario.expected && scenario.expected.enabled === false;
					const statuses = notices.filter((message) => message.startsWith(`${TS_OHT_NAME}:`));
					assert.equal(statuses.length, 2, "两次 /mcp 调用均须报告状态");
					assert.equal(statuses[0], statuses[1]);
					assert.match(statuses[0]!, disabled ? /^ts_oht: disabled/ : /^ts_oht: connected, 1 tools/);
					assert.ok(statuses[0]!.includes(`(${scenario.expected.exposure})`));
					if (scenario.scope) {
						assert.ok(statuses[0]!.includes("overridden:"));
						assert.ok(statuses[0]!.includes(scenario.scope === "project" ? projectPath : globalPath));
					} else assert.ok(!statuses[0]!.includes("overridden:"));
					assert.equal(transports.length, disabled ? 0 : 1, "最多建立一次连接；/mcp 不得重新连接");
					const tool = session.getAllTools().find((tool) => tool.name === "mcp__ts_oht__lookup");
					if (disabled) assert.equal(tool, undefined);
					else {
						const captured = transports[0]!;
						assert.equal(captured.cwd, cwd);
						assert.equal(captured.entry.name, TS_OHT_NAME);
						assert.deepEqual(captured.entry.config, scenario.expected, "URL、暴露方式与超时必须完全取自优先配置，不得合并");
						assert.equal(captured.entry.scope, scenario.scope ?? "extension");
						assert.equal(captured.entry.source, scenario.scope === "project" ? projectPath : scenario.scope === "global" ? globalPath : entry);
						assert.equal(captured.server.starts, 1);
						assert.equal(captured.server.closes, 0);
						const methods = captured.server.messages.flatMap((message) => "method" in message ? [message.method] : []);
						assert.deepEqual(methods.slice(0, 2), ["initialize", "notifications/initialized"]);
						for (const method of ["initialize", "tools/list"])
							assert.equal(methods.filter((name) => name === method).length, 1, `即使调用两次 /mcp，${method} 也只能执行一次`);
						// Pi 1.2 声明资源支持，但不立即枚举。
						for (const method of ["resources/list", "resources/templates/list"])
							assert.ok(methods.filter((name) => name === method).length <= 1, `不得重复调用 ${method}`);
						assert.ok(captured.server.messages.some((message) => "id" in message && message.id === "server-ping" && "result" in message));
						if (scenario.expected.exposure === "codemode")
							assert.ok(["deferred", "codemode"].includes(tool?.exposure ?? ""), "Pi 1.1/1.2 间均采用间接暴露");
						else assert.equal(tool?.exposure, scenario.expected.exposure);
						assert.equal(tool?.annotations?.readOnlyHint, true);
						assert.ok(session.getAllTools().some((tool) => tool.name === "list_mcp_resources"));
					}
					assert.deepEqual(session.messages, [], "斜杠命令不得启动任何代理轮次");
				} finally {
					// dispose() 会使上下文失效，但不等待 MCP 关闭。
					// 替换文件或环境前，先等待真实运行器的生命周期处理完成。
					try { await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); }
					finally { session?.dispose(); }
				}
				assert.deepEqual(lifecycle.slice(1), ["shutdown:quit"]);
				for (const { server } of transports) assert.equal(server.closes, 1, "关闭时每个传输只能关闭一次");
				assert.deepEqual(errors, [], "真实运行器不得吞掉 MCP 生命周期错误");
				assert.deepEqual(snapshot(protectedPaths), before, "不得改写或创建测试夹具的 MCP、设置或认证文件");
				assert.deepEqual(sandbox.requests, [], "不得发起模型请求");
				assert.equal(sandbox.catalogCalls, 0, "不得发起模型目录请求");
				assert.deepEqual(sandbox.blocked, [], "不得尝试意外 HTTP 或套接字访问，即使错误被捕获");
			});
		}
	} finally { sandbox.restore(); }
	assert.deepEqual({ ...process.env }, originalEnv);
	assert.equal(process.cwd(), originalCwd);
	assert.equal(globalThis.fetch, originalFetch);
});
