import type { FetchMessageObject, FetchQueryObject, ImapFlow } from "imapflow";
import { EmailError, type MessageRef } from "./types.ts";

export function assertMailbox(client: ImapFlow, ref: Omit<MessageRef, "uid">): void {
	if (!client.mailbox || client.mailbox.uidValidity.toString() !== ref.uidValidity)
		throw new EmailError("STALE_MAILBOX", "文件夹身份已变化，请重新查询邮件清单。");
}

export async function requireMessage(client: ImapFlow, ref: MessageRef, query: FetchQueryObject): Promise<FetchMessageObject> {
	const message = await client.fetchOne(String(ref.uid), { ...query, uid: true }, { uid: true });
	if (!message || message.uid !== ref.uid)
		throw new EmailError("MESSAGE_MISSING", "指定邮件已不存在，请重新查询清单。");
	return message;
}

export function messageCacheKey(ref: MessageRef, part: string): string {
	return JSON.stringify([ref.account, ref.mailbox, ref.uidValidity, ref.uid, part]);
}
