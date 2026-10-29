import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { compile } from "html-to-text";
import type { ImapFlow, MessageStructureObject } from "imapflow";
import { EmailCache } from "./cache.ts";
import { messageCacheKey } from "./message.ts";
import { EmailError, type ReadInput } from "./types.ts";

const BODY_BUDGET = 8 * 1024 * 1024;
const htmlText = compile({
	wordwrap: false,
	// 输入已受读取预算约束；禁止转换器另行静默截断并向 stderr 写入信息。
	limits: { maxInputLength: undefined },
	selectors: [
		{ selector: "table", format: "dataTable", options: { uppercaseHeaderCells: false, maxColumnWidth: undefined } },
		{ selector: "img", format: "skip" },
		{ selector: "script", format: "skip" },
		{ selector: "style", format: "skip" },
		{ selector: "iframe", format: "skip" },
	],
});

/** MIME 树来自 ImapFlow 的 BODYSTRUCTURE 解析；related 的其他子项不是正文版本。 */
function bodyCandidates(node: MessageStructureObject | undefined, allGroups = false): MessageStructureObject[] {
	if (!node) return [];
	if (node.disposition?.trim().toLowerCase() === "attachment" || node.dispositionParameters?.filename || node.parameters?.name)
		return [];
	const type = node.type.trim().toLowerCase();
	if (type === "message/rfc822") return [];
	const children = node.childNodes ?? [];
	if (type === "multipart/related") {
		const start = node.parameters?.start;
		const root = start ? children.find(child => child.id === start) : children[0];
		return root ? bodyCandidates(root, allGroups) : [node];
	}
	if (type === "multipart/alternative") return [...children].reverse().flatMap(child => bodyCandidates(child, allGroups));
	if (type.startsWith("multipart/")) {
		// mixed 中的后续内联文本可能是页脚，不能拿它替换或拼接首个正文组。
		const groups = children.filter(child => {
			const kind = child.type.trim().toLowerCase();
			return allGroups || kind.startsWith("text/") || kind.startsWith("multipart/");
		}).map(child => ({ node: child, candidates: bodyCandidates(child, allGroups) })).filter(group => group.candidates.length > 0);
		// 判定全信为空时还需核对未被选作主正文的其他组，不能以空版本代表全信。
		if (allGroups) return groups.flatMap(group => group.candidates);
		const primary = groups[0];
		if (!primary) return [node];
		// 兼容既有 mixed 下直接放 plain/html 的邮件；不能跨嵌套正文组寻找其他版本。
		if (primary.node.type.trim().toLowerCase() !== "text/plain") return primary.candidates;
		const html = groups.find(group => group.node.type.trim().toLowerCase() === "text/html");
		return html ? [...primary.candidates, ...html.candidates] : primary.candidates;
	}
	return [node];
}

function partNumber(node: MessageStructureObject, root: MessageStructureObject | undefined): string | undefined {
	return node.part || (node === root && !node.childNodes?.length ? "1" : undefined);
}

/** 解码交给现有 ImapFlow（libmime/mailsplit），不重新实现 MIME、传输编码或字符集。 */
async function decodedPart(client: ImapFlow, input: ReadInput, node: MessageStructureObject, part: string,
	cache: EmailCache, signal?: AbortSignal): Promise<{ text: string; cacheHit: boolean }> {
	if (node.size === undefined || !Number.isFinite(node.size) || node.size < 0)
		throw new EmailError("BODY_SIZE_UNKNOWN", "正文 MIME 部分缺少可靠大小，无法确认读取完整性。");
	if (node.size > BODY_BUDGET) throw new EmailError("BODY_TOO_LARGE", "正文 MIME 部分超过读取预算，未返回截断内容。");
	const key = messageCacheKey(input, `body:${part}`);
	const hit = cache.get(key);
	if (typeof hit === "string") return { text: hit, cacheHit: true };
	const download = await client.download(String(input.uid), part, { uid: true, maxBytes: BODY_BUDGET + 1 });
	if (!download.content) throw new EmailError("PART_MISSING", "服务器未返回指定正文 MIME 部分。");
	const encoding = download.meta.encoding?.trim().toLowerCase();
	if (encoding && !["7bit", "8bit", "binary", "base64", "quoted-printable"].includes(encoding)) {
		download.content.destroy();
		throw new EmailError("UNSUPPORTED_TRANSFER_ENCODING", "正文传输编码不支持，未将编码内容冒充可读文字。");
	}
	const charset = download.meta.charset?.toLowerCase().replace(/[^a-z0-9]+/g, "");
	if (charset && !["ascii", "usascii", "utf8"].includes(charset)) {
		download.content.destroy();
		throw new EmailError("UNSUPPORTED_CHARSET", "正文字符集无法识别，未将原始字节冒充可读文字。");
	}
	const chunks: Buffer[] = [];
	let bytes = 0;
	const abort = () => download.content.destroy(new EmailError("CANCELLED", "邮件读取已取消。"));
	signal?.addEventListener("abort", abort, { once: true });
	try {
		signal?.throwIfAborted();
		for await (const chunk of download.content) {
			signal?.throwIfAborted();
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > BODY_BUDGET) throw new EmailError("BODY_TOO_LARGE", "正文解码后超过读取预算，未返回截断内容。");
			chunks.push(buffer);
		}
	} finally { signal?.removeEventListener("abort", abort); }
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)); }
	catch { throw new EmailError("BODY_DECODE_FAILED", "正文解码结果不是合法 UTF-8，无法提取可靠文字。"); }
	cache.set(key, text, "content");
	return { text, cacheHit: false };
}

