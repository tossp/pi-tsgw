import { Buffer } from "node:buffer";
import { open, unlink } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { TextDecoder } from "node:util";
import { EmailCache, EMAIL_CACHE_MAX_ENTRY_BYTES } from "./cache.ts";
import { readMessageBody } from "./body.ts";
import type { ImapSessions } from "./imap-session.ts";
import { assertMailbox, messageCacheKey, requireMessage } from "./message.ts";
import { mimeParts, queryPage, serverQuery, summary } from "./query.ts";
import { EmailError, type AttachmentInput, type ListInput, type MessageRef, type ReadInput, type SearchInput, type ThreadHeaders } from "./types.ts";

const HEADER_BUDGET = 1024 * 1024;

function validMessageId(value: string | undefined): value is string {
	return !!value && /^<[^<>\s@]+@[^<>\s@]+>$/.test(value) && /^[\x21-\x7e]+$/.test(value);
}

function missingPart(): EmailError { return new EmailError("PART_MISSING", "指定 MIME 部分不存在，请重新读取邮件结构。"); }
function identity(ref: MessageRef): Record<string, unknown> {
	return { account: ref.account, mailbox: ref.mailbox, uidValidity: ref.uidValidity, uid: ref.uid };
}

export class EmailReader {
	constructor(private readonly sessions: ImapSessions, private readonly cache: EmailCache) {}

	mailboxes(account: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.sessions.run(account, undefined, signal, async client => ({
			account, mailboxes: (await client.list()).map(box => ({
				path: box.path, name: box.name, delimiter: box.delimiter,
				flags: [...box.flags], specialUse: box.specialUse, listed: box.listed, subscribed: box.subscribed,
			})),
		}));
	}

	list(input: ListInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.sessions.run(input.account, input.mailbox ?? "INBOX", signal, client => queryPage(client, input, { all: true }));
	}

	search(input: SearchInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.sessions.run(input.account, input.mailbox ?? "INBOX", signal, client => queryPage(client, input, serverQuery(input)));
	}

	read(input: ReadInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.sessions.run(input.account, input.mailbox, signal, async client => {
			assertMailbox(client, input);
			const message = await requireMessage(client, input, { envelope: true, bodyStructure: true });
			return { ...identity(input), ...summary(message),
				attachments: mimeParts(message.bodyStructure).filter(part => part.attachment),
				...await readMessageBody(client, input, message.bodyStructure, this.cache, signal) };
		});
	}

	headers(input: ReadInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.sessions.run(input.account, input.mailbox, signal, async client => {
			assertMailbox(client, input);
			const key = messageCacheKey(input, "headers");
			if (input.refresh) this.cache.delete(key);
			const hit = this.cache.get(key);
			let raw = typeof hit === "string" ? hit : undefined;
			if (raw === undefined) {
				const message = await requireMessage(client, input, { headers: true });
				if (!message.headers) throw new EmailError("HEADERS_MISSING", "服务器未返回邮件原始头部。");
				if (message.headers.length > HEADER_BUDGET)
					throw new EmailError("HEADERS_TOO_LARGE", "原始头部超过读取预算，未返回截断头部。");
				try {
					// ignoreBOM 保留原始 BOM；严格拒绝损坏字节，而非以替换字符声称完整。
					raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(message.headers);
				} catch {
					throw new EmailError("HEADERS_ENCODING_UNSUPPORTED", "原始头部不是合法 UTF-8，无法无损返回，未输出损坏或截断内容。");
				}
				this.cache.set(key, raw, "content");
			}
			return { ...identity(input), headers: raw, complete: true, cacheHit: typeof hit === "string" };
		});
	}

	attachment(input: AttachmentInput, signal?: AbortSignal): Promise<Record<string, unknown>> {
		return this.sessions.run(input.account, input.mailbox, signal, async client => {
			assertMailbox(client, input);
			const key = messageCacheKey(input, `attachment:${input.part}`);
			if (input.refresh) this.cache.delete(key);
			const message = await requireMessage(client, input, { bodyStructure: true });
			const part = mimeParts(message.bodyStructure).find(part => part.part === input.part);
			if (!part) throw missingPart();
			const textConversion = (!part.disposition || part.disposition === "inline") &&
				["text/plain", "text/html", "text/x-amp-html"].includes(part.type) &&
				(part.format === "flowed" || (part.charset && !["ascii", "usascii", "utf8"].includes(part.charset.replace(/[^a-z0-9]+/g, ""))));
			if (textConversion)
				throw new EmailError("ATTACHMENT_TRANSFORM_UNSUPPORTED", "该文本 MIME 部分会被下载库转换字符集或 flowed 格式，首版暂不支持无损导出；未创建文件。");
			const cached = this.cache.get(key);
			// 先独占创建，只有成功创建后本次调用才拥有清理权限。
			const file = await open(input.path, "wx", 0o600);
			let complete = false;
			try {
				signal?.throwIfAborted();
				let size = 0;
				if (Buffer.isBuffer(cached)) {
					await file.writeFile(cached, { signal });
					size = cached.length;
				} else {
					const download = await client.download(String(input.uid), part.part, { uid: true });
					if (!download.content) throw missingPart();
					let chunks: Buffer[] | undefined = [];
					const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
						size += chunk.length;
						if (size > EMAIL_CACHE_MAX_ENTRY_BYTES) chunks = undefined;
						else chunks?.push(Buffer.from(chunk));
						callback(null, chunk);
					} });
					await pipeline(download.content, meter, file.createWriteStream(), { signal });
					if (chunks) this.cache.set(key, Buffer.concat(chunks, size), "content");
				}
				signal?.throwIfAborted();
				await file.close();
				complete = true;
				return { ...identity(input), path: input.path, part: part.part, name: part.name, type: part.type, size, cacheHit: Buffer.isBuffer(cached) };
			} finally {
				if (!complete) {
					await file.close().catch(() => {});
					await unlink(input.path).catch(() => {});
				}
			}
		});
	}

	thread(ref: MessageRef, signal?: AbortSignal): Promise<ThreadHeaders> {
		return this.sessions.run(ref.account, ref.mailbox, signal, async client => {
			assertMailbox(client, ref);
			const message = await requireMessage(client, ref, { envelope: true, headers: ["References"] });
			const id = message.envelope?.messageId;
			if (!validMessageId(id))
				throw new EmailError("MESSAGE_ID_MISSING", "原邮件没有合法 Message-ID，无法安全关联回复。");
			if ((message.headers?.length ?? 0) > HEADER_BUDGET)
				throw new EmailError("HEADERS_TOO_LARGE", "线程引用头部超过读取预算。");
			// 仅展开库已筛选出的 References 字段，不解析 MIME 或替换原始头部接口。
			const unfolded = (message.headers?.toString("utf8") ?? "").replace(/\r?\n[ \t]+/g, " ");
			const references: string[] = [];
			for (const line of unfolded.split(/\r?\n/)) {
				if (!/^references:/i.test(line)) continue;
				for (const match of line.slice(line.indexOf(":") + 1).matchAll(/<[^<>\s@]+@[^<>\s@]+>/g)) {
					if (validMessageId(match[0])) references.push(match[0]);
				}
			}
			if (!references.length && validMessageId(message.envelope?.inReplyTo))
				references.push(message.envelope.inReplyTo);
			return { inReplyTo: id, references: [...new Set([...references, id])] };
		});
	}
}
