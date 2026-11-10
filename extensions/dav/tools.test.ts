import assert from "node:assert/strict";
import fs, { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Compile } from "typebox/compile";
import { registerDav, supportsDavTools } from "./index.ts";

const config = { dav: { work: { url: "https://dav.example.invalid/", user: "synthetic-login", password: "synthetic-secret" } } };
const card = "BEGIN:VCARD\r\nVERSION:4.0\r\nUID;VALUE=text:card-id\r\nFN:合成联系人\r\nEMAIL:test@example.invalid\r\nNOTE:不进列表\r\nEND:VCARD\r\n";
const xmlText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const report = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:response><d:href>/ab/not-the-uid.vcf</d:href><d:propstat><d:prop><d:getetag>"v1"</d:getetag><c:address-data>${xmlText(card)}</c:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

function harness(dir: string, fetchImpl?: typeof fetch, version = "1.2.0") {
	const tools = new Map<string, ToolDefinition<any>>();
	const handlers = new Map<string, (() => unknown)[]>();
	const warnings: string[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition<any>) => tools.set(tool.name, tool),
		on: (event: string, fn: (...args: any[]) => unknown) => handlers.set(event, [...handlers.get(event) ?? [], () => fn({}, { ui: { notify: (m: string) => warnings.push(m) } })]),
	} as unknown as ExtensionAPI;
	return {
		tools, warnings,
		register: () => registerDav(pi, { agentDir: dir, fetch: fetchImpl, version }),
		async emit(event: string) { for (const fn of handlers.get(event) ?? []) await fn(); },
		async execute(name: string, input: unknown = {}, signal?: AbortSignal) {
			const tool = tools.get(`tsgw_dav_${name}`)!;
			assert.ok(tool && Compile(tool.parameters).Check(input), "测试输入须通过真实参数 schema");
			const result = await tool.execute("dav-fixture", input, signal, undefined, {} as ExtensionToolContext);
			assert.ok(Compile(tool.outputSchema!).Check(result.structuredContent));
			return result as typeof result & { structuredContent: { ok: boolean; data?: any; error?: { code: string; message: string; details?: Record<string, unknown> } } };
		},
	};
}
function save(dir: string, value: unknown) {
	const path = join(dir, "tsgw.json");
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
	chmodSync(path, 0o600);
}

