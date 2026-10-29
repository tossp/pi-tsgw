export interface MessageRef {
	account: string;
	mailbox: string;
	uidValidity: string;
	uid: number;
}

export interface MessageBatch extends Omit<MessageRef, "uid"> { uids: number[]; }
export interface ListInput { account: string; mailbox?: string; limit?: number; beforeUid?: number; }
export interface SearchInput extends ListInput {
	query: {
		from?: string; to?: string; subject?: string; body?: string; text?: string;
		since?: string; before?: string; unread?: boolean; flagged?: boolean;
		headers?: Record<string, string>;
	};
}
export interface ReadInput extends MessageRef {
	refresh?: boolean;
	format?: "text" | "html";
	offset?: number;
	maxChars?: number;
}
export interface AttachmentInput extends ReadInput { part: string; path: string; }
export interface MarkInput extends MessageBatch { read?: boolean; flagged?: boolean; }
export interface MoveInput extends MessageBatch { targetMailbox: string; }
export interface TrashInput extends MessageBatch { markRead?: boolean; }
export type MutationAction = "mark" | "move" | "trash" | "purge" | "junk" | "not_junk";
export type MutationInput = MarkInput | MoveInput | TrashInput | MessageBatch;
export type OperationStatus = "success" | "failed" | "unknown";
export interface MutationItem {
	uid: number;
	status: OperationStatus;
	steps: { action: string; status: OperationStatus }[];
	message?: string;
	destination?: { mailbox: string; uidValidity?: string; uid?: number };
}
export interface MutationResult {
	status: "success" | "partial" | "failed" | "unknown";
	account: string;
	mailbox: string;
	uidValidity: string;
	items: MutationItem[];
}

export interface SendInput {
	smtp?: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	text?: string;
	html?: string;
	fromAddress?: string;
	fromName?: string;
	replyToMessage?: MessageRef;
	attachments?: { path: string; filename?: string; contentType?: string }[];
}
export interface ThreadHeaders { inReplyTo: string; references: string[]; }
export interface SendResult {
	status: "success" | "partial" | "failed" | "unknown";
	smtp: string;
	messageId?: string;
	accepted?: string[];
	rejected?: string[];
	message?: string;
}

/** 仅本组件主动构造的安全错误可进入工具结果；协议库原始错误不得直接透传。 */
export class EmailError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}
