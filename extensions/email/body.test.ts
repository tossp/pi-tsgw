import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { ImapFlow, type FetchMessageObject, type FetchQueryObject, type MessageStructureObject } from "imapflow";
import { EmailCache } from "./cache.ts";
import type { ImapSessions } from "./imap-session.ts";
import { EmailReader } from "./reader.ts";
import type { ReadInput } from "./types.ts";

const ref = { account: "test", mailbox: "INBOX", uidValidity: "123", uid: 9 };
interface Part { node: MessageStructureObject; raw: Buffer; headers: Buffer; }
function part(type: string, text: string | Buffer, options: { part?: string; charset?: string; encoding?: string } = {}): Part {
	const raw = Buffer.isBuffer(text) ? text : Buffer.from(text);
	const charset = options.charset ?? "utf-8";
	return { node: { part: options.part, type, size: raw.length, parameters: { charset } }, raw,
		headers: Buffer.from(`Content-Type: ${type}; charset=${charset}\r\n` +
			(options.encoding ? `Content-Transfer-Encoding: ${options.encoding}\r\n` : "") + "\r\n") };
}

/** 仅模拟 IMAP FETCH；正文解码走真实 ImapFlow/libmime/mailsplit，HTML 转换也使用真实库。 */
function fixture(root: MessageStructureObject | undefined, parts: Part[]) {
	const cache = new EmailCache();
	const requested: string[] = [];
	const queries: FetchQueryObject[] = [];
	const client = {
		mailbox: { uidValidity: 123n }, usable: true, log: { warn() {}, debug() {}, error() {} }, autoidle() {},
		async fetchOne(_range: unknown, query: FetchQueryObject): Promise<FetchMessageObject> {
			queries.push(query);
			const result: FetchMessageObject = { seq: 1, uid: 9, bodyStructure: root, size: parts.reduce((sum, p) => sum + p.raw.length, 0) };
			if (!query.bodyParts) return result;
			result.bodyParts = new Map();
			for (const request of query.bodyParts) {
				const key = typeof request === "string" ? request : request.key;
				const number = key.toLowerCase() === "text" || key.toLowerCase() === "header" ? "1" : key.replace(/\.mime$/i, "");
				const data = parts.find(p => (p.node.part ?? "1") === number);
				if (!data) throw new Error("模拟 MIME 部分缺失");
				if (typeof request === "string") {
					if (key.toLowerCase() === "header") result.headers = data.headers;
					else result.bodyParts.set(key, data.headers);
				} else {
					const start = request.start ?? 0;
					result.bodyParts.set(key, data.raw.subarray(start, start + (request.maxLength ?? data.raw.length)));
				}
			}
			return result;
		},
		async download(...args: Parameters<ImapFlow["download"]>) {
			requested.push(String(args[1]));
			return ImapFlow.prototype.download.call(client as unknown as ImapFlow, ...args);
		},
	};
	const sessions = { async run<T>(_account: string, _mailbox: string | undefined, signal: AbortSignal | undefined, action: (client: ImapFlow) => Promise<T>) {
		signal?.throwIfAborted(); return action(client as unknown as ImapFlow);
	} } as ImapSessions;
	return { reader: new EmailReader(sessions, cache), cache, requested, queries };
}

function alternative(plain: Part, html: Part): MessageStructureObject {
	return { type: "multipart/alternative", childNodes: [plain.node, html.node] };
}

test("有效纯文本直接返回，真实解码 base64；保留空行且不下载 HTML", async t => {
	const text = "第一段\n\n第二段😀";
	const plain = part("text/plain", Buffer.from(text).toString("base64"), { part: "1", encoding: "base64" });
	const html = part("text/html", "<p>HTML 版本</p>", { part: "2" });
	const f = fixture(alternative(plain, html), [plain, html]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.body, text); assert.equal(result.bodyStatus, "success"); assert.equal(result.bodySource, "text/plain");
	assert.deepEqual(f.requested, ["1"]); assert.equal(result.htmlAvailable, true);
	assert.equal((result.htmlAlternative as ReadInput).format, "html");
});