test("兼容宿主始终 deferred 注册，注册和 session_start 不读取文件或发网络", async t => {
	const dir = mkdtempSync(join(tmpdir(), "dav-register-"));
	const read = t.mock.method(fs, "readFileSync", () => { throw new Error("不应读取文件"); });
	const stat = t.mock.method(fs, "statSync", () => { throw new Error("不应检查文件"); });
	syncBuiltinESMExports();
	try {
		const h = harness(dir, async () => { throw new Error("不应连接服务"); });
		h.register(); await h.emit("session_start");
		assert.equal(read.mock.calls.length, 0); assert.equal(stat.mock.calls.length, 0);
		assert.ok(h.tools.has("tsgw_dav_event_list") && h.tools.has("tsgw_dav_contact_get"));
		assert.ok(h.tools.has("tsgw_dav_contact_search") && h.tools.has("tsgw_dav_event_delete"));
		for (const tool of h.tools.values()) {
			assert.equal(tool.exposure, "deferred"); assert.equal(tool.namespace?.name, "tsgw_dav");
			assert.equal(tool.annotations?.readOnlyHint, !/_(create|update|delete)$/.test(tool.name));
			assert.equal(tool.annotations?.destructiveHint, /_(update|delete)$/.test(tool.name));
		}
	} finally { read.mock.restore(); stat.mock.restore(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
	for (const version of ["1.1.9", "1.2.0-rc.1", "bad"]) assert.equal(supportsDavTools(version), false);
	for (const version of ["1.2.0", "1.4.0", "2.0.0"]) assert.equal(supportsDavTools(version), true);
	const old = harness(dir, undefined, "1.1.0"); old.register(); await old.emit("session_start");
	assert.equal(old.tools.size, 0); assert.match(old.warnings[0]!, /Pi 1\.2/);
});

test("缺配置可补齐后重试，不写文件、回显凭据或自动选择账户", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-missing-"));
	try {
		let calls = 0;
		const h = harness(dir, async () => { calls++; throw new Error(); }); h.register();
		assert.equal((await h.execute("accounts")).structuredContent.error?.code, "CONFIG_REQUIRED");
		assert.deepEqual(readdirSync(dir), []);
		save(dir, '{"password":"synthetic-broken-secret"');
		const invalid = await h.execute("accounts");
		assert.equal(invalid.structuredContent.error?.code, "CONFIG_INVALID");
		assert.doesNotMatch(JSON.stringify(invalid), /synthetic-broken-secret/);
		save(dir, config);
		const accounts = await h.execute("accounts");
		assert.deepEqual(accounts.structuredContent, { ok: true, data: { accounts: { work: {} } } });
		assert.doesNotMatch(JSON.stringify(accounts), /synthetic|example\.invalid/);
		assert.equal((await h.execute("collections", { account: "unknown", kind: "calendar" })).structuredContent.error?.code, "ACCOUNT_NOT_FOUND");
		assert.equal(calls, 0);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("真实库查询与 GET：保留实际资源 URL、版本和属性，默认不输出原文", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-read-"));
	try {
		save(dir, config);
		const requests: string[] = [];
		const h = harness(dir, async (url, init) => {
			requests.push(`${init!.method} ${url}`);
			return init!.method === "REPORT" ? new Response(report, { status: 207 })
				: new Response(card, { status: 200, headers: { etag: '"v1"', "content-type": "text/vcard" } });
		}); h.register();
		const list = await h.execute("contact_list", { account: "work", collectionUrl: "https://dav.example.invalid/ab/" });
		assert.equal(list.structuredContent.ok, true);
		assert.equal(list.structuredContent.data.complete, true);
		const resourceUrl = list.structuredContent.data.items[0].resourceUrl;
		assert.equal(resourceUrl, "https://dav.example.invalid/ab/not-the-uid.vcf");
		assert.doesNotMatch(JSON.stringify(list), /不进列表|BEGIN:VCARD/);
		const details = await h.execute("contact_get", { account: "work", resourceUrl, uid: "card-id" });
		assert.equal(details.structuredContent.data.etag, '"v1"');
		assert.ok(details.structuredContent.data.properties.some((p: any) => p.name === "NOTE"));
		assert.equal(details.structuredContent.data.raw, undefined);
		const raw = await h.execute("contact_get", { account: "work", resourceUrl, raw: true });
		assert.equal(raw.structuredContent.data.raw, card);
		assert.deepEqual(requests, ["REPORT https://dav.example.invalid/ab/", `GET ${resourceUrl}`, `GET ${resourceUrl}`]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("超过结果预算明确失败，不输出部分列表或敏感正文", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-budget-"));
	try {
		save(dir, config);
		const large = card.replace("不进列表", "synthetic-private-body".repeat(8000));
		const h = harness(dir, async () => new Response(large, { status: 200 })); h.register();
		const result = await h.execute("contact_get", { account: "work", resourceUrl: "https://dav.example.invalid/ab/large.vcf", raw: true });
		assert.equal(result.structuredContent.error?.code, "RESULT_TOO_LARGE");
		assert.equal(result.structuredContent.data, undefined);
		assert.doesNotMatch(JSON.stringify(result), /synthetic-private-body|BEGIN:VCARD/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("会话关闭取消进行中读取，预取消不连接，重启后本地账户可重新调用", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-cancel-"));
	try {
		save(dir, config);
		let started!: () => void;
		const ready = new Promise<void>(resolve => { started = resolve; });
		let calls = 0;
		const h = harness(dir, async (_url, init) => {
			calls++; started();
			return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("private")), { once: true }));
		}); h.register();
		const pre = new AbortController(); pre.abort();
		assert.equal((await h.execute("collections", { account: "work", kind: "calendar" }, pre.signal)).structuredContent.error?.code, "ABORTED");
		assert.equal(calls, 0);
		const pending = h.execute("collections", { account: "work", kind: "calendar" });
		await ready; await h.emit("session_shutdown");
		assert.equal((await pending).structuredContent.error?.code, "ABORTED");
		assert.equal((await h.execute("accounts")).structuredContent.error?.code, "SESSION_CLOSED");
		await h.emit("session_start"); assert.equal((await h.execute("accounts")).structuredContent.ok, true);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("日历三类型创建响应丢失时保留生成身份，floating 资源无需时区或列表即可直接回读", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-calendar-unknown-"));
	try {
		save(dir, config);
		for (const [prefix, kind, fields] of [["event", "VEVENT", { start: "20261112T090000" }],
			["todo", "VTODO", {}], ["journal", "VJOURNAL", { date: "20261112" }]] as const) {
			let stored = "", savedUrl = "";
			const methods: string[] = [];
			const h = harness(dir, async (url, init) => {
				methods.push(init!.method!);
				if (init!.method === "PUT") {
					stored = String(init!.body); savedUrl = String(url);
					throw new Error("synthetic-private-lost-response");
				}
				assert.equal(init!.method, "GET"); assert.equal(String(url), savedUrl);
				return new Response(stored, { status: 200, headers: { etag: '\"saved\"' } });
			}); h.register();
			const unknown = await h.execute(`${prefix}_create`, { account: "work", collectionUrl: "https://dav.example.invalid/cal/",
				summary: "合成创建", ...fields });
			assert.equal(unknown.structuredContent.error?.code, "REMOTE_RESULT_UNKNOWN");
			const details = unknown.structuredContent.error!.details!;
			assert.equal(details.account, "work"); assert.equal(details.kind, kind);
			assert.equal(details.method, "PUT"); assert.equal(details.resourceUrl, savedUrl);
			assert.equal(typeof details.uid, "string");
			assert.ok(stored.includes(`UID:${details.uid}\r\n`));
			assert.doesNotMatch(JSON.stringify(unknown), /synthetic-private|synthetic-secret|synthetic-login|BEGIN:VCALENDAR|合成创建/);
			const read = await h.execute(`${prefix}_get`, { account: details.account, resourceUrl: details.resourceUrl, uid: details.uid });
			assert.equal(read.structuredContent.ok, true);
			assert.equal(read.structuredContent.data.uid, details.uid);
			assert.equal(read.structuredContent.data.etag, '\"saved\"');
			assert.deepEqual(methods, ["PUT", "GET"]);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("工具层保持已确认写入成功；远端结果未知保留目标用于核对", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-write-result-"));
	try {
		save(dir, config);
		const input = { account: "work", collectionUrl: "https://dav.example.invalid/ab/", name: "合成联系人" };
		const controller = new AbortController();
		const methods: string[] = [];
		const h = harness(dir, async (_url, init) => {
			methods.push(init!.method!);
			assert.equal(new Headers(init!.headers).get("if-none-match"), "*");
			return new Response(new ReadableStream({ cancel() { controller.abort(); } }), {
				status: 201, headers: { etag: '\"created\"' },
			});
		}); h.register();
		const result = await h.execute("contact_create", input, controller.signal);
		assert.equal(controller.signal.aborted, true);
		assert.equal(result.structuredContent.ok, true);
		assert.equal(result.structuredContent.data.outcome, "created");
		assert.equal(result.structuredContent.data.etag, '\"created\"');
		assert.deepEqual(methods, ["PUT"]);
		let requests = 0;
		const unknown = harness(dir, async () => { requests++; throw new Error("synthetic-private-failure"); }); unknown.register();
		const uncertain = await unknown.execute("contact_create", input);
		assert.equal(uncertain.isError, true);
		assert.equal(uncertain.structuredContent.error?.code, "REMOTE_RESULT_UNKNOWN");
		const details = uncertain.structuredContent.error?.details;
		assert.equal(details?.account, "work");
		assert.ok(typeof details?.uid === "string");
		assert.match(details.uid, /^[0-9a-f-]{36}$/i);
		assert.equal(details.method, "PUT");
		assert.ok(typeof details?.resourceUrl === "string");
		assert.match(details.resourceUrl, /^https:\/\/dav\.example\.invalid\/ab\/[^/]+\.vcf$/);
		assert.doesNotMatch(JSON.stringify(uncertain), /synthetic-private|synthetic-secret|synthetic-login/);
		assert.equal(requests, 1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
