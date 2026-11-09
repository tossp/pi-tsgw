import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "./config.ts";

// 只操作临时合成目录，不读取个人配置、迁移凭据或请求网络。
const imap = {
	host: "imap.example.invalid", port: 993, tls: "implicit", user: "synthetic-imap-login",
	password: " synthetic-imap-secret/\"ü ", trashMailbox: "Trash", junkMailbox: "Junk",
};
const smtp = {
	host: "smtp.example.invalid", port: 587, tls: "starttls", user: "synthetic-smtp-login",
	password: " synthetic-smtp-secret ", fromAddress: "sender@example.invalid",
};
const config = () => ({ imap: { work: { ...imap } }, smtp: { work: { ...smtp } } });

function sandbox(run: (agentDir: string, root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "tsgw-config-"));
	try { run(join(root, "agent"), root); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

function writeConfig(agentDir: string, value: unknown, mode = 0o600): string {
	mkdirSync(agentDir, { recursive: true });
	const path = join(agentDir, "tsgw.json");
	writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), { mode });
	chmodSync(path, mode);
	return path;
}

function invalidMessage(kind: "imap" | "smtp", agentDir: string): string {
	const result = readConfig(kind, agentDir);
	assert.equal(result.status, "invalid");
	assert.ok(result.status === "invalid");
	return result.message;
}

function assertSafe(message: string): void {
	for (const secret of [imap.password, smtp.password, imap.user, smtp.user, imap.host, smtp.host,
		"synthetic-sensitive-key", "synthetic-sensitive-value", "synthetic-account-id"])
		assert.ok(!message.includes(secret), "错误不得回显合成凭据、账户 ID 或未知字段");
}

test("缺文件不创建目录或配置，缺组和空映射返回 missing", () => sandbox((agentDir, root) => {
	for (const kind of ["imap", "smtp"] as const) assert.deepEqual(readConfig(kind, agentDir), { status: "missing" });
	assert.deepEqual(readdirSync(root), []);
	mkdirSync(agentDir);
	assert.deepEqual(readConfig("imap", agentDir), { status: "missing" });
	assert.deepEqual(readdirSync(agentDir), []);
	for (const value of [{}, { imap: {}, smtp: {} }, { dav: { unused: true } }]) {
		const path = writeConfig(agentDir, value);
		const before = readFileSync(path, "utf8");
		for (const kind of ["imap", "smtp"] as const) assert.deepEqual(readConfig(kind, agentDir), { status: "missing" });
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(readdirSync(agentDir), ["tsgw.json"]);
	}
}));

test("读取 0600 的 UTF-8 与 BOM 文件，返回请求类型而非完整凭据对象", () => sandbox(agentDir => {
	for (const prefix of ["", "\uFEFF"]) {
		const path = writeConfig(agentDir, `${prefix}${JSON.stringify(config(), null, 2)}\n`);
		const before = readFileSync(path, "utf8");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const result = readConfig("imap", agentDir);
		assert.ok(result.status === "ready");
		assert.deepEqual(result.config, { work: imap });
		const outgoing = readConfig("smtp", agentDir);
		assert.ok(outgoing.status === "ready");
		assert.deepEqual(outgoing.config, { work: { ...smtp, allowSenderOverride: false } });
		assert.equal(readFileSync(path, "utf8"), before);
		assert.deepEqual(readdirSync(agentDir), ["tsgw.json"]);
	}
}));

test("只校验所请求协议；另一协议无效与 DAV 内容都不阻止有效类型", () => sandbox(agentDir => {
	for (const bad of [null, [], 7, "synthetic-sensitive-value", { "synthetic-account-id": { password: smtp.password } }]) {
		writeConfig(agentDir, { imap: { work: imap }, smtp: bad, dav: null });
		assert.equal(readConfig("imap", agentDir).status, "ready");
		assertSafe(invalidMessage("smtp", agentDir));
		writeConfig(agentDir, { imap: bad, smtp: { work: smtp }, dav: { arbitrary: "synthetic-sensitive-value" } });
		assert.equal(readConfig("smtp", agentDir).status, "ready");
		assertSafe(invalidMessage("imap", agentDir));
	}
	writeConfig(agentDir, { smtp: null });
	assert.deepEqual(readConfig("imap", agentDir), { status: "missing" });
}));

