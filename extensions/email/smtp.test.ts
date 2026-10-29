import assert from "node:assert/strict";
import { ReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import nodemailer, { type SendMailOptions, type SentMessageInfo, type SMTPPoolOptions } from "nodemailer";
import type { EmailConfig } from "./config.ts";
import { EmailSender } from "./smtp.ts";
import type { SendInput, ThreadHeaders } from "./types.ts";

const input: SendInput = { to: ["to@example.test"], subject: "本次主题", text: "本次正文" };
const reference = { account: "imap", mailbox: "INBOX", uidValidity: "1", uid: 2 };
const thread: ThreadHeaders = { inReplyTo: "<original@example.test>", references: ["<root@example.test>", "<original@example.test>"] };
function config(): EmailConfig {
	const smtp = {
		host: "smtp.example.test", port: 465, tls: "implicit" as const,
		user: "login-not-from", password: "secret-password", fromAddress: "from@example.test",
		fromName: "配置名称", allowSenderOverride: false,
	};
	return { imap: {}, smtp: { first: smtp, second: { ...smtp, tls: "starttls", port: 587 } }, defaultSmtp: "first" };
}
function info(accepted = input.to, rejected: string[] = []): SentMessageInfo {
	return { messageId: "<sent@example.test>", envelope: { from: "from@example.test", to: input.to }, accepted, rejected };
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
function fixture(c = config(), send: (message: SendMailOptions) => Promise<SentMessageInfo> = async () => info()) {
	const pools: { options: SMTPPoolOptions; messages: SendMailOptions[]; closed: number }[] = [];
	const sender = new EmailSender(c, async () => thread, (options) => {
		const pool = { options, messages: [] as SendMailOptions[], closed: 0 };
		pools.push(pool);
		return { sendMail: (message) => { pool.messages.push(message); return send(message); }, close: () => { pool.closed++; } };
	});
	return { sender, pools };
}

// 所有传输边界均为 stub 或 Nodemailer streamTransport，不联网、无个人配置。
test("懒建、默认与显式出口、自有键检查、池复用与幂等销毁", async () => {
	const { sender, pools } = fixture();
	assert.equal(pools.length, 0);
	for (const smtp of ["absent", "toString", "constructor", ""]) {
		assert.equal((await sender.send({ ...input, smtp })).status, "failed");
	}
	assert.equal(pools.length, 0);
	assert.equal((await sender.send(input)).smtp, "first");
	await sender.send({ ...input, smtp: "first" });
	await sender.send({ ...input, smtp: "second" });
	assert.equal(pools.length, 2);
	assert.equal(pools[0].messages.length, 2);
	assert.equal(pools[1].messages.length, 1);
	sender.dispose(); sender.dispose();
	assert.deepEqual(pools.map((p) => p.closed), [1, 1]);
	assert.equal((await sender.send(input)).status, "failed");
	assert.equal(pools.length, 2);
});

test("强制 TLS、验证证书、关闭日志、有限超时、单连接与零重入队", async () => {
	const { sender, pools } = fixture();
	await sender.send(input); await sender.send({ ...input, smtp: "second" });
	assert.equal(pools[0].options.secure, true);
	assert.equal(pools[1].options.secure, false);
	assert.equal(pools[1].options.requireTLS, true);
	for (const { options } of pools) {
		assert.equal(options.pool, true); assert.equal(options.maxConnections, 1);
		assert.equal(options.maxRequeues, 0); assert.equal(options.ignoreTLS, false);
		assert.equal(options.tls?.rejectUnauthorized, true);
		assert.equal(options.debug, false); assert.equal(options.logger, false);
		assert.equal(options.disableUrlAccess, true); assert.equal(options.disableFileAccess, true);
		for (const key of ["connectionTimeout", "greetingTimeout", "socketTimeout", "idleTimeout"] as const)
			assert.ok(Number.isFinite(options[key]) && options[key]! > 0);
		assert.deepEqual(options.auth, { user: "login-not-from", pass: "secret-password" });
	}
	sender.dispose();
});

test("固定 From 允许相同值，拒绝实际修改地址或名称；认证名不作为 From", async () => {
	const { sender, pools } = fixture();
	for (const overrides of [{ fromAddress: "other@example.test" }, { fromName: "其他" }, { fromName: "" }])
		assert.equal((await sender.send({ ...input, ...overrides })).status, "failed");
	assert.equal(pools.length, 0);
	await sender.send({ ...input, fromAddress: "from@example.test", fromName: "配置名称" });
	const message = pools[0].messages[0];
	assert.deepEqual(message.from, { address: "from@example.test", name: "配置名称" });
	assert.deepEqual(message.envelope, { from: "from@example.test", to: input.to });
	sender.dispose();
});

test("可覆盖 From 与固定/跟随 envelope；收件人与主题只用显式输入", async () => {
	const c = config();
	c.smtp.first.allowSenderOverride = true;
	c.smtp.second.allowSenderOverride = true;
	c.smtp.second.envelopeFrom = "bounce@example.test";
	const { sender, pools } = fixture(c);
	const explicit = { ...input, fromAddress: "other@example.test", fromName: "", cc: ["cc@example.test"], bcc: ["bcc@example.test"] };
	await sender.send(explicit); await sender.send({ ...explicit, smtp: "second" });
	for (const pool of pools) {
		assert.deepEqual(pool.messages[0].from, { address: "other@example.test", name: "" });
		assert.equal(pool.messages[0].subject, input.subject);
		assert.deepEqual(pool.messages[0].envelope?.to, [...input.to, ...explicit.cc, ...explicit.bcc]);
	}
	assert.equal(pools[0].messages[0].envelope?.from, "other@example.test");
	assert.equal(pools[1].messages[0].envelope?.from, "bounce@example.test");
	sender.dispose();
});

test("reply 使用 resolver 线程头与 signal，不推导原邮件收件人/主题", async () => {
	const calls: unknown[] = [];
	let message: SendMailOptions | undefined;
	const controller = new AbortController();
	const sender = new EmailSender(config(), async (ref, signal) => { calls.push(ref, signal); return thread; }, () => ({
		sendMail: async (value) => { message = value; return info(); }, close() {},
	}));
	await sender.send({ ...input, replyToMessage: reference }, controller.signal);
	assert.deepEqual(calls, [reference, controller.signal]);
	assert.equal(message?.inReplyTo, thread.inReplyTo);
	assert.deepEqual(message?.references, thread.references);
	assert.deepEqual(message?.to, input.to); assert.equal(message?.subject, input.subject);
	sender.dispose();
});

test("源线程不可读或 resolver 报敏感错误时不建池、不发送、不透传错误", async () => {
	let created = 0;
	const sender = new EmailSender(config(), async () => { throw new Error("secret-password AUTH private response"); }, () => {
		created++; throw new Error("不得创建");
	});
	const result = await sender.send({ ...input, replyToMessage: reference });
	assert.equal(result.status, "failed"); assert.equal(created, 0);
	assert.doesNotMatch(JSON.stringify(result), /secret-password|AUTH|private response/);
	sender.dispose();
});

test("Nodemailer 实际 MIME 组合：线程、显式 To/Cc/Bcc 与本地流附件", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tsgw-smtp-"));
	const path = join(dir, "source.txt");
	await writeFile(path, "local-attachment-content");
	const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
	let mime = "";
	let captured: SendMailOptions | undefined;
	const sender = new EmailSender(config(), async () => thread, () => ({
		async sendMail(message) {
			captured = message;
			assert.ok(message.attachments?.[0].content instanceof ReadStream);
			assert.equal(message.attachments?.[0].path, undefined);
			assert.equal(message.attachments?.[0].raw, undefined);
			const result = await transport.sendMail(message);
			mime = result.message.toString();
			return { ...result, accepted: ["to@example.test", "cc@example.test", "bcc@example.test"], rejected: [] };
		}, close: () => transport.close(),
	}));
	try {
		const result = await sender.send({
			...input, cc: ["cc@example.test"], bcc: ["bcc@example.test"], replyToMessage: reference,
			html: "<p>正文</p>", attachments: [Object.assign(
				{ path, filename: "approved.txt", contentType: "text/plain" },
				{ raw: "unauthorized-raw", href: "https://example.test/unauthorized" },
			)],
		});
		assert.equal(result.status, "success");
		assert.match(mime, /In-Reply-To: <original@example.test>/);
		assert.match(mime, /References: <root@example.test> <original@example.test>/);
		assert.match(mime, /To: to@example.test/); assert.match(mime, /Cc: cc@example.test/);
		// streamTransport 源码主动保留 Bcc 供本地检查，SMTP 传输不这样做。
		assert.match(mime, /Bcc: bcc@example.test/);
		assert.match(mime, /filename=approved.txt/);
		assert.doesNotMatch(mime, /unauthorized/);
		assert.match(mime, new RegExp(Buffer.from("local-attachment-content").toString("base64")));
		assert.equal(captured?.disableUrlAccess, true); assert.equal(captured?.disableFileAccess, true);
	} finally { sender.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("拒绝 URL/非普通/不存在附件；不透传任意 raw、path 或库选项", async () => {
	const { sender, pools } = fixture();
	for (const path of ["https://example.test/private", "file:///etc/passwd", tmpdir(), "/nonexistent-smtp-attachment"])
		assert.equal((await sender.send({ ...input, attachments: [{ path }] })).status, "failed");
	assert.equal(pools.length, 0);
	await sender.send(Object.assign({}, input, { raw: "unauthorized", path: "/etc/passwd", auth: { user: "override" }, disableUrlAccess: false }));
	const message = pools[0].messages[0];
	assert.equal(message.raw, undefined); assert.equal(message.auth, undefined);
	assert.equal(message.disableUrlAccess, true);
	sender.dispose();
});

test("局部拒绝逐项返回 partial；全部拒绝返回 failed；没有自动重发或换出口", async () => {
	const accepted = ["a@example.test"], rejected = ["b@example.test", "c@example.test"];
	let calls = 0;
	const { sender, pools } = fixture(config(), async () => { calls++; return info(calls === 1 ? accepted : [], rejected); });
	const partial = await sender.send(input);
	assert.equal(partial.status, "partial"); assert.deepEqual(partial.accepted, accepted); assert.deepEqual(partial.rejected, rejected);
	assert.equal(partial.messageId, "<sent@example.test>");
	assert.equal((await sender.send(input)).status, "failed");
	assert.equal(calls, 2); assert.equal(pools.length, 1);
	sender.dispose();
});

test("明确 SMTP 拒绝/发前失败与 DATA 失联区分；敏感原文不泄露、每次只尝试一次", async () => {
	for (const [detail, expected] of [
		[{ responseCode: 550, command: "DATA", rejected: ["rejected@example.test"] }, "failed"],
		[{ responseCode: 451, command: "RCPT TO" }, "failed"],
		[{ code: "EAUTH" }, "failed"], [{ code: "ETLS" }, "failed"],
		[{ code: "ESTREAM", command: "API" }, "failed"],
		[{ code: "ESTREAM", command: "DATA" }, "failed"],
		[{ code: "ETIMEDOUT", command: "CONN" }, "failed"],
		[{ code: "ECONNECTION", command: "DATA" }, "unknown"],
		[{ code: "ETIMEDOUT", command: "DATA" }, "unknown"], [{}, "unknown"],
	] as const) {
		let attempts = 0;
		const { sender, pools } = fixture(config(), async () => {
			attempts++; throw Object.assign(new Error("secret-password AUTH private response"), detail, { response: "private response" });
		});
		const result = await sender.send(input);
		assert.equal(result.status, expected);
		if ("code" in detail && detail.code === "ESTREAM")
			assert.match(result.message!, /本地邮件内容读取失败.*未自动重试/);
		if ("rejected" in detail) assert.deepEqual(result.rejected, detail.rejected);
		assert.doesNotMatch(JSON.stringify(result), /secret-password|AUTH|private response/);
		assert.equal(attempts, 1); assert.equal(pools.length, 1);
		sender.dispose();
	}
});

test("发送前取消不调用 resolver、不建池；线程读取中取消尽快返回且无迟到发送", async () => {
	const controller = new AbortController(); controller.abort();
	let reads = 0, creates = 0;
	const pending = deferred<ThreadHeaders>();
	const sender = new EmailSender(config(), async () => { reads++; return pending.promise; }, () => { creates++; throw new Error("不得创建"); });
	assert.equal((await sender.send({ ...input, replyToMessage: reference }, controller.signal)).status, "failed");
	assert.equal(reads, 0); assert.equal(creates, 0);
	const running = new AbortController();
	const result = sender.send({ ...input, replyToMessage: reference }, running.signal);
	running.abort();
	assert.equal((await result).status, "failed");
	pending.resolve(thread); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(creates, 0); sender.dispose();
});

test("取消活动发送关闭当前出口池：仅已提交项 unknown，排队项未发送，其他出口独立", async () => {
	const pending = deferred<SentMessageInfo>();
	const { sender, pools } = fixture(config(), async () => pending.promise);
	const controller = new AbortController();
	const first = sender.send(input, controller.signal);
	const queued = sender.send(input);
	const other = sender.send({ ...input, smtp: "second" });
	assert.deepEqual(pools.map((p) => p.messages.length), [1, 1]);
	controller.abort();
	assert.equal((await first).status, "unknown");
	const cancelled = await queued;
	assert.equal(cancelled.status, "failed"); assert.match(cancelled.message!, /尚未发送/);
	assert.deepEqual(pools.map((p) => p.closed), [1, 0]);
	pending.resolve(info());
	assert.equal((await other).status, "success");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(pools.map((p) => p.messages.length), [1, 1]); // 排队项不会迟到发送。
	await sender.send(input);
	assert.equal(pools.length, 3); // 取消池已丢弃，不复用其队列。
	sender.dispose(); assert.deepEqual(pools.map((p) => p.closed), [1, 1, 1]);
});

test("取消排队项不关闭池、不影响活动项，后续排队项不能越过活动项", async () => {
	const pending = deferred<SentMessageInfo>();
	const { sender, pools } = fixture(config(), async () => pending.promise);
	const first = sender.send(input);
	const controller = new AbortController();
	const queued = sender.send({ ...input, subject: "取消排队项" }, controller.signal);
	const last = sender.send({ ...input, subject: "后续排队项" });
	assert.equal(pools[0].messages.length, 1);
	controller.abort();
	const result = await queued;
	assert.equal(result.status, "failed"); assert.match(result.message!, /尚未发送/);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(pools[0].closed, 0); assert.equal(pools[0].messages.length, 1);
	pending.resolve(info());
	assert.equal((await first).status, "success"); assert.equal((await last).status, "success");
	assert.deepEqual(pools[0].messages.map((m) => m.subject), [input.subject, "后续排队项"]);
	assert.equal(pools.length, 1);
	sender.dispose();
});

test("排队时不提前打开附件；出队后读取并销毁流、复用当前池", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tsgw-smtp-queue-"));
	const path = join(dir, "attachment.txt");
	const pending = deferred<SentMessageInfo>();
	const { sender, pools } = fixture(config(), async () => pending.promise);
	try {
		const first = sender.send(input);
		const queued = sender.send({ ...input, attachments: [{ path }] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(pools[0].messages.length, 1);
		// 发送请求入队时文件尚不存在，只有出队后才允许打开。
		await writeFile(path, "queued-attachment");
		pending.resolve(info());
		assert.equal((await first).status, "success"); assert.equal((await queued).status, "success");
		assert.equal(pools.length, 1); assert.equal(pools[0].messages.length, 2);
		const stream = pools[0].messages[1].attachments![0].content as ReadStream;
		assert.equal(stream.destroyed, true);
	} finally { sender.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("取消带附件的未决发送会销毁本地流，迟到发送结果不改写 unknown", async () => {
	const dir = await mkdtemp(join(tmpdir(), "tsgw-smtp-cancel-"));
	const path = join(dir, "attachment.txt");
	await writeFile(path, "attachment");
	const started = deferred<ReadStream>();
	const pending = deferred<SentMessageInfo>();
	const { sender, pools } = fixture(config(), async (message) => {
		started.resolve(message.attachments![0].content as ReadStream);
		return pending.promise;
	});
	try {
		const controller = new AbortController();
		const result = sender.send({ ...input, attachments: [{ path }] }, controller.signal);
		const stream = await started.promise;
		controller.abort();
		assert.equal((await result).status, "unknown");
		assert.equal(stream.destroyed, true); assert.equal(pools[0].closed, 1);
		pending.resolve(info());
		await new Promise((resolve) => setImmediate(resolve));
	} finally { sender.dispose(); await rm(dir, { recursive: true, force: true }); }
});

test("默认真实工厂在构造和销毁阶段不建池；建池异常不泄露凭据", async () => {
	const unused = new EmailSender(config(), async () => thread);
	unused.dispose(); unused.dispose();
	let attempts = 0;
	const sender = new EmailSender(config(), async () => thread, () => {
		attempts++; throw new Error("secret-password private SMTP config");
	});
	const result = await sender.send(input);
	assert.equal(result.status, "failed"); assert.equal(attempts, 1);
	assert.doesNotMatch(JSON.stringify(result), /secret-password|private SMTP config/);
	sender.dispose();
});

test("销毁终止等待且阻止迟到线程读取进入 send；晚到 rejection 被消费", async () => {
	const threadWait = deferred<ThreadHeaders>(), sendWait = deferred<SentMessageInfo>();
	let creates = 0, sends = 0, closes = 0;
	const sender = new EmailSender(config(), async () => threadWait.promise, () => {
		creates++; return { sendMail: async () => { sends++; return sendWait.promise; }, close() { closes++; } };
	});
	const preparing = sender.send({ ...input, smtp: "second", replyToMessage: reference });
	const sending = sender.send(input);
	const queued = sender.send(input);
	sender.dispose(); sender.dispose();
	assert.equal((await preparing).status, "failed"); assert.equal((await sending).status, "unknown");
	const result = await queued;
	assert.equal(result.status, "failed"); assert.match(result.message!, /尚未发送/);
	threadWait.resolve(thread); sendWait.reject(new Error("secret-password late failure"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(creates, 1); assert.equal(sends, 1); assert.equal(closes, 1);
	assert.equal((await sender.send(input)).status, "failed");
});
