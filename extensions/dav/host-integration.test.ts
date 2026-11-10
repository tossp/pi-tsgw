import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";

function modulePath(): string {
	let root = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const path = join(root, "package.json");
		if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === "pi-tsgw") return join(root, "extensions/dav/index.ts");
		const parent = dirname(root); assert.notEqual(parent, root); root = parent;
	}
}
function response(code: string, custom: boolean): Response {
	const item = custom
		? { id: "ctc_dav", type: "custom_tool_call", call_id: "call_dav", name: "codemode", input: code, status: "completed" }
		: { id: "fc_dav", type: "function_call", call_id: "call_dav", name: "codemode", arguments: JSON.stringify({ code }), status: "completed" };
	const events = [
		{ type: "response.created", response: { id: "resp_dav", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: custom ? { ...item, input: "" } : { ...item, arguments: "" } },
		custom ? { type: "response.custom_tool_call_input.delta", output_index: 0, delta: code }
			: { type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify({ code }) },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_dav", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("真实宿主：DAV 按需发现、缺配置重试、集合与写入调用及重载；不访问真实网络", { timeout: 60_000 }, async () => {
	const module = modulePath();
	const sandbox = new HostSandbox();
	let host: AgentSession | undefined;
	try {
		const { createAgentSession, createCodemodeExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
		const entry = join(sandbox.cwd, "dav-fixture.ts");
		writeFileSync(entry, `import { registerDav } from ${JSON.stringify(module)};\nexport default registerDav;\n`);
		const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off" });
		const loader = new DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [createCodemodeExtension(), pi => {
				pi.registerProvider("dav-fixture", { baseUrl: `${TEST_ROOT}/v1`, api: "openai-responses", apiKey: TEST_KEY,
					models: [{ id: "fixture", name: "DAV 隔离测试", input: ["text"], reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
			}] });
		await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"), modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
		({ session: host } = await createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
			resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd), tools: ["+codemode"] }));
		const errors: unknown[] = [];
		await host.bindExtensions({ mode: "print", onError: error => errors.push(error) });
		const session = host;
		const davTools = () => session.getAllTools().filter(tool => tool.name.startsWith("tsgw_dav_"));
		assert.ok(davTools().some(tool => tool.name === "tsgw_dav_collections"));
		assert.ok(davTools().every(tool => tool.exposure === "deferred" && tool.namespace?.name === "tsgw_dav"));
		assert.ok(!session.agent.state.tools.some(tool => tool.name.startsWith("tsgw_dav_")));
		let script: string | undefined;
		let davRequests = 0;
		let writes = 0;
		const guardedFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${TEST_ROOT}/v1/responses` && script !== undefined) {
				const body = await request.json() as { tools: { name?: string; type?: string }[] };
				assert.ok(!body.tools.some(tool => tool.name?.startsWith("tsgw_dav_")));
				const tool = body.tools.find(tool => tool.name === "codemode")!;
				const code = script; script = undefined; return response(code, tool.type === "custom");
			}
			if (request.url === "https://dav.example.invalid/.well-known/caldav") {
				davRequests++; assert.equal(request.method, "PROPFIND");
				assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("fixture:fixture-secret").toString("base64")}`);
				return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendar/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype><d:displayname>合成集合</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>', { status: 207 });
			}
			if (request.url.startsWith("https://dav.example.invalid/ab/") && request.method === "PUT") {
				writes++;
				assert.equal(request.headers.get("if-none-match"), "*");
				const { parseContact } = await import("davkit/vcard");
				const contact = parseContact(await request.text());
				assert.ok(contact.uid);
				assert.ok(contact.properties.some(property => property.name === "REV"));
				return new Response(null, { status: 201, headers: { etag: '\"created\"' } });
			}
			return guardedFetch(request);
		};
		const execute = async (code: string) => {
			await runtime.setRuntimeApiKey("dav-fixture", TEST_KEY); await session.setModel(runtime.getModel("dav-fixture", "fixture")!);
			script = code; await session.prompt("运行 DAV 隔离脚本");
			const result = [...session.messages].reverse().find(message => message.role === "toolResult" && message.toolName === "codemode");
			assert.ok(result && result.role === "toolResult"); assert.notEqual(result.isError, true, JSON.stringify(result));
			return result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
		};
		const missing = await execute('const ns=await describeNamespace("tsgw_dav"); const r=await tools.tsgw_dav_accounts({}); text({namespace:ns.name,result:r});');
		assert.match(missing, /CONFIG_REQUIRED/); assert.match(missing, /tsgw_dav/); assert.equal(davRequests, 0);
		const path = join(sandbox.agentDir, "tsgw.json");
		writeFileSync(path, JSON.stringify({ dav: { work: { url: "https://dav.example.invalid/", user: "fixture", password: "fixture-secret" } } }), { mode: 0o600 });
		chmodSync(path, 0o600);
		const ready = await execute('text(await tools.tsgw_dav_collections({account:"work",kind:"calendar"}));');
		assert.match(ready, /合成集合/); assert.doesNotMatch(ready, /fixture-secret|Basic /); assert.equal(davRequests, 1);
		const created = await execute('text(await tools.tsgw_dav_contact_create({account:"work",collectionUrl:"https://dav.example.invalid/ab/",name:"合成联系人"}));');
		assert.match(created, /created/); assert.doesNotMatch(created, /fixture-secret|BEGIN:VCARD/); assert.equal(writes, 1);
		await session.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		assert.ok(davTools().some(tool => tool.name === "tsgw_dav_accounts"));
		assert.match(await execute('text(await tools.tsgw_dav_accounts({}));'), /work/);
		assert.equal(davRequests, 1); assert.deepEqual(errors, []); assert.deepEqual(sandbox.blocked, []);
	} finally { try { host?.dispose(); } finally { sandbox.restore(); } }
});
