import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseEmailConfig } from "./config.ts";
import { registerEmail, supportsEmailTools } from "./index.ts";
import { registerEmailTools } from "./tools.ts";
import { EmailCache } from "./cache.ts";
import { EmailReader } from "./reader.ts";
import { EmailSender } from "./smtp.ts";
import { EmailError } from "./types.ts";

const rawConfig = {
	imap: { inbound: { host: "imap.example.invalid", port: 993, tls: "implicit", user: "dummy-login", password: "dummy-secret-imap", trashMailbox: "Trash", junkMailbox: "Junk" } },
	smtp: { outbound: { host: "smtp.example.invalid", port: 587, tls: "starttls", user: "dummy-smtp-login", password: "dummy-secret-smtp", fromAddress: "sender@example.invalid" } },
	defaultSmtp: "outbound",
};

function harness(cwd = tmpdir()) {
	const tools = new Map<string, ToolDefinition<any>>();
	const handlers = new Map<string, (() => unknown)[]>();
	const warnings: string[] = [];
	const pi = {
		registerTool: (tool: ToolDefinition<any>) => { tools.set(tool.name, tool); },
		on: (name: string, fn: (...args: any[]) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(() => fn({}, { ui: { notify: (message: string) => warnings.push(message) } }));
			handlers.set(name, list);
		},
	} as unknown as ExtensionAPI;
	return {
		pi, tools, warnings,
		async emit(name: string) { for (const fn of handlers.get(name) ?? []) await fn(); },
		async execute(name: string, args: unknown = {}, signal?: AbortSignal) {
			const tool = tools.get(`tsgw_email_${name}`);
			assert.ok(tool);
			return tool.execute("email-fixture", args, signal, undefined, { cwd } as ExtensionToolContext);
		},
	};
}

