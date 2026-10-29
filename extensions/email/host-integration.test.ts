import assert from "node:assert/strict";
import { existsSync, chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionError } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";

function scriptResponse(code: string, custom: boolean): Response {
	const item = custom
		? { id: "ctc_email", type: "custom_tool_call", call_id: "call_email", name: "codemode", input: code, status: "completed" }
		: { id: "fc_email", type: "function_call", call_id: "call_email", name: "codemode", arguments: JSON.stringify({ code }), status: "completed" };
	const events = [
		{ type: "response.created", response: { id: "resp_email", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: custom ? { ...item, input: "" } : { ...item, arguments: "" } },
		custom ? { type: "response.custom_tool_call_input.delta", output_index: 0, delta: code }
			: { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify({ code }) },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_email", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

function sourceModule(): string {
	let root = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const path = join(root, "package.json");
		if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === "pi-tsgw")
			return join(root, "extensions/email/index.ts");
		const parent = dirname(root);
		assert.notEqual(parent, root);
		root = parent;
	}
}

// SDK、扩展加载器与 codemode VM 均用真实实现；只用临时配置，网络套接字被全面阻断。
test("真实 Pi：配置门控、全部 codemode-only、按需发现调用与重载撤下", { timeout: 60_000 }, async t => {
	const module = sourceModule();
	const sandbox = new HostSandbox();
	let host: AgentSession | undefined;
	try {
		const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const entry = join(sandbox.cwd, "email-fixture.ts");
		writeFileSync(entry, `import { registerEmail } from ${JSON.stringify(module)};\nexport default registerEmail;\n`);
		const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" });
		const loader = new DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [createCodemodeExtension(), pi => {
				pi.registerProvider("email-fixture", { baseUrl: `${TEST_ROOT}/v1`, api: "openai-responses", apiKey: TEST_KEY,
					models: [{ id: "fixture", name: "邮件隔离测试", input: ["text"], reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
			}] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"), modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
		({ session: host } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
			resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd), tools: ["+codemode"] }));
		const errors: ExtensionError[] = [];
		await host.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
		const session = host;
		const emailTools = () => session.getAllTools().filter(tool => tool.name.startsWith("tsgw_email_"));
		let script: string | undefined;
		const guardedFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${TEST_ROOT}/v1/responses` && script !== undefined) {
				const body = await request.json() as { tools: { name?: string; type?: string }[] };
				assert.ok(!body.tools.some(tool => tool.name?.startsWith("tsgw_email_")));
				const tool = body.tools.find(tool => tool.name === "codemode");
				assert.ok(tool);
				const code = script; script = undefined;
				return scriptResponse(code, tool.type === "custom");
			}
			return guardedFetch(request);
		};
		const execute = async (code: string) => {
			await runtime.setRuntimeApiKey("email-fixture", TEST_KEY);
			await session.setModel(runtime.getModel("email-fixture", "fixture")!);
			script = code;
			await session.prompt("运行邮件隔离测试脚本");
			const result = [...session.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "codemode");
			assert.ok(result && result.role === "toolResult");
			assert.notEqual(result.isError, true, JSON.stringify(result));
			return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		};
		const path = join(sandbox.agentDir, "tsgw-email.json");

		await t.test("无文件时完全不注册，不为邮件建磁盘缓存", async () => {
			assert.deepEqual(emailTools(), []);
			assert.equal(existsSync(join(sandbox.agentDir, "cache/tsgw-email")), false);
			const output = await execute('text({absent:(await describeNamespace("tsgw_email"))===undefined});');
			assert.match(output, /"absent":true/);
		});
		await t.test("有效配置后只注册 codemode 工具，模型可见工具与声明均不包含邮件 schema", async () => {
			writeFileSync(path, JSON.stringify({
				imap: { aliases: { host: "imap.example.invalid", port: 993, tls: "implicit", user: "synthetic-login", password: "synthetic-secret-imap", trashMailbox: "Trash", junkMailbox: "Junk" } },
				smtp: { outbound: { host: "smtp.example.invalid", port: 587, tls: "starttls", user: "synthetic-smtp-login", password: "synthetic-secret-smtp", fromAddress: "sender@example.invalid" } },
				defaultSmtp: "outbound",
			}), { mode: 0o600 });
			chmodSync(path, 0o600);
			await session.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			assert.equal(emailTools().length, 14);
			for (const tool of emailTools()) {
				assert.equal(tool.exposure, "deferred");
				assert.equal(tool.namespace?.name, "tsgw_email");
				assert.equal(session.getActiveToolNames().includes(tool.name), false);
			}
			assert.equal(session.agent.state.tools.some(tool => tool.name.startsWith("tsgw_email_")), false);
			const codemode = session.agent.state.tools.find(tool => tool.name === "codemode")!;
			assert.ok(!codemode.description.includes("tsgw_email"));
			assert.ok(!codemode.description.includes("uidValidity"), "命名空间不应把逐工具 schema 内联到上下文");
			assert.ok(!codemode.description.includes("trashMailbox"));
		});
		await t.test("真实 codemode 按需发现命名空间并取得结构化账户信息，凭据不进入输出", async () => {
			const output = await execute('const ns=await describeNamespace("tsgw_email"); const r=await tools.tsgw_email_accounts({}); text({namespace:ns.name,count:ns.tools.length,result:r});');
			assert.match(output, /"namespace":"tsgw_email"/);
			assert.match(output, /"ok":true/);
			assert.match(output, /"aliases"/);
			assert.match(output, /"outbound"/);
			assert.ok(!output.includes("synthetic-secret"));
			assert.ok(!output.includes("synthetic-login"));
			assert.ok(!output.includes("imap.example.invalid"));
		});
		await t.test("codemode 嵌套调用经过真实宿主 schema 验证，不因错误参数接触邮箱", async () => {
			const output = await execute('let rejected=0; for(const [name,args] of [["tsgw_email_purge",{account:"aliases",mailbox:"Trash",uidValidity:"1",uids:[]}],["tsgw_email_read",{account:"aliases",mailbox:"INBOX",uidValidity:"1",uid:"*"}],["tsgw_email_send",{to:["recipient@example.invalid"],subject:"fixture",text:"body",raw:"unapproved"}]]) {try {await tools[name](args);} catch {rejected++;}} text({rejected});');
			assert.match(output, /"rejected":3/);
			assert.deepEqual(sandbox.blocked, []);
		});
		await t.test("移除配置并重载后撤下工具；无效文件也不会留下旧工具", async () => {
			rmSync(path);
			await session.reload();
			assert.deepEqual(emailTools(), []);
			assert.ok(!session.agent.state.tools.find(tool => tool.name === "codemode")!.description.includes("tsgw_email"));
			writeFileSync(path, '{"password":"do-not-echo-broken-config"', { mode: 0o600 });
			await session.reload();
			assert.deepEqual(emailTools(), []);
		});
		assert.deepEqual(errors, []);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { host?.dispose(); } finally { sandbox.restore(); }
	}
});
