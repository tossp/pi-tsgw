import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type MessageStructureObject } from "imapflow";
import { EmailCache, EMAIL_CACHE_MAX_ENTRY_BYTES } from "./cache.ts";
import type { ImapSessions } from "./imap-session.ts";
import { EmailReader } from "./reader.ts";

const ref = { account: "test", mailbox: "INBOX", uidValidity: "123", uid: 9 };
const structure: MessageStructureObject = { type: "multipart/mixed", childNodes: [
	{ part: "1", type: "text/plain", size: 10 },
	{ part: "2", type: "text/html", size: 20 },
	{ part: "3", type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "test.pdf" }, size: 50 },
] };
function fixture() {
	const calls: { method: string; args: unknown[] }[] = [];
	let content: () => Readable = () => Readable.from([Buffer.from("你好abc世界")]);
	let charset: string | undefined;
	let message: FetchMessageObject = { seq: 1, uid: 9, envelope: { subject: "测试", messageId: "<original@test>" }, bodyStructure: structure,
		headers: Buffer.from("X-Test: one\r\nX-Test: two\r\n\tfolded\r\n\r\n") };
	const client = {
		mailbox: { uidValidity: 123n },
		async fetchOne(...args: unknown[]) { calls.push({ method: "fetchOne", args }); return message; },
		async download(...args: unknown[]) { calls.push({ method: "download", args }); return { meta: { contentType: "text/plain", charset }, content: content() }; },
		async search(...args: unknown[]) { calls.push({ method: "search", args }); return [1, 3, 8, 9, 15]; },
		async *fetch(...args: unknown[]) {
			calls.push({ method: "fetch", args });
			for (const uid of args[0] as number[]) yield { seq: 1, uid, envelope: { date: new Date("2026-01-01"), from: [{ address: "a@test" }] }, flags: new Set(["\\Seen"]) };
		},
		async list() { return [{ path: "INBOX", name: "INBOX", flags: new Set(["\\Inbox"]), delimiter: "/" }]; },
	};
	const sessions = { async run<T>(_account: string, _mailbox: string | undefined, signal: AbortSignal | undefined, action: (client: ImapFlow) => Promise<T>) {
		signal?.throwIfAborted(); return action(client as unknown as ImapFlow);
	} } as ImapSessions;
	const cache = new EmailCache();
	return { reader: new EmailReader(sessions, cache), cache, client, calls,
		setCharset(value: string | undefined) { charset = value; },
		setContent(value: () => Readable) { content = value; }, setMessage(value: FetchMessageObject) { message = value; } };
}

test("实时服务器 UID 分页，筛选后仅 fetch 当前页摘要且可 JSON 序列化", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const result = await f.reader.list({ account: "test", beforeUid: 9, limit: 2 });
	assert.deepEqual((result.messages as { uid: number }[]).map(m => m.uid), [8, 3]);
	assert.equal(result.nextBeforeUid, 3);
	assert.equal(result.uidValidity, "123");
	assert.equal(result.mailbox, "INBOX");
	assert.deepEqual(f.calls.find(c => c.method === "search")?.args, [{ all: true }, { uid: true }]);
	assert.deepEqual(f.calls.find(c => c.method === "fetch")?.args[0], [8, 3]);
	assert.match(JSON.stringify(result), /2026-01-01T00:00:00.000Z/);
	await f.reader.list({ account: "test", beforeUid: 1 });
	assert.equal(f.calls.filter(c => c.method === "fetch").length, 1);
	assert.equal(f.calls.filter(c => c.method === "search").length, 2);
});

test("搜索字段透传服务器，包括任意头部、已读和日期，不猜身份", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	await f.reader.search({ account: "test", limit: 1, query: { from: "a", to: "b", subject: "s", body: "b", text: "t",
		since: "2026-01-01", before: "2026-02-01", unread: true, flagged: false, headers: { "Delivered-To": "alias@test" } } });
	assert.deepEqual(f.calls[0]?.args, [{ from: "a", to: "b", subject: "s", body: "b", text: "t", since: "2026-01-01", before: "2026-02-01",
		flagged: false, header: { "Delivered-To": "alias@test" }, seen: false }, { uid: true }]);
});