test("纯 HTML 使用真实 quoted-printable 解码，保留段落和 br，不返回标记", async t => {
	const html = part("text/html", "<p>=E4=BD=A0=E5=A5=BD<br>world</p><p>next</p>", { encoding: "quoted-printable" });
	const f = fixture(html.node, [html]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.bodySource, "text/html"); assert.equal(result.bodyFormat, "text");
	assert.equal(result.body, "你好\nworld\n\nnext"); assert.equal(result.bodyStatus, "success");
});

test("空白或零长度纯文本回退有效 HTML，不返回空正文", async t => {
	for (const value of [" \r\n\t", ""]) {
		const plain = part("text/plain", value, { part: "1" });
		const html = part("text/html", "<p>实际正文</p>", { part: "2" });
		const f = fixture(alternative(plain, html), [plain, html]); t.after(() => f.cache.dispose());
		const result = await f.reader.read(ref);
		assert.equal(result.body, "实际正文"); assert.equal(result.bodySource, "text/html");
		assert.deepEqual(f.requested, ["1", "2"]);
	}
});

test("嵌套 mixed/related/alternative 只取正文，不拼接版本或下载附件和内嵌资源", async t => {
	const plain = part("text/plain", "唯一正文", { part: "1.1.1" });
	const html = part("text/html", "<p>唯一正文</p>", { part: "1.1.2" });
	const resource = part("text/plain", "内嵌文本资源", { part: "1.2" });
	const attachment = part("text/plain", "附件内容", { part: "2" }); attachment.node.disposition = "attachment";
	const embedded = { part: "3", type: "message/rfc822", disposition: "attachment", childNodes: [part("text/plain", "附信内容", { part: "3.1" }).node] };
	const root = { type: "multipart/mixed", childNodes: [
		{ part: "1", type: "multipart/related", childNodes: [
			{ part: "1.1", ...alternative(plain, html) }, resource.node,
		] }, attachment.node, embedded,
	] };
	const f = fixture(root, [plain, html, resource, attachment]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.body, "唯一正文"); assert.deepEqual(f.requested, ["1.1.1"]);
	assert.ok((result.attachments as { part: string }[]).some(p => p.part === "2"));
	const other = await f.reader.read({ ...ref, format: "html" });
	assert.equal(other.body, "<p>唯一正文</p>"); assert.deepEqual(f.requested, ["1.1.1", "1.1.2"]);
});

test("related start 指定的非首个根部件才是正文", async t => {
	const resource = part("text/plain", "不是正文", { part: "1" }); resource.node.id = "<resource>";
	const html = part("text/html", "<p>根正文</p>", { part: "2" }); html.node.id = "<root>";
	const root = { type: "multipart/related", parameters: { start: "<root>" }, childNodes: [resource.node, html.node] };
	const f = fixture(root, [resource, html]); t.after(() => f.cache.dispose());
	assert.equal((await f.reader.read(ref)).body, "根正文"); assert.deepEqual(f.requested, ["2"]);
});

test("mixed 的 HTML 主体不被后置纯文本页脚代替", async t => {
	const html = part("text/html", "<p>完整主体</p>", { part: "1" });
	const footer = part("text/plain", "退订页脚", { part: "2" });
	const f = fixture({ type: "multipart/mixed", childNodes: [html.node, footer.node] }, [html, footer]); t.after(() => f.cache.dispose());
	assert.equal((await f.reader.read(ref)).body, "完整主体"); assert.deepEqual(f.requested, ["1"]);
});

