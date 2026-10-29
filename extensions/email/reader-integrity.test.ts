import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type MessageStructureObject } from "imapflow";
import { EmailCache } from "./cache.ts";
import type { ImapSessions } from "./imap-session.ts";
import { EmailReader } from "./reader.ts";

const BUDGET = 8 * 1024 * 1024;
const ref = { account: "test", mailbox: "INBOX", uidValidity: "123", uid: 9 };

/** 模拟服务器 FETCH 边界；realDownload 路径使用安装库的完整解码器，不联网。 */
function fixture(node: MessageStructureObject, data: Buffer, realDownload = false, rawHeaders?: Buffer) {
	const cache = new EmailCache();
	const downloads: Parameters<ImapFlow["download"]>[] = [];
	const mime = Buffer.from(`Content-Type: ${node.type}${Object.entries(node.parameters ?? {}).map(([key, value]) => `; ${key}=${value}`).join("")}\r\n` +
		(node.disposition ? `Content-Disposition: ${node.disposition}\r\n` : "") + "\r\n");
	const client = {
		mailbox: { uidValidity: 123n }, usable: true, log: { warn() {} }, autoidle() {},
		async fetchOne(_range: unknown, query: FetchQueryObject): Promise<FetchMessageObject> {
			const message: FetchMessageObject = { seq: 1, uid: 9, size: data.length, bodyStructure: node, headers: rawHeaders ?? mime };
			if (query.bodyParts) {
				message.bodyParts = new Map();
				for (const request of query.bodyParts) {
					if (typeof request === "string") message.bodyParts.set(request, mime);
					else {
						const start = request.start ?? 0;
						message.bodyParts.set(request.key, data.subarray(start, start + (request.maxLength ?? data.length)));
					}
				}
			}
			return message;
		},
		async download(...args: Parameters<ImapFlow["download"]>) {
			downloads.push(args);
			if (realDownload) return ImapFlow.prototype.download.call(client as unknown as ImapFlow, ...args);
			return { meta: { contentType: node.type }, content: Readable.from([data]) };
		},
	};
	const sessions = { async run<T>(_account: string, _mailbox: string | undefined, _signal: AbortSignal | undefined, action: (client: ImapFlow) => Promise<T>) {
		return action(client as unknown as ImapFlow);
	} } as ImapSessions;
	return { reader: new EmailReader(sessions, cache), cache, downloads };
}

test("已知 raw 正文超过预算在下载前拒绝，包括 flowed 与日文整段解码", async t => {
	const parametersList: Record<string, string>[] = [{ format: "flowed", charset: "utf-8" }, { charset: "iso-2022-jp" }];
	for (const parameters of parametersList) {
		const f = fixture({ type: "text/plain", size: 24 * 1024 * 1024, parameters }, Buffer.from("not downloaded"), true);
		t.after(() => f.cache.dispose());
		const result = await f.reader.read(ref);
		assert.equal(result.bodyTooLarge, true); assert.equal(result.body, null);
		assert.equal(result.part, "1"); assert.equal(result.cacheHit, false);
		assert.equal(f.downloads.length, 0); assert.equal(f.cache.size, 0);
	}
});

test("raw size 缺失不接受库可能在中间阶段截断的短输出", async t => {
	const f = fixture({ type: "text/plain", parameters: { format: "flowed" } }, Buffer.from("short output"));
	t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.bodyStatus, "unreadable"); assert.equal(result.message, "无法读取邮件正文");
	assert.equal((result.reasons as { code: string }[])[0]?.code, "BODY_SIZE_UNKNOWN");
	assert.equal(f.downloads.length, 0); assert.equal(f.cache.size, 0);
});

test("实际库在 raw 已知预算内完整解码 flowed 与日文，并收到 maxBytes", async t => {
	const cases: { data: Buffer; parameters: Record<string, string>; expected: string }[] = [
		{ data: Buffer.from("Hello \r\nworld"), parameters: { format: "flowed", charset: "utf-8" }, expected: "Hello world" },
		{ data: Buffer.from([0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x38, 0x6c, 0x1b, 0x28, 0x42]), parameters: { charset: "iso-2022-jp" }, expected: "日本語" },
	];
	for (const item of cases) {
		const f = fixture({ type: "text/plain", size: item.data.length, parameters: item.parameters }, item.data, true);
		t.after(() => f.cache.dispose());
		const result = await f.reader.read(ref);
		assert.equal(result.body, item.expected); assert.equal(result.truncated, false);
		assert.deepEqual(f.downloads[0], ["9", "1", { uid: true, maxBytes: BUDGET + 1 }]);
	}
});

test("解码膨胀超过预算明确失败，不能将库限长输出缓存为完整正文", async t => {
	const data = Buffer.alloc(5 * 1024 * 1024, 0xe9);
	const f = fixture({ type: "text/plain", size: data.length, parameters: { charset: "iso-8859-1" } }, data, true);
	t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.bodyTooLarge, true); assert.equal(result.body, null);
	assert.equal(result.part, "1"); assert.equal(f.cache.size, 0);
	assert.equal(f.downloads[0]?.[2]?.maxBytes, BUDGET + 1);
});