test("无配置不注册邮件工具、生命周期或提示，也不创建任何文件", async () => {
	const dir = mkdtempSync(join(tmpdir(), "email-registration-"));
	try {
		const h = harness();
		await registerEmail(h.pi, { agentDir: dir });
		assert.equal(h.tools.size, 0);
		await h.emit("session_start");
		assert.deepEqual(h.warnings, []);
		assert.deepEqual(readdirSync(dir), []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("错误配置安全停用，旧宿主不退化成直接暴露", async () => {
	const dir = mkdtempSync(join(tmpdir(), "email-registration-"));
	try {
		const path = join(dir, "tsgw-email.json");
		writeFileSync(path, '{"password":"sensitive-broken-input"', { mode: 0o600 });
		chmodSync(path, 0o600);
		const invalid = harness();
		await registerEmail(invalid.pi, { agentDir: dir });
		assert.equal(invalid.tools.size, 0);
		await invalid.emit("session_start");
		assert.equal(invalid.warnings.length, 1);
		assert.ok(!invalid.warnings[0]!.includes("sensitive"));
		writeFileSync(path, JSON.stringify(rawConfig));
		const old = harness();
		await registerEmail(old.pi, { agentDir: dir, version: "0.82.0" });
		assert.equal(old.tools.size, 0);
		await old.emit("session_start");
		assert.match(old.warnings[0]!, /Pi 1\.2/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
	for (const version of ["0.82.0", "1.1.9", "1.2.0-rc.1", "invalid"]) assert.equal(supportsEmailTools(version), false);
	for (const version of ["1.2.0", "1.3.0", "2.0.0", "1.2.0+fixture"]) assert.equal(supportsEmailTools(version), true);
});

test("全部邮件工具统一前缀和 codemode 暴露，无独立回复、转发、存档或同步工具", async t => {
	const h = harness();
	registerEmailTools(h.pi, parseEmailConfig(rawConfig));
	t.after(() => h.emit("session_shutdown"));
	assert.equal(h.tools.size, 14);
	for (const [name, tool] of h.tools) {
		assert.ok(name.startsWith("tsgw_email_"));
		assert.equal(tool.exposure, "deferred");
		assert.equal(tool.namespace?.name, "tsgw_email");
		assert.equal(tool.promptGuidelines, undefined);
		assert.equal(tool.promptSnippet, undefined);
		assert.ok(tool.outputSchema);
	}
	for (const name of ["reply", "forward", "append", "sync", "setup"])
		assert.equal(h.tools.has(`tsgw_email_${name}`), false);
});

test("账户发现不泄露主机或认证，也不为库存查询初始化缓存", async t => {
	const disposed = t.mock.method(EmailCache.prototype, "dispose");
	const h = harness();
	registerEmailTools(h.pi, parseEmailConfig(rawConfig));
	const result = await h.execute("accounts");
	assert.deepEqual(result.structuredContent, {
		ok: true,
		data: { imap: { inbound: { trashMailbox: "Trash", junkMailbox: "Junk" } },
			smtp: { outbound: { fromAddress: "sender@example.invalid", allowSenderOverride: false } }, defaultSmtp: "outbound" },
	});
	const encoded = JSON.stringify(result);
	for (const secret of ["dummy-secret", "dummy-login", "dummy-smtp-login", "imap.example.invalid", "smtp.example.invalid"])
		assert.ok(!encoded.includes(secret));
	await h.emit("session_shutdown");
	assert.equal(disposed.mock.calls.length, 0);
});

test("缓存仅实际操作才建，切换与退出清理，旧调用不可重新创建运行时", async t => {
	const disposed = t.mock.method(EmailCache.prototype, "dispose");
	const read = t.mock.method(EmailReader.prototype, "mailboxes", async () => ({ mailboxes: [] }));
	const h = harness();
	registerEmailTools(h.pi, parseEmailConfig(rawConfig));
	await h.emit("session_start");
	assert.equal(disposed.mock.calls.length, 0);
	assert.equal((await h.execute("mailboxes", { account: "inbound" })).isError, undefined);
	await h.emit("session_shutdown");
	assert.equal(disposed.mock.calls.length, 1);
	await h.emit("session_shutdown");
	assert.equal(disposed.mock.calls.length, 1);
	assert.equal((await h.execute("mailboxes", { account: "inbound" })).isError, true);
	assert.equal(read.mock.calls.length, 1);
	await h.emit("session_start");
	await h.execute("mailboxes", { account: "inbound" });
	assert.equal(read.mock.calls.length, 2);
	await h.emit("session_start");
	assert.equal(disposed.mock.calls.length, 2);
	await h.emit("session_shutdown");
});

test("工具只透传安全错误，库原始内容不进入正文或结构化结果", async t => {
	const read = t.mock.method(EmailReader.prototype, "mailboxes", async () => { throw new Error("sensitive-server-response dummy-secret-imap"); });
	const h = harness();
	registerEmailTools(h.pi, parseEmailConfig(rawConfig));
	t.after(() => h.emit("session_shutdown"));
	const result = await h.execute("mailboxes", { account: "inbound" });
	assert.equal(result.isError, true);
	assert.ok(!JSON.stringify(result).includes("sensitive-server-response"));
	assert.ok(!JSON.stringify(result).includes("dummy-secret-imap"));
	read.mock.mockImplementation(async () => { throw new EmailError("STALE_MAILBOX", "文件夹身份已变化。"); });
	assert.deepEqual((await h.execute("mailboxes", { account: "inbound" })).structuredContent,
		{ ok: false, error: { code: "STALE_MAILBOX", message: "文件夹身份已变化。" } });
});

test("发送部分拒绝保留结构化结果，附件路径相对当前工作目录解析且不改原输入", async t => {
	const send = t.mock.method(EmailSender.prototype, "send", async () => ({ status: "partial" as const, smtp: "outbound", accepted: ["one@example.invalid"], rejected: ["two@example.invalid"] }));
	const cwd = mkdtempSync(join(tmpdir(), "email-send-path-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	writeFileSync(join(cwd, "report.txt"), "合成附件");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(cwd, "isolated-agent");
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	});
	const h = harness(cwd);
	registerEmailTools(h.pi, parseEmailConfig(rawConfig));
	t.after(() => h.emit("session_shutdown"));
	const input = { to: ["one@example.invalid"], subject: "fixture", text: "body", attachments: [{ path: "report.txt" }] };
	const result = await h.execute("send", input);
	assert.equal(result.isError, true);
	assert.equal((result.structuredContent as any).data.status, "partial");
	assert.equal((send.mock.calls[0]!.arguments as any)[0].attachments[0].path, join(cwd, "report.txt"));
	assert.equal(input.attachments[0]!.path, "report.txt");
});

test("预取消在进入业务处理前阻止，账户发现也不会继续执行", async t => {
	const read = t.mock.method(EmailReader.prototype, "mailboxes", async () => ({ mailboxes: [] }));
	const h = harness();
	registerEmailTools(h.pi, parseEmailConfig(rawConfig));
	t.after(() => h.emit("session_shutdown"));
	const result = await h.execute("mailboxes", { account: "inbound" }, AbortSignal.abort());
	assert.equal(result.isError, true);
	assert.equal((result.structuredContent as any).error.code, "ABORTED");
	assert.equal(read.mock.calls.length, 0);
});
