import assert from "node:assert/strict";
import fs, { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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

function writeConfig(dir: string, value: unknown): void {
	const path = join(dir, "tsgw.json");
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
	chmodSync(path, 0o600);
}

function errorCode(result: { structuredContent?: unknown }): string | undefined {
	return (result.structuredContent as { error?: { code: string } })?.error?.code;
}

test("注册和 session_start 不访问配置文件，所有工具仍 deferred 注册", async t => {
	const dir = mkdtempSync(join(tmpdir(), "email-no-config-io-"));
	const h = harness();
	const read = t.mock.method(fs, "readFileSync", () => { throw new Error("配置不可在注册阶段读取"); });
	const stat = t.mock.method(fs, "statSync", () => { throw new Error("配置不可在注册阶段检查"); });
	syncBuiltinESMExports();
	try {
		await registerEmail(h.pi, { agentDir: dir });
		await h.emit("session_start");
		assert.equal(read.mock.calls.length, 0);
		assert.equal(stat.mock.calls.length, 0);
		assert.ok(h.tools.has("tsgw_email_accounts") && h.tools.has("tsgw_email_send"));
		assert.ok([...h.tools.values()].every(tool => tool.exposure === "deferred"));
	} finally {
		read.mock.restore(); stat.mock.restore(); syncBuiltinESMExports();
		await h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true });
	}
});

