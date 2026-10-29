import type { FetchMessageObject, ImapFlow, MessageStructureObject, SearchObject } from "imapflow";
import { EmailError, type ListInput, type SearchInput } from "./types.ts";

export function summary(message: FetchMessageObject): Record<string, unknown> {
	const envelope = message.envelope;
	return {
		uid: message.uid, subject: envelope?.subject, messageId: envelope?.messageId,
		date: dateValue(envelope?.date), internalDate: dateValue(message.internalDate),
		from: envelope?.from, to: envelope?.to, cc: envelope?.cc, replyTo: envelope?.replyTo,
		flags: [...(message.flags ?? [])], size: message.size,
	};
}

function dateValue(value: Date | string | undefined): string | undefined {
	return value instanceof Date ? (Number.isNaN(value.getTime()) ? undefined : value.toISOString()) : value;
}

export function serverQuery(input: SearchInput): SearchObject {
	const { headers, unread, ...fields } = input.query;
	return { ...fields, ...(headers ? { header: headers } : {}), ...(unread === undefined ? {} : { seen: !unread }) };
}

/** 先取服务器 UID，再仅请求这一页的摘要；序号不能作为跨调用引用。 */
export async function queryPage(client: ImapFlow, input: ListInput, query: SearchObject): Promise<Record<string, unknown>> {
	if (!client.mailbox) throw new EmailError("MAILBOX_MISSING", "未打开指定文件夹。");
	const limit = input.limit ?? 50;
	const found = await client.search(query, { uid: true });
	if (!Array.isArray(found)) throw new EmailError("SEARCH_FAILED", "服务器未完成邮件查询，请稍后重试。");
	const uids = [...new Set(found)]
		.filter(uid => input.beforeUid === undefined || uid < input.beforeUid)
		.sort((a, b) => b - a);
	const page = uids.slice(0, limit);
	const messages: FetchMessageObject[] = [];
	if (page.length) {
		for await (const message of client.fetch(page, { uid: true, envelope: true, flags: true, size: true, internalDate: true }, { uid: true })) {
			if (page.includes(message.uid)) messages.push(message);
		}
	}
	messages.sort((a, b) => b.uid - a.uid);
	return {
		account: input.account, mailbox: input.mailbox ?? "INBOX", uidValidity: client.mailbox.uidValidity.toString(),
		messages: messages.map(summary), nextBeforeUid: uids.length > limit ? page.at(-1) : null,
	};
}

export interface MimePart {
	part: string; name?: string; type: string; size?: number; attachment: boolean;
	charset?: string; disposition?: string; format?: string;
}

/** 附件内嵌邮件不作为外层正文；单节点正文的标准下载编号为 1。 */
export function mimeParts(root: MessageStructureObject | undefined): MimePart[] {
	const result: MimePart[] = [];
	function visit(node: MessageStructureObject, inheritedAttachment = false, isRoot = false): void {
		const name = node.dispositionParameters?.filename ?? node.parameters?.name;
		const type = node.type.toLowerCase().trim();
		const disposition = node.disposition?.toLowerCase().trim();
		const attachment = inheritedAttachment || disposition === "attachment" || !!name ||
			(!type.startsWith("multipart/") && !["text/plain", "text/html"].includes(type));
		const part = node.part || (isRoot && !node.childNodes?.length ? "1" : undefined);
		if (part && /^\d+(?:\.\d+)*$/.test(part)) result.push({ part, name, type, size: node.size, attachment,
			charset: node.parameters?.charset?.toLowerCase().trim(), disposition,
			format: node.parameters?.format?.toLowerCase().trim() });
		for (const child of node.childNodes ?? []) visit(child, attachment);
	}
	if (root) visit(root, false, true);
	return result;
}