test("正文只下载选择的文本 part，分页与缓存及 refresh，不设置 Seen", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const first = await f.reader.read({ ...ref, maxChars: 3 });
	assert.equal(first.cacheHit, false);
	assert.equal(first.body, "你好a"); assert.equal(first.nextOffset, 3); assert.equal(first.truncated, true);
	assert.equal((first.attachments as { part: string }[])[0]?.part, "3");
	const second = await f.reader.read({ ...ref, offset: 3 });
	assert.equal(second.body, "bc世界"); assert.equal(second.cacheHit, true);
	assert.equal(f.calls.filter(c => c.method === "download").length, 1);
	assert.equal((await f.reader.read({ ...ref, refresh: true })).cacheHit, false);
	assert.equal(f.calls.filter(c => c.method === "download").length, 2);
	await f.reader.read({ ...ref, format: "html" });
	assert.deepEqual(f.calls.filter(c => c.method === "download").map(c => c.args), [
		["9", "1", { uid: true, maxBytes: 8 * 1024 * 1024 + 1 }],
		["9", "1", { uid: true, maxBytes: 8 * 1024 * 1024 + 1 }],
		["9", "2", { uid: true, maxBytes: 8 * 1024 * 1024 + 1 }],
	]);
	for (const call of f.calls.filter(c => c.method === "fetchOne")) assert.deepEqual(call.args,
		["9", { envelope: true, bodyStructure: true, uid: true }, { uid: true }]);
	f.client.mailbox.uidValidity = 999n;
	await assert.rejects(f.reader.read(ref), { code: "STALE_MAILBOX" });
});

test("只有图片的 HTML 不冒充空正文；仍可显式读取 HTML 版本", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	f.setMessage({ seq: 1, uid: 9, bodyStructure: { type: "text/html", size: 100 } });
	f.setContent(() => Readable.from(["<img src='https://example.invalid/pixel'>"]));
	const result = await f.reader.read(ref);
	assert.equal(result.contentType, "text/html"); assert.equal(result.part, "1");
	assert.equal(result.bodyStatus, "unreadable"); assert.equal(result.body, null);
	assert.equal(result.message, "无法读取邮件正文");
	const html = await f.reader.read({ ...ref, format: "html" });
	assert.equal(html.bodySource, "text/html"); assert.match(String(html.body), /<img/);
});

test("大正文不冒充完整文本，不缓存，给出显式导出 part", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	f.setMessage({ seq: 1, uid: 9, bodyStructure: { type: "text/plain", size: 10 } });
	f.setContent(() => Readable.from([Buffer.alloc(8 * 1024 * 1024), Buffer.from("x")]));
	const result = await f.reader.read(ref);
	assert.equal(result.bodyTooLarge, true); assert.equal(result.body, null); assert.equal(result.part, "1");
	assert.equal(f.cache.size, 0);
});

test("原始头部保留重复字段、顺序和 CRLF；缓存命中仍核对 UIDVALIDITY", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const result = await f.reader.headers(ref);
	assert.equal(result.headers, "X-Test: one\r\nX-Test: two\r\n\tfolded\r\n\r\n");
	assert.equal(result.cacheHit, false);
	assert.equal((await f.reader.headers(ref)).cacheHit, true);
	assert.equal(f.calls.length, 1);
	await f.reader.headers({ ...ref, refresh: true }); assert.equal(f.calls.length, 2);
	f.client.mailbox.uidValidity = 999n;
	await assert.rejects(f.reader.headers(ref), { code: "STALE_MAILBOX" });
});

test("超大头部清晰拒绝，不返回截断数据", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	f.setMessage({ seq: 1, uid: 9, headers: Buffer.alloc(1024 * 1024 + 1) });
	await assert.rejects(f.reader.headers(ref), { code: "HEADERS_TOO_LARGE" });
});

