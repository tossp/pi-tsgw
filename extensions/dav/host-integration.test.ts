import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

test("登记阶段不加载可选 DAV 库，缺库仍可注册 deferred 工具", () => {
	const directory = mkdtempSync(join(tmpdir(), "dav-registration-"));
	try {
		const script = `
			import assert from "node:assert/strict";
			import { registerHooks } from "node:module";
			globalThis.fetch = () => { throw new Error("登记阶段禁止联网"); };
			let optionalImports = 0;
			const hooks = registerHooks({ resolve(specifier, context, next) {
				if (specifier === "davkit" || specifier.startsWith("davkit/")) {
					optionalImports++; throw new Error("登记阶段不得导入可选 DAV 库");
				}
				return next(specifier, context);
			} });
			const { registerDav } = await import(${JSON.stringify(new URL("./index.js", import.meta.url).href)});
			const tools = [];
			registerDav({ on() {}, registerTool(tool) { tools.push(tool); } }, { agentDir: ${JSON.stringify(directory)} });
			assert.ok(tools.length > 0);
			assert.ok(tools.every(tool => tool.exposure === "deferred" && tool.namespace?.name === "tsgw_dav"));
			assert.equal(optionalImports, 0);
			hooks.deregister();
		`;
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: directory, env: { HOME: directory, PI_CODING_AGENT_DIR: directory, PATH: process.env.PATH }, encoding: "utf8",
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

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
		let reads = 0;
		const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fixture//CN", "BEGIN:VEVENT", "UID:source",
			"DTSTAMP:20261111T000000Z", "DTSTART:20261112T090000Z", "RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261113T090000Z",
			"END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
		const repairSources = new Map<string, { raw: string; etag: string }>();
		for (const [prefix, kind] of [["event", "VEVENT"], ["todo", "VTODO"], ["journal", "VJOURNAL"]]) {
			repairSources.set(`https://dav.example.invalid/cal/repair-${prefix}.ics`, { etag: '"repair-source"',
				raw: ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//fixture//CN", `BEGIN:${kind}`, `UID:repair-${prefix}`,
					"DTSTAMP:20260101T090000", "DTSTART:20261112T090000Z", `END:${kind}`, "END:VCALENDAR", ""].join("\r\n") });
		}
		repairSources.set("https://dav.example.invalid/ab/repair.vcf", { etag: '"repair-source"', raw: ["BEGIN:VCARD", "VERSION:4.0",
			"UID;VALUE=text:repair-contact", "FN:合成修复联系人", "REV:synthetic-invalid", "END:VCARD", ""].join("\r\n") });
		const guardedFetch = globalThis.fetch;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${TEST_ROOT}/v1/responses` && script !== undefined) {
				const body = await request.json() as { tools: { name?: string; type?: string }[] };
				assert.ok(!body.tools.some(tool => tool.name?.startsWith("tsgw_dav_")));
				const tool = body.tools.find(tool => tool.name === "codemode")!;
				const code = script; script = undefined; return response(code, tool.type === "custom");
			}
			const repairSource = repairSources.get(request.url);
			if (repairSource) {
				if (request.method === "GET") { reads++; return new Response(repairSource.raw, { headers: { etag: repairSource.etag } }); }
				assert.equal(request.method, "PUT");
				assert.equal(request.headers.get("if-match"), repairSource.etag);
				const raw = await request.text();
				const validation = request.url.endsWith(".vcf")
					? (await import("davkit/vcard")).validateContact(raw) : (await import("davkit/ical")).validateCalendarResource(raw);
				assert.equal(validation.valid, true);
				repairSource.raw = raw; repairSource.etag = '"repair-updated"'; writes++;
				return new Response(null, { status: 204, headers: { etag: repairSource.etag } });
			}
			if (request.url === "https://dav.example.invalid/.well-known/caldav") {
				davRequests++; assert.equal(request.method, "PROPFIND");
				assert.equal(request.headers.get("authorization"), `Basic ${Buffer.from("fixture:fixture-secret").toString("base64")}`);
				return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendar/</d:href><d:propstat><d:prop><d:resourcetype><c:calendar/></d:resourcetype><d:displayname>合成集合</d:displayname></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>', { status: 207 });
			}
			if (request.url === "https://dav.example.invalid/cal/source.ics" && request.method === "GET") {
				reads++; return new Response(calendar, { status: 200, headers: { etag: '"source"' } });
			}
			if (request.url === "https://dav.example.invalid/cal/" && request.method === "REPORT") {
				reads++;
				return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/source.ics</d:href><d:propstat><d:prop><d:getetag>"source"</d:getetag><c:calendar-data><![CDATA[${calendar}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
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
		const original = await execute('text(await tools.tsgw_dav_event_get({account:"work",resourceUrl:"https://dav.example.invalid/cal/source.ics",raw:true}));');
		assert.match(original, /UID:source/); assert.match(original, /rawSource/); assert.match(original, /source/);
		const incomplete = await execute('text(await tools.tsgw_dav_event_list({account:"work",collectionUrl:"https://dav.example.invalid/cal/",start:"2026-11-12T00:00:00Z",end:"2026-11-13T00:00:00Z",timeZone:"UTC"}));');
		assert.match(incomplete, /"resourcesComplete"\s*:\s*true/);
		assert.match(incomplete, /"complete"\s*:\s*false/); assert.match(incomplete, /unresolvedResources/);
		assert.equal(reads, 2);
		const refused = await execute('text(await tools.tsgw_dav_contact_create({account:"work",collectionUrl:"https://dav.example.invalid/ab/",name:"合成联系人",properties:["BDAY:20261340"]}));');
		assert.match(refused, /CONTENT_VALIDATION_FAILED/); assert.equal(writes, 1);
		const beforeRepairReads = reads;
		const unconfirmed = await execute('text(await tools.tsgw_dav_event_update({account:"work",resourceUrl:"https://dav.example.invalid/cal/repair-event.ics",uid:"repair-event",etag:"\\\"repair-source\\\""}));');
		assert.match(unconfirmed, /REPAIR_UNSUPPORTED/); assert.equal(writes, 1);
		const repaired = await execute('const identity={account:"work",etag:"\\\"repair-source\\\""}; const revisionRepair={dtstamp:"20260101T010000Z"}; text(await Promise.all([tools.tsgw_dav_event_update({...identity,resourceUrl:"https://dav.example.invalid/cal/repair-event.ics",uid:"repair-event",revisionRepair}),tools.tsgw_dav_todo_update({...identity,resourceUrl:"https://dav.example.invalid/cal/repair-todo.ics",uid:"repair-todo",revisionRepair}),tools.tsgw_dav_journal_update({...identity,resourceUrl:"https://dav.example.invalid/cal/repair-journal.ics",uid:"repair-journal",revisionRepair}),tools.tsgw_dav_contact_update({...identity,resourceUrl:"https://dav.example.invalid/ab/repair.vcf",uid:"repair-contact",revisionRepair:{rev:null}})]));');
		assert.equal((repaired.match(/"outcome"\s*:\s*"updated"/g) ?? []).length, 4);
		assert.equal(writes, 5); assert.equal(reads, beforeRepairReads + 5);
		const beforeInvalid = reads;
		const invalidRepair = await execute('try { await tools.tsgw_dav_event_update({account:"work",resourceUrl:"https://dav.example.invalid/cal/repair-event.ics",uid:"repair-event",etag:"\\\"repair-updated\\\"",revisionRepair:{force:true}}); text({schemaRejected:false}); } catch { text({schemaRejected:true}); }');
		assert.match(invalidRepair, /"schemaRejected"\s*:\s*true/);
		assert.equal(reads, beforeInvalid); assert.equal(writes, 5);
		await session.reload(); assert.deepEqual(loader.getExtensions().errors, []);
		assert.ok(davTools().some(tool => tool.name === "tsgw_dav_accounts"));
		assert.match(await execute('text(await tools.tsgw_dav_accounts({}));'), /work/);
		assert.equal(davRequests, 1); assert.deepEqual(errors, []); assert.deepEqual(sandbox.blocked, []);
	} finally { try { host?.dispose(); } finally { sandbox.restore(); } }
});