export async function readMessageBody(client: ImapFlow, input: ReadInput, root: MessageStructureObject | undefined,
	cache: EmailCache, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const candidates = bodyCandidates(root);
	const htmlAvailable = candidates.some(node => node.type.trim().toLowerCase() === "text/html");
	const supported = candidates.filter(node => ["text/plain", "text/html"].includes(node.type.trim().toLowerCase()));
	if (input.refresh) for (const node of supported) {
		const part = partNumber(node, root);
		if (part) cache.delete(messageCacheKey(input, `body:${part}`));
	}
	const ordered = input.format === "html" ? supported.filter(node => node.type.trim().toLowerCase() === "text/html") :
		[...supported.filter(node => node.type.trim().toLowerCase() === "text/plain"),
			...supported.filter(node => node.type.trim().toLowerCase() === "text/html")];
	const base = { body: null, bodySource: null, contentType: null, bodyFormat: input.format ?? "text",
		nextOffset: null, truncated: false, cacheHit: false, htmlAvailable };
	const reasons: { code: string; reason: string; part?: string }[] = [];
	let emptyParts = 0;
	let last: Record<string, unknown> = {};
	for (const node of ordered) {
		const type = node.type.trim().toLowerCase();
		const part = partNumber(node, root);
		last = { part, contentType: type };
		if (!part || !/^\d+(?:\.\d+)*$/.test(part)) {
			reasons.push({ code: "BODY_STRUCTURE_INVALID", reason: "正文 MIME 部分缺少有效编号。" });
			continue;
		}
		try {
			const decoded = await decodedPart(client, input, node, part, cache, signal);
			if (decoded.text.length === 0 && node.size === 0) { emptyParts++; continue; }
			const body = type === "text/html" && input.format !== "html" ? htmlText(decoded.text) : decoded.text;
			if (!body.trim()) {
				reasons.push({ code: "BODY_NO_TEXT", reason: "正文部件非空，但只有空白或无法提取可读文字。", part });
				continue;
			}
			const { start, end } = bodyPage(body, input.offset ?? 0, input.maxChars ?? 32768);
			const truncated = end < body.length;
			return { ...base, ...last, bodyStatus: "success", bodySource: type, body: body.slice(start, end),
				offset: start, totalChars: body.length, nextOffset: truncated ? end : null, truncated, cacheHit: decoded.cacheHit,
				message: truncated ? "正文输出已截断，请用 continuation 继续读取当前版本。" : "已提取当前正文版本。",
				pagination: "offset/nextOffset 为 UTF-16 单元；边界按完整 Unicode 字符调整，请用返回的 nextOffset 翻页。",
				...(truncated ? { continuation: { ...input, offset: end, refresh: false } } : {}),
				...(type === "text/plain" && htmlAvailable ? {
					htmlAlternative: { ...input, format: "html", offset: 0, refresh: false },
					versionNotice: "仅提取了纯文本版本，未比较 HTML；若当前内容只有页脚，请按 htmlAlternative 读取 HTML 版本，不能据此断言整封邮件信息已完整读取。",
				} : {}),
				...(reasons.length ? { warnings: reasons } : {}),
			};
		} catch (error) {
			if (signal?.aborted) throw error;
			reasons.push({ code: error instanceof EmailError ? error.code : "BODY_PARSE_FAILED",
				reason: error instanceof EmailError ? error.message : "正文 MIME 下载、解析或 HTML 转换失败，未返回不完整文字。", part });
		}
	}
	if (ordered.length > 0 && emptyParts === ordered.length && ordered.length === candidates.length &&
		bodyCandidates(root, true).every(node => node.size === 0 && ["text/plain", "text/html"].includes(node.type.trim().toLowerCase())))
		return { ...base, ...last, body: "", bodyStatus: "empty", totalChars: 0, message: "邮件正文为空" };
	if (emptyParts > 0 && !reasons.length)
		reasons.push({ code: "BODY_EMPTY_VERSION", reason: "所选正文版本为空，但其他正文内容尚未确认为空，不能判定整封邮件正文为空。" });
	const unsupported = candidates.filter(node => !supported.includes(node)).map(node => node.type);
	if (input.format !== "html" && unsupported.length)
		reasons.push({ code: "BODY_UNSUPPORTED", reason: `正文 MIME 类型不支持或结构无法提取：${unsupported.join("、")}。` });
	if (!ordered.length && !reasons.length) reasons.push({ code: "BODY_UNSUPPORTED", reason: input.format === "html" ? "没有可读取的 HTML 正文版本。" :
		"缺少可确认的正文结构，不能判定原始正文为空。" });
	return { ...base, ...last, bodyStatus: "unreadable", message: "无法读取邮件正文", reasons,
		...(reasons.some(reason => reason.code === "BODY_TOO_LARGE") ? { bodyTooLarge: true, budgetBytes: BODY_BUDGET,
			guidance: "可通过已有 attachment 工具显式导出返回的 part；转换型文本仍受该工具的无损导出限制。" } : {}),
	};
}

/** offset/nextOffset 是 UTF-16 单元；页边界不能落在合法代理对中间。 */
function bodyPage(body: string, offset: number, maxChars: number): { start: number; end: number } {
	const splitsPair = (at: number) => at > 0 && at < body.length &&
		body.charCodeAt(at - 1) >= 0xd800 && body.charCodeAt(at - 1) <= 0xdbff &&
		body.charCodeAt(at) >= 0xdc00 && body.charCodeAt(at) <= 0xdfff;
	let start = Math.min(offset, body.length);
	if (splitsPair(start)) start--;
	let end = Math.min(body.length, start + maxChars);
	if (splitsPair(end)) end += end - start === 1 ? 1 : -1;
	return { start, end };
}