test("附件流式导出，小附件缓存、超预算不缓存，wx 不覆盖", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const dir = await mkdtemp(join(tmpdir(), "email-reader-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "small");
	f.setContent(() => Readable.from([Buffer.from("binary"), Buffer.from([0, 255])]));
	const result = await f.reader.attachment({ ...ref, part: "3", path });
	assert.equal(result.size, 8); assert.equal(f.cache.size, 1); assert.equal(result.cacheHit, false);
	assert.deepEqual(await readFile(path), Buffer.from([98, 105, 110, 97, 114, 121, 0, 255]));
	assert.equal((await f.reader.attachment({ ...ref, part: "3", path: join(dir, "cached") })).cacheHit, true);
	assert.equal(f.calls.filter(c => c.method === "download").length, 1);
	await assert.rejects(f.reader.attachment({ ...ref, part: "3", path }), { code: "EEXIST" });
	assert.equal((await readFile(path)).length, 8);
	await f.reader.attachment({ ...ref, part: "3", path: join(dir, "refreshed"), refresh: true });
	assert.equal(f.calls.filter(c => c.method === "download").length, 2);
	f.cache.clear();
	f.setContent(() => Readable.from((function* () { for (let i = 0; i < 9; i++) yield Buffer.alloc(1024 * 1024); })()));
	const large = await f.reader.attachment({ ...ref, part: "3", path: join(dir, "large") });
	assert.ok(Number(large.size) > EMAIL_CACHE_MAX_ENTRY_BYTES); assert.equal(f.cache.size, 0);
	await assert.rejects(f.reader.attachment({ ...ref, part: "HEADER", path: join(dir, "invalid") }), { code: "PART_MISSING" });
});

test("附件流错误或取消仅删除本次文件，保留已有文件", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const dir = await mkdtemp(join(tmpdir(), "email-reader-failure-")); t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(join(dir, "existing"), "保留");
	f.setContent(() => Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("模拟下载失败"); })()));
	await assert.rejects(f.reader.attachment({ ...ref, part: "3", path: join(dir, "failed") }));
	assert.deepEqual(await readdir(dir), ["existing"]);
	const controller = new AbortController();
	f.setContent(() => Readable.from((async function* () { yield Buffer.from("partial"); controller.abort(); yield Buffer.from("rest"); })()));
	await assert.rejects(f.reader.attachment({ ...ref, part: "3", path: join(dir, "aborted") }, controller.signal));
	assert.deepEqual(await readdir(dir), ["existing"]);
	assert.equal(await readFile(join(dir, "existing"), "utf8"), "保留");
});

test("文件夹清单为 JSON 数据；正文流失败与取消不写入缓存", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const boxes = await f.reader.mailboxes("test");
	assert.deepEqual((boxes.mailboxes as { flags: string[] }[])[0]?.flags, ["\\Inbox"]);
	assert.doesNotThrow(() => JSON.stringify(boxes));
	f.setContent(() => Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("模拟失败"); })()));
	const failed = await f.reader.read(ref);
	assert.equal(failed.bodyStatus, "unreadable"); assert.equal(failed.message, "无法读取邮件正文");
	assert.equal(f.cache.size, 0);
	const controller = new AbortController();
	f.setContent(() => Readable.from((async function* () { yield Buffer.from("partial"); controller.abort(); yield Buffer.from("rest"); })()));
	await assert.rejects(f.reader.read(ref, controller.signal)); assert.equal(f.cache.size, 0);
});

