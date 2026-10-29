import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ImapFlow, ImapFlowOptions } from "imapflow";
import { ImapSessions } from "./imap-session.ts";
import { parseEmailConfig } from "./config.ts";

function config() {
	const account = { host: "imap.example.invalid", port: 993, tls: "implicit", user: "imap-user", password: "dummy-imap", trashMailbox: "Trash", junkMailbox: "Junk" };
	return parseEmailConfig({
		imap: { first: account, second: { ...account, tls: "starttls", port: 143 } },
		smtp: { outbound: { host: "smtp.example.invalid", port: 465, tls: "implicit", user: "smtp-user", password: "dummy-smtp", fromAddress: "sender@example.invalid" } },
		defaultSmtp: "outbound",
	});
}

class Client extends EventEmitter {
	usable = false;
	connects = 0;
	closes = 0;
	locks: string[] = [];
	releases = 0;
	async connect() { this.connects++; this.usable = true; }
	close() { this.closes++; this.usable = false; }
	async getMailboxLock(path: string) { this.locks.push(path); return { release: () => { this.releases++; } }; }
}

test("连接按需创建、同账户复用，认证与强制 TLS 参数明确且不启用后台 IDLE", async t => {
	const made: { client: Client; options: ImapFlowOptions }[] = [];
	const sessions = new ImapSessions(config(), options => {
		const client = new Client(); made.push({ client, options }); return client as unknown as ImapFlow;
	});
	t.after(() => sessions.dispose());
	assert.equal(made.length, 0);
	await sessions.run("first", "INBOX", undefined, async () => 1);
	await sessions.run("first", "Trash", undefined, async () => 2);
	assert.equal(made.length, 1);
	assert.equal(made[0]!.client.connects, 1);
	assert.deepEqual(made[0]!.client.locks, ["INBOX", "Trash"]);
	assert.equal(made[0]!.client.releases, 2);
	assert.equal(made[0]!.options.secure, true);
	assert.equal(made[0]!.options.doSTARTTLS, false);
	assert.equal(made[0]!.options.tls?.rejectUnauthorized, true);
	assert.deepEqual(made[0]!.options.auth, { user: "imap-user", pass: "dummy-imap" });
	assert.equal(made[0]!.options.logger, false);
	assert.equal(made[0]!.options.disableAutoIdle, true);
	await sessions.run("second", undefined, undefined, async () => 3);
	assert.equal(made.length, 2);
	assert.equal(made[1]!.options.secure, false);
	assert.equal(made[1]!.options.doSTARTTLS, true);
	assert.deepEqual(made[1]!.client.locks, []);
});

test("同账户完整排队，不同账户独立；失败不会阻塞下一次显式调用", async t => {
	const sessions = new ImapSessions(config(), () => new Client() as unknown as ImapFlow);
	t.after(() => sessions.dispose());
	const events: string[] = [];
	let release!: () => void;
	let entered!: () => void;
	const start = new Promise<void>(r => { entered = r; });
	const gate = new Promise<void>(r => { release = r; });
	const first = sessions.run("first", "INBOX", undefined, async () => { events.push("first"); entered(); await gate; throw new Error("fixture"); });
	const failed = assert.rejects(first, /fixture/);
	await start;
	const second = sessions.run("first", "Trash", undefined, async () => { events.push("second"); });
	await sessions.run("second", "INBOX", undefined, async () => { events.push("other"); });
	assert.deepEqual(events, ["first", "other"]);
	release();
	await failed;
	await second;
	assert.deepEqual(events, ["first", "other", "second"]);
});

test("无账户和预取消不建连接，不能借原型属性选中账户", async t => {
	let made = 0;
	const sessions = new ImapSessions(config(), () => { made++; return new Client() as unknown as ImapFlow; });
	t.after(() => sessions.dispose());
	for (const id of ["missing", "constructor", "toString"])
		await assert.rejects(sessions.run(id, "INBOX", undefined, async () => 1), /未配置/);
	await assert.rejects(sessions.run("first", "INBOX", AbortSignal.abort(), async () => 1), { name: "AbortError" });
	assert.equal(made, 0);
});

test("运行中取消关闭对应连接，锁在异常后仍释放，不重试", async t => {
	const client = new Client();
	const sessions = new ImapSessions(config(), () => client as unknown as ImapFlow);
	t.after(() => sessions.dispose());
	const controller = new AbortController();
	await assert.rejects(sessions.run("first", "INBOX", controller.signal, async () => {
		controller.abort();
		assert.equal(client.closes, 1);
		throw new Error("operation aborted");
	}), /operation aborted/);
	assert.equal(client.connects, 1);
	assert.equal(client.releases, 1);
});

test("三分钟空闲后回收，下一次显式操作新建连接", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	const clients: Client[] = [];
	const sessions = new ImapSessions(config(), () => { const c = new Client(); clients.push(c); return c as unknown as ImapFlow; });
	t.after(() => sessions.dispose());
	await sessions.run("first", "INBOX", undefined, async () => 1);
	t.mock.timers.tick(3 * 60_000 - 1);
	assert.equal(clients[0]!.closes, 0);
	t.mock.timers.tick(1);
	assert.equal(clients[0]!.closes, 1);
	await sessions.run("first", "INBOX", undefined, async () => 2);
	assert.equal(clients.length, 2);
});

test("销毁清理连接且排队的未执行操作不得再联网，可重复销毁", async () => {
	const client = new Client();
	const sessions = new ImapSessions(config(), () => client as unknown as ImapFlow);
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>(r => { entered = r; });
	const gate = new Promise<void>(r => { release = r; });
	const first = sessions.run("first", "INBOX", undefined, async () => { entered(); await gate; });
	await started;
	let ran = false;
	const queued = sessions.run("first", "INBOX", undefined, async () => { ran = true; });
	const rejected = assert.rejects(queued, /会话已经关闭/);
	sessions.dispose();
	sessions.dispose();
	release();
	await first;
	await rejected;
	assert.equal(client.closes, 1);
	assert.equal(ran, false);
	assert.equal(client.releases, 1);
	await assert.rejects(sessions.run("first", "INBOX", undefined, async () => 1), /会话已经关闭/);
});