test("跨协议可使用同名 ID，各自返回本组账户，不合并或推断逐条 type", () => sandbox(agentDir => {
	writeConfig(agentDir, { ...config(), dav: { work: { password: "synthetic-dav-secret" } } });
	const inbound = readConfig("imap", agentDir);
	const outgoing = readConfig("smtp", agentDir);
	assert.ok(inbound.status === "ready" && outgoing.status === "ready");
	assert.deepEqual(Object.keys(inbound.config), ["work"]);
	assert.deepEqual(Object.keys(outgoing.config), ["work"]);
	assert.equal(inbound.config.work!.host, imap.host);
	assert.equal(outgoing.config.work!.host, smtp.host);
	writeConfig(agentDir, { imap: { work: { ...imap, type: "imap" } } });
	assertSafe(invalidMessage("imap", agentDir));
}));

test("未知根字段、旧 defaultSmtp 与 email 包装拒绝，错误不包含键值", () => sandbox(agentDir => {
	for (const extra of [
		{ "synthetic-sensitive-key": "synthetic-sensitive-value" },
		{ defaultSmtp: "synthetic-sensitive-value" },
		{ email: config() },
	]) {
		writeConfig(agentDir, { ...config(), ...extra });
		for (const kind of ["imap", "smtp"] as const) {
			const message = invalidMessage(kind, agentDir);
			assertSafe(message);
			assert.ok(!message.includes(Object.keys(extra)[0]!), "未知根字段名也不得进入错误");
		}
	}
}));

test("旧配置文件既不读取也不迁移，有新文件时不参与优先级", () => sandbox(agentDir => {
	mkdirSync(agentDir);
	const legacy = ["tsgw-email.json", "email-config.json"];
	for (const name of legacy) writeFileSync(join(agentDir, name), '{"password":"synthetic-legacy-secret"', { mode: 0o600 });
	for (const kind of ["imap", "smtp"] as const) assert.deepEqual(readConfig(kind, agentDir), { status: "missing" });
	assert.deepEqual(readdirSync(agentDir).sort(), [...legacy].sort());
	writeConfig(agentDir, config());
	assert.equal(readConfig("imap", agentDir).status, "ready");
	assert.equal(readConfig("smtp", agentDir).status, "ready");
	for (const name of legacy) assert.equal(readFileSync(join(agentDir, name), "utf8"), '{"password":"synthetic-legacy-secret"');
	assert.deepEqual(readdirSync(agentDir).sort(), [...legacy, "tsgw.json"].sort());
}));

test("非 0600 权限无效且不自动修正", () => sandbox(agentDir => {
	for (const mode of [0o644, 0o660, 0o400]) {
		const path = writeConfig(agentDir, config(), mode);
		for (const kind of ["imap", "smtp"] as const) assertSafe(invalidMessage(kind, agentDir));
		assert.equal(statSync(path).mode & 0o777, mode);
	}
}));

test("非普通文件、空文件、非法 JSON 与非对象根均安全拒绝", () => sandbox(agentDir => {
	const path = join(agentDir, "tsgw.json");
	mkdirSync(path, { recursive: true });
	assertSafe(invalidMessage("imap", agentDir));
	rmSync(path, { recursive: true });
	for (const value of ["", '{"password":"synthetic-sensitive-value"', "null", "[]", "true", "42", '"synthetic-sensitive-value"']) {
		writeConfig(agentDir, value);
		for (const kind of ["imap", "smtp"] as const) {
			const message = invalidMessage(kind, agentDir);
			assertSafe(message);
			assert.ok(!message.includes("Unexpected"), "不转发 JSON.parse 原始错误");
		}
	}
}));