test("refresh 读取失败后正文、头部、附件不能再回退旧缓存", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	const dir = await mkdtemp(join(tmpdir(), "email-reader-refresh-")); t.after(() => rm(dir, { recursive: true, force: true }));
	await f.reader.read(ref);
	f.setContent(() => Readable.from((async function* () { throw new Error("模拟下载失败"); })()));
	assert.equal((await f.reader.read({ ...ref, refresh: true })).bodyStatus, "unreadable");
	assert.equal((await f.reader.read(ref)).bodyStatus, "unreadable");
	f.setContent(() => Readable.from(["new body"]));
	assert.equal((await f.reader.read(ref)).cacheHit, false);
	await f.reader.headers(ref);
	f.setMessage({ seq: 1, uid: 9, bodyStructure: structure });
	await assert.rejects(f.reader.headers({ ...ref, refresh: true }), { code: "HEADERS_MISSING" });
	await assert.rejects(f.reader.headers(ref), { code: "HEADERS_MISSING" });
	await f.reader.attachment({ ...ref, part: "3", path: join(dir, "original") });
	f.setContent(() => Readable.from((async function* () { throw new Error("模拟下载失败"); })()));
	await assert.rejects(f.reader.attachment({ ...ref, part: "3", path: join(dir, "refresh"), refresh: true }));
	await assert.rejects(f.reader.attachment({ ...ref, part: "3", path: join(dir, "next") }));
	assert.deepEqual(await readdir(dir), ["original"]);
	// 失败仅清除对应内容 key，不影响另一种已缓存正文。
	assert.equal((await f.reader.read(ref)).cacheHit, true);
});

test("未知字符集明确拒绝，UTF-8 和 ASCII 使用库已解码输出", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	f.setCharset("x-unknown-charset");
	const stream = Readable.from([Buffer.from([0xff])]); f.setContent(() => stream);
	const failed = await f.reader.read(ref);
	assert.equal(failed.bodyStatus, "unreadable");
	assert.equal((failed.reasons as { code: string }[])[0]?.code, "UNSUPPORTED_CHARSET");
	assert.equal(stream.destroyed, true); assert.equal(f.cache.size, 0);
	f.setCharset("utf-8"); f.setContent(() => Readable.from(["正确正文"]));
	assert.equal((await f.reader.read(ref)).body, "正确正文");
	f.setCharset("us-ascii"); f.setContent(() => Readable.from(["ascii"]));
	assert.equal((await f.reader.read({ ...ref, refresh: true })).body, "ascii");
});

test("真实库 download 解码膨胀超预算后结束分块 FETCH，无需关闭连接", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	let bodyFetches = 0;
	let closed = false;
	Object.assign(f.client, {
		usable: true, log: { warn() {} }, autoidle() {}, close() { closed = true; },
		download: ImapFlow.prototype.download,
		async fetchOne(_uid: unknown, query: FetchQueryObject): Promise<FetchMessageObject> {
			const response: FetchMessageObject = { seq: 1, uid: 9, size: 8 * 1024 * 1024, bodyStructure: { type: "text/plain", size: 8 * 1024 * 1024 } };
			if (query.bodyParts) {
				bodyFetches++;
				response.headers = Buffer.from("Content-Type: text/plain; charset=iso-8859-1\r\n\r\n");
				response.bodyParts = new Map([["text", Buffer.alloc(64 * 1024, 0xe9)]]);
			} else if (query.headers) response.headers = Buffer.from("X-Test: next command\r\n");
			return response;
		},
	});
	const result = await f.reader.read(ref);
	assert.equal(result.bodyTooLarge, true);
	await setImmediate();
	const stoppedAt = bodyFetches;
	assert.ok(stoppedAt > 64 && stoppedAt < 128);
	assert.equal((await f.reader.headers(ref)).headers, "X-Test: next command\r\n");
	await setImmediate();
	assert.equal(bodyFetches, stoppedAt); assert.equal(closed, false);
});

test("线程引用只使用原邮件 ID 和 References，拒绝无合法 ID", async t => {
	const f = fixture(); t.after(() => f.cache.dispose());
	f.setMessage({ seq: 1, uid: 9, envelope: { messageId: "<original@test>" },
		headers: Buffer.from("References: <a@test>\r\n\t<b@test>\r\nReferences: <a@test>\r\n") });
	assert.deepEqual(await f.reader.thread(ref), { inReplyTo: "<original@test>", references: ["<a@test>", "<b@test>", "<original@test>"] });
	f.setMessage({ seq: 1, uid: 9, envelope: { messageId: "bad\r\ninject" } });
	await assert.rejects(f.reader.thread(ref), { code: "MESSAGE_ID_MISSING" });
});