test("中文 HTML 表格保持列名、单元格、行和后续段落，字符集由真实库转换", async t => {
	// GB2312 字节：中文；其余 HTML 使用 ASCII。
	const raw = Buffer.concat([Buffer.from("<p>"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
		Buffer.from("</p><table><tr><th>"), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
		Buffer.from("</th><th>value</th></tr><tr><td>A</td><td>12</td></tr><tr><td>B</td><td>34</td></tr></table><p>end</p>")]);
	const html = part("text/html", raw.toString("base64"), { charset: "gb2312", encoding: "base64" });
	const f = fixture(html.node, [html]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.match(String(result.body), /^中文\n\n/);
	assert.match(String(result.body), /中文 +value\nA +12\nB +34/);
	assert.match(String(result.body), /\n\nend$/); assert.equal(result.bodyStatus, "success");
});

test("纯文本只有页脚时保留 HTML 按需读取入口，不能宣称整封信已完整", async t => {
	const plain = part("text/plain", "退订", { part: "1" });
	const html = part("text/html", "<p>真实长正文</p><p>退订</p>", { part: "2" });
	const f = fixture(alternative(plain, html), [plain, html]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.body, "退订"); assert.match(String(result.versionNotice), /未比较 HTML/);
	assert.equal(result.complete, undefined);
	const full = await f.reader.read(result.htmlAlternative as ReadInput);
	assert.equal(full.bodySource, "text/html"); assert.match(String(full.body), /真实长正文/);
});

test("不支持类型、缺失结构、附件独占或 HTML 请求缺失不误报为空", async t => {
	for (const type of ["text/rtf", "application/octet-stream", "application/pkcs7-mime"]) {
		const body = part(type, "nonempty"); const f = fixture(body.node, [body]); t.after(() => f.cache.dispose());
		const result = await f.reader.read(ref);
		assert.equal(result.bodyStatus, "unreadable"); assert.equal(result.message, "无法读取邮件正文");
		assert.ok((result.reasons as unknown[]).length > 0); assert.deepEqual(f.requested, []);
	}
	const attached = part("text/plain", "attachment"); attached.node.disposition = "attachment";
	for (const root of [undefined, attached.node]) {
		const f = fixture(root, [attached]); t.after(() => f.cache.dispose());
		assert.equal((await f.reader.read(ref)).bodyStatus, "unreadable");
	}
	const plain = part("text/plain", "plain"); const f = fixture(plain.node, [plain]); t.after(() => f.cache.dispose());
	assert.equal((await f.reader.read({ ...ref, format: "html" })).bodyStatus, "unreadable");
});

test("解码失败不返回替换字符或假空正文，不暴露上游错误正文", async t => {
	const html = part("text/html", Buffer.from([0xc3, 0x28]));
	const f = fixture(html.node, [html]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.bodyStatus, "unreadable"); assert.equal(result.message, "无法读取邮件正文");
	assert.equal((result.reasons as { code: string }[])[0]?.code, "BODY_DECODE_FAILED"); assert.equal(f.cache.size, 0);
	const missing = fixture(html.node, []); t.after(() => missing.cache.dispose());
	const failed = await missing.reader.read(ref);
	assert.equal(failed.bodyStatus, "unreadable"); assert.equal((failed.reasons as { code: string }[])[0]?.code, "BODY_PARSE_FAILED");
	assert.doesNotMatch(JSON.stringify(failed), /模拟 MIME/);
});

test("只有真正的零长度正文报告为空，空白或无文字 HTML 则不能", async t => {
	const empty = part("text/plain", ""); const f = fixture(empty.node, [empty]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.bodyStatus, "empty", JSON.stringify(result)); assert.equal(result.message, "邮件正文为空"); assert.equal(result.body, "");
	for (const value of [" \r\n", "<p></p>", "<img src='https://example.invalid/pixel'>", "<script>dangerous()</script>"]) {
		const html = part("text/html", value); const other = fixture(html.node, [html]); t.after(() => other.cache.dispose());
		const unreadable = await other.reader.read(ref);
		assert.equal(unreadable.bodyStatus, "unreadable"); assert.equal(unreadable.message, "无法读取邮件正文");
	}
});

test("HTML 转换不执行脚本或访问外链；截断 continuation 逐页还原且复用缓存", async t => {
	let fetches = 0;
	t.mock.method(globalThis, "fetch", async () => { fetches++; throw new Error("禁止联网"); });
	const html = part("text/html", "<p>A😀B</p><p>第二段</p><script>fetch('https://example.invalid')</script>" +
		"<style>secret</style><img src='https://example.invalid/pixel'><iframe src='https://example.invalid/frame'></iframe>");
	const f = fixture(html.node, [html]); t.after(() => f.cache.dispose());
	const pages: string[] = [];
	let input: ReadInput = { ...ref, maxChars: 2 };
	for (let i = 0; i < 20; i++) {
		const result = await f.reader.read(input);
		assert.equal(result.bodyStatus, "success"); pages.push(String(result.body));
		if (!result.truncated) { assert.equal(result.nextOffset, null); break; }
		assert.match(String(result.message), /已截断/); assert.equal((result.continuation as ReadInput).uid, 9);
		input = result.continuation as ReadInput;
		assert.ok(input.offset! > 0);
	}
	assert.equal(pages.join(""), "A😀B\n\n第二段"); assert.equal(fetches, 0); assert.deepEqual(f.requested, ["1"]);
	assert.ok(f.queries.every(query => !query.source));
});

test("HTML 原文与转文字的缓存双向隔离，refresh 刷新空白 plain 回退的两部分", async t => {
	for (const firstFormat of ["text", "html"] as const) {
		const html = part("text/html", "<p>正文</p>"); const f = fixture(html.node, [html]); t.after(() => f.cache.dispose());
		const otherFormat = firstFormat === "text" ? "html" : "text";
		for (const format of [firstFormat, otherFormat, firstFormat] as const) {
			const result = await f.reader.read({ ...ref, format });
			assert.equal(result.body, format === "text" ? "正文" : "<p>正文</p>");
		}
		assert.deepEqual(f.requested, ["1"]);
	}
	const plain = part("text/plain", "  ", { part: "1" });
	const html = part("text/html", "<p>旧正文</p>", { part: "2" });
	const f = fixture(alternative(plain, html), [plain, html]); t.after(() => f.cache.dispose());
	assert.equal((await f.reader.read(ref)).body, "旧正文");
	html.raw = Buffer.from("<p>新正文</p>"); html.node.size = html.raw.length;
	assert.equal((await f.reader.read(ref)).body, "旧正文");
	assert.equal((await f.reader.read({ ...ref, refresh: true })).body, "新正文");
	assert.deepEqual(f.requested, ["1", "2", "1", "2"]);
});

test("related start 无匹配不能任取资源；带 filename 的 inline 文本及同编号附信不参与正文", async t => {
	const resource = part("text/plain", "资源", { part: "1" }); resource.node.id = "<resource>";
	const bad = fixture({ type: "multipart/related", parameters: { start: "<missing>" }, childNodes: [resource.node] }, [resource]);
	t.after(() => bad.cache.dispose());
	assert.equal((await bad.reader.read(ref)).bodyStatus, "unreadable"); assert.deepEqual(bad.requested, []);
	const named = part("text/plain", "附件文本", { part: "1" }); named.node.disposition = "inline"; named.node.parameters!.name = "inline.txt";
	const html = part("text/html", "<p>外层正文</p>", { part: "2" });
	const attached = { part: "3", type: "message/rfc822", childNodes: [{ part: "3", type: "text/plain", size: 10 }] };
	const f = fixture({ type: "multipart/mixed", childNodes: [named.node, html.node, attached] }, [named, html]); t.after(() => f.cache.dispose());
	const result = await f.reader.read(ref);
	assert.equal(result.body, "外层正文"); assert.deepEqual(f.requested, ["2"]);
	const attachments = result.attachments as { part: string; type: string }[];
	assert.ok(attachments.some(p => p.part === "1"));
	assert.equal(attachments.find(p => p.part === "3")?.type, "message/rfc822");
});

test("非空原始部件解码为空、未知编码和空 plain 搭配不支持版本，均不能报告空正文", async t => {
	const encoded = part("text/plain", "@@@", { encoding: "base64" });
	const f = fixture(encoded.node, [encoded]); t.after(() => f.cache.dispose());
	assert.equal((await f.reader.read(ref)).bodyStatus, "unreadable");
	const unknown = part("text/plain", "encoded", { encoding: "x-unknown" });
	const g = fixture(unknown.node, [unknown]); t.after(() => g.cache.dispose());
	const result = await g.reader.read(ref);
	assert.equal(result.bodyStatus, "unreadable");
	assert.equal((result.reasons as { code: string }[])[0]?.code, "UNSUPPORTED_TRANSFER_ENCODING");
	const plain = part("text/plain", "", { part: "1" }); const rtf = part("text/rtf", "rtf", { part: "2" });
	const h = fixture({ type: "multipart/alternative", childNodes: [plain.node, rtf.node] }, [plain, rtf]); t.after(() => h.cache.dispose());
	const unsupported = await h.reader.read(ref);
	assert.equal(unsupported.bodyStatus, "unreadable"); assert.match(JSON.stringify(unsupported.reasons), /text\/rtf/);
});

test("alternative 同类型优先后置版本，且不跨嵌套 mixed 正文组补 HTML", async t => {
	const one = part("text/html", "<p>旧版本</p>", { part: "1" }); const two = part("text/html", "<p>新版本</p>", { part: "2" });
	const f = fixture({ type: "multipart/alternative", childNodes: [one.node, two.node] }, [one, two]); t.after(() => f.cache.dispose());
	assert.equal((await f.reader.read(ref)).body, "新版本"); assert.deepEqual(f.requested, ["2"]);
	const plain = part("text/plain", "第一组正文", { part: "1.1" });
	const other = part("text/html", "<p>另一组正文</p>", { part: "2" });
	const g = fixture({ type: "multipart/mixed", childNodes: [
		{ part: "1", type: "multipart/alternative", childNodes: [plain.node] }, other.node,
	] }, [plain, other]); t.after(() => g.cache.dispose());
	const result = await g.reader.read(ref);
	assert.equal(result.body, "第一组正文"); assert.equal(result.htmlAvailable, false);
	assert.equal((await g.reader.read({ ...ref, format: "html" })).bodyStatus, "unreadable");
});

test("HTML 空版本或 mixed 首组空，不能代表其他非空正文也为空", async t => {
	const plain = part("text/plain", "有效正文", { part: "1" }); const html = part("text/html", "", { part: "2" });
	const f = fixture(alternative(plain, html), [plain, html]); t.after(() => f.cache.dispose());
	const requested = await f.reader.read({ ...ref, format: "html" });
	assert.equal(requested.bodyStatus, "unreadable"); assert.equal(requested.message, "无法读取邮件正文");
	assert.equal((requested.reasons as { code: string }[])[0]?.code, "BODY_EMPTY_VERSION");
	assert.deepEqual(f.requested, ["2"]);
	const empty = part("text/plain", "", { part: "1.1" });
	const other = part("text/plain", "后续正文", { part: "2" });
	const g = fixture({ type: "multipart/mixed", childNodes: [
		{ part: "1", type: "multipart/alternative", childNodes: [empty.node] }, other.node,
	] }, [empty, other]); t.after(() => g.cache.dispose());
	const result = await g.reader.read(ref);
	assert.equal(result.bodyStatus, "unreadable"); assert.equal(result.message, "无法读取邮件正文");
	const encrypted = part("application/pkcs7-mime", "nonempty", { part: "2" });
	const h = fixture({ type: "multipart/mixed", childNodes: [empty.node, encrypted.node] }, [empty, encrypted]);
	t.after(() => h.cache.dispose());
	assert.equal((await h.reader.read(ref)).bodyStatus, "unreadable");
});