test("无配置仍注册 deferred 工具，实际调用才给配置指导且不创建文件", async () => {
	const dir = mkdtempSync(join(tmpdir(), "email-registration-"));
	const h = harness();
	try {
		await registerEmail(h.pi, { agentDir: dir });
		assert.ok(h.tools.has("tsgw_email_accounts") && h.tools.has("tsgw_email_send"));
		for (const tool of h.tools.values()) assert.equal(tool.exposure, "deferred");
		await h.emit("session_start");
		assert.deepEqual(h.warnings, []);
		for (const [name, args] of [["accounts", {}], ["mailboxes", { account: "inbound" }],
			["send", { to: ["to@example.invalid"], subject: "fixture", text: "body" }]] as const) {
			const result = await h.execute(name, args);
			assert.equal(errorCode(result), "CONFIG_REQUIRED");
			assert.match(JSON.stringify(result.structuredContent), /tsgw\.json/);
		}
		assert.deepEqual(readdirSync(dir), []);
	} finally { await h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
});

test("错误配置不影响注册且无启动提示，调用返回安全错误；旧宿主不直接暴露", async () => {
	const dir = mkdtempSync(join(tmpdir(), "email-registration-"));
	const invalid = harness();
	try {
		writeConfig(dir, '{"password":"sensitive-broken-input"');
		await registerEmail(invalid.pi, { agentDir: dir });
		assert.ok(invalid.tools.has("tsgw_email_accounts"));
		await invalid.emit("session_start");
		assert.deepEqual(invalid.warnings, []);
		const result = await invalid.execute("accounts");
		assert.equal(errorCode(result), "CONFIG_INVALID");
		assert.ok(!JSON.stringify(result).includes("sensitive-broken-input"));
		writeConfig(dir, rawConfig);
		const old = harness();
		await registerEmail(old.pi, { agentDir: dir, version: "0.82.0" });
		assert.equal(old.tools.size, 0);
		await old.emit("session_start");
		assert.match(old.warnings[0]!, /Pi 1\.2/);
	} finally { await invalid.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
	for (const version of ["0.82.0", "1.1.9", "1.2.0-rc.1", "invalid"]) assert.equal(supportsEmailTools(version), false);
	for (const version of ["1.2.0", "1.3.0", "2.0.0", "1.2.0+fixture"]) assert.equal(supportsEmailTools(version), true);
});

test("缺组与空组可补齐后原工具重试，不要求重新注册", async t => {
	const read = t.mock.method(EmailReader.prototype, "mailboxes", async () => ({ mailboxes: [] }));
	const send = t.mock.method(EmailSender.prototype, "send", async () => ({ status: "success" as const, smtp: "outbound", accepted: [], rejected: [] }));
	const dir = mkdtempSync(join(tmpdir(), "email-retry-"));
	const h = harness();
	try {
		await registerEmail(h.pi, { agentDir: dir });
		const original = h.tools.get("tsgw_email_mailboxes");
		for (const value of [{}, { imap: {}, smtp: {} }]) {
			writeConfig(dir, value);
			assert.equal(errorCode(await h.execute("mailboxes", { account: "inbound" })), "CONFIG_REQUIRED");
			assert.equal(errorCode(await h.execute("send", { to: ["to@example.invalid"], subject: "fixture", text: "body" })), "CONFIG_REQUIRED");
		}
		assert.equal(read.mock.calls.length, 0);
		assert.equal(send.mock.calls.length, 0);
		writeConfig(dir, rawConfig);
		assert.notEqual((await h.execute("mailboxes", { account: "inbound" })).isError, true);
		assert.notEqual((await h.execute("send", { to: ["to@example.invalid"], subject: "fixture", text: "body" })).isError, true);
		assert.equal(h.tools.get("tsgw_email_mailboxes"), original);
		assert.equal(read.mock.calls.length, 1);
		assert.equal(send.mock.calls.length, 1);
	} finally { await h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
});

test("协议按需独立加载，成功配置会话内复用，切换会话后重新加载", async t => {
	t.mock.method(EmailReader.prototype, "mailboxes", async () => ({ mailboxes: [] }));
	t.mock.method(EmailSender.prototype, "send", async () => ({ status: "success" as const, smtp: "outbound", accepted: [], rejected: [] }));
	const dir = mkdtempSync(join(tmpdir(), "email-protocol-"));
	const h = harness();
	const sendInput = { to: ["to@example.invalid"], subject: "fixture", text: "body" };
	try {
		writeConfig(dir, { imap: rawConfig.imap, smtp: null });
		await registerEmail(h.pi, { agentDir: dir });
		assert.notEqual((await h.execute("mailboxes", { account: "inbound" })).isError, true);
		assert.equal(errorCode(await h.execute("send", sendInput)), "CONFIG_INVALID");
		writeConfig(dir, { imap: null, smtp: rawConfig.smtp });
		assert.notEqual((await h.execute("send", sendInput)).isError, true);
		assert.notEqual((await h.execute("mailboxes", { account: "inbound" })).isError, true);
		writeConfig(dir, '{"password":"sensitive-broken-input"');
		assert.notEqual((await h.execute("send", sendInput)).isError, true);
		await h.emit("session_start");
		assert.equal(errorCode(await h.execute("mailboxes", { account: "inbound" })), "CONFIG_INVALID");
		assert.equal(errorCode(await h.execute("send", sendInput)), "CONFIG_INVALID");
	} finally { await h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
});

test("普通发送只需 SMTP，引用原邮件才要求 IMAP，补配置后可重试", async t => {
	const send = t.mock.method(EmailSender.prototype, "send", async () => ({ status: "success" as const, smtp: "outbound", accepted: [], rejected: [] }));
	const dir = mkdtempSync(join(tmpdir(), "email-reply-config-"));
	const h = harness();
	const input = { to: ["to@example.invalid"], subject: "fixture", text: "body" };
	const replyToMessage = { account: "inbound", mailbox: "INBOX", uidValidity: "1", uid: 1 };
	try {
		registerEmailTools(h.pi, undefined, dir);
		for (const [imap, expected] of [[undefined, "CONFIG_REQUIRED"], [{}, "CONFIG_REQUIRED"], [null, "CONFIG_INVALID"]] as const) {
			await h.emit("session_start");
			writeConfig(dir, { smtp: rawConfig.smtp, ...(imap === undefined ? {} : { imap }) });
			assert.notEqual((await h.execute("send", input)).isError, true);
			const sent = send.mock.calls.length;
			assert.equal(errorCode(await h.execute("send", { ...input, replyToMessage })), expected);
			assert.equal(send.mock.calls.length, sent, "缺少或无效 IMAP 时引用发送不得进入传输");
			writeConfig(dir, rawConfig);
			assert.notEqual((await h.execute("send", { ...input, replyToMessage })).isError, true);
			assert.equal(send.mock.calls.length, sent + 1);
		}
	} finally { await h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
});

test("账户发现保留有效协议并安全报告另一无效类型，缺 SMTP 时不输出默认出口", async () => {
	for (const kind of ["imap", "smtp"] as const) {
		const dir = mkdtempSync(join(tmpdir(), "email-accounts-"));
		const h = harness();
		try {
			writeConfig(dir, { [kind]: rawConfig[kind] });
			await registerEmail(h.pi, { agentDir: dir });
			const partial = await h.execute("accounts");
			assert.notEqual(partial.isError, true);
			const data = (partial.structuredContent as any).data;
			assert.ok(Object.keys(data[kind]).length > 0);
			assert.equal("defaultSmtp" in data, kind === "smtp");
			const other = kind === "imap" ? "smtp" : "imap";
			await h.emit("session_start");
			writeConfig(dir, { [kind]: rawConfig[kind], [other]: { "sensitive-account-key": { password: "sensitive-config-value" } } });
			const mixed = await h.execute("accounts");
			assert.notEqual(mixed.isError, true);
			assert.ok((mixed.structuredContent as any).data.configurationErrors);
			assert.ok(Object.keys((mixed.structuredContent as any).data[kind]).length > 0);
			assert.doesNotMatch(JSON.stringify(mixed), /sensitive-account-key|sensitive-config-value|dummy-secret|dummy-login|(?:imap|smtp)\.example\.invalid/);
		} finally { await h.emit("session_shutdown"); rmSync(dir, { recursive: true, force: true }); }
	}
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

test("账户发现展示规范化可用发件域，不泄露凭据或创建运行时", async t => {
	const disposed = t.mock.method(EmailCache.prototype, "dispose");
	const h = harness();
	registerEmailTools(h.pi, parseEmailConfig({ ...rawConfig, smtp: { outbound: {
		...rawConfig.smtp.outbound, allowSenderOverride: true, allowedFromDomains: ["EXAMPLE.INVALID", "屮.test"],
	} } }));
	const result = await h.execute("accounts");
	assert.deepEqual((result.structuredContent as any).data.smtp.outbound, {
		fromAddress: "sender@example.invalid", allowSenderOverride: true, allowedFromDomains: ["example.invalid", "xn--oht.test"],
	});
	assert.doesNotMatch(JSON.stringify(result), /dummy-secret|dummy-smtp-login|smtp\.example\.invalid/);
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