test("原始头部拒绝非 UTF-8 字节，不返回替换符伪装完整", async t => {
	const f = fixture({ type: "text/plain", size: 1 }, Buffer.from("x"), false, Buffer.from([0x58, 0x3a, 0x20, 0xe9, 0x0d, 0x0a]));
	t.after(() => f.cache.dispose());
	await assert.rejects(f.reader.headers(ref), { code: "HEADERS_ENCODING_UNSUPPORTED" });
	assert.equal(f.cache.size, 0);
});

test("合法 UTF-8 原始头部完整保留 BOM、重复字段、顺序与 CRLF", async t => {
	const raw = "\ufeffX-Test: 中文\r\nX-Test: two\r\n\tfolded\r\n\r\n";
	const f = fixture({ type: "text/plain", size: 1 }, Buffer.from("x"), false, Buffer.from(raw));
	t.after(() => f.cache.dispose());
	const result = await f.reader.headers(ref);
	assert.equal(result.headers, raw); assert.equal(result.complete, true); assert.equal(result.cacheHit, false);
	assert.equal((await f.reader.headers(ref)).cacheHit, true);
});

test("转换型 inline/缺 disposition 文本在下载和创建文件前拒绝", async t => {
	const dir = await mkdtemp(join(tmpdir(), "email-integrity-reject-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const nodes: MessageStructureObject[] = [
		{ type: "text/plain", disposition: "inline", parameters: { charset: "iso-8859-1", name: "latin.txt" } },
		{ type: "text/html", parameters: { charset: "iso-8859-1" } },
		{ type: "text/x-amp-html", disposition: "inline", parameters: { charset: "iso-8859-1" } },
		{ type: "text/plain", parameters: { charset: "iso-2022-jp" } },
		{ type: "text/plain", disposition: "inline", parameters: { charset: "utf-8", format: "flowed" } },
		{ type: "text/html", parameters: { format: "flowed" } },
		{ type: "text/plain", disposition: "inline", parameters: { charset: "utf-8", format: "flowed " } },
		{ type: "text/plain", disposition: " inline ", parameters: { charset: " ISO-8859-1 " } },
	];
	for (const [index, node] of nodes.entries()) {
		const f = fixture(node, Buffer.from([0xe9]), true); t.after(() => f.cache.dispose());
		await assert.rejects(f.reader.attachment({ ...ref, part: "1", path: join(dir, String(index)) }), { code: "ATTACHMENT_TRANSFORM_UNSUPPORTED" });
		assert.equal(f.downloads.length, 0); assert.equal(f.cache.size, 0);
	}
	assert.deepEqual(await readdir(dir), []);
});

test("实际库保留 attachment disposition 文本原字节，以及普通 UTF-8 和二进制附件", async t => {
	const dir = await mkdtemp(join(tmpdir(), "email-integrity-export-")); t.after(() => rm(dir, { recursive: true, force: true }));
	const cases: { node: MessageStructureObject; data: Buffer }[] = [
		{ node: { type: "text/plain", disposition: "attachment", parameters: { charset: "iso-8859-1", format: "flowed" } }, data: Buffer.from([0xe9]) },
		{ node: { type: "text/plain", disposition: "inline", parameters: { charset: "utf-8" } }, data: Buffer.from("完整😀") },
		{ node: { type: "text/html", parameters: { charset: "us-ascii" } }, data: Buffer.from("<b>ascii</b>") },
		{ node: { type: "application/pdf", disposition: "attachment" }, data: Buffer.from([0, 0xff, 0xe9]) },
	];
	for (const [index, item] of cases.entries()) {
		const f = fixture(item.node, item.data, true); t.after(() => f.cache.dispose());
		const path = join(dir, String(index));
		const result = await f.reader.attachment({ ...ref, part: "1", path });
		assert.equal(result.size, item.data.length); assert.deepEqual(await readFile(path), item.data);
	}
});

test("UTF-16 游标分页 A😀B 不切开 surrogate pair", async t => {
	const f = fixture({ type: "text/plain", size: 6 }, Buffer.from("A😀B")); t.after(() => f.cache.dispose());
	const first = await f.reader.read({ ...ref, maxChars: 2 });
	assert.equal(first.body, "A"); assert.equal(first.nextOffset, 1);
	const second = await f.reader.read({ ...ref, offset: Number(first.nextOffset), maxChars: 2 });
	assert.equal(second.body, "😀"); assert.equal(second.nextOffset, 3);
	const third = await f.reader.read({ ...ref, offset: Number(second.nextOffset), maxChars: 2 });
	assert.equal(third.body, "B"); assert.equal(third.nextOffset, null);
	assert.match(String(first.pagination), /nextOffset/);
});

test("offset 位于低 surrogate 时回到完整字符，maxChars=1 仍推进游标", async t => {
	const f = fixture({ type: "text/plain", size: 6 }, Buffer.from("A😀B")); t.after(() => f.cache.dispose());
	const middle = await f.reader.read({ ...ref, offset: 2, maxChars: 1 });
	assert.equal(middle.offset, 1); assert.equal(middle.body, "😀"); assert.equal(middle.nextOffset, 3);
	let offset = 0;
	const pages: string[] = [];
	for (let index = 0; index < 3; index++) {
		const result = await f.reader.read({ ...ref, offset, maxChars: 1 });
		pages.push(String(result.body));
		assert.equal(/[\uD800-\uDFFF]/u.test(String(result.body)), false);
		if (result.nextOffset === null) break;
		assert.ok(Number(result.nextOffset) > offset); offset = Number(result.nextOffset);
	}
	assert.deepEqual(pages, ["A", "😀", "B"]);
});
