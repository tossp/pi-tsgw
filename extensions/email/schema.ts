import { Type } from "typebox";

const objectOptions = { additionalProperties: false } as const;
const line = { pattern: "^[^\\r\\n\\u0000]*$" };
const id = Type.String({ ...line, minLength: 1 });
const mailbox = Type.String({ ...line, minLength: 1 });
const uid = Type.Integer({ minimum: 1, maximum: 4294967295 });
const address = Type.String({ pattern: /^[^\s<>(),;:@"\\\[\]]+@[^\s<>(),;:@"\\\[\]]+$/u.source });
const refFields = { account: id, mailbox, uidValidity: Type.String({ pattern: "^[1-9][0-9]{0,9}$" }) };
export const messageRefSchema = Type.Object({ ...refFields, uid }, objectOptions);
const batchFields = { ...refFields, uids: Type.Array(uid, { minItems: 1, uniqueItems: true }) };
const pageFields = {
	account: id, mailbox: Type.Optional(mailbox),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	beforeUid: Type.Optional(uid),
};
const refresh = Type.Optional(Type.Boolean());
const queryFields = {
	from: Type.Optional(Type.String(line)), to: Type.Optional(Type.String(line)),
	subject: Type.Optional(Type.String(line)), body: Type.Optional(Type.String()), text: Type.Optional(Type.String()),
	since: Type.Optional(Type.String({ format: "date" })), before: Type.Optional(Type.String({ format: "date" })),
	unread: Type.Optional(Type.Boolean()), flagged: Type.Optional(Type.Boolean()),
	headers: Type.Optional(Type.Record(Type.String({ pattern: "^[!-9;-~]+$" }), Type.String(line), objectOptions)),
};

export const schemas = {
	accounts: Type.Object({}, objectOptions),
	mailboxes: Type.Object({ account: id }, objectOptions),
	list: Type.Object(pageFields, objectOptions),
	search: Type.Object({ ...pageFields, query: Type.Object(queryFields, { ...objectOptions, minProperties: 1 }) }, objectOptions),
	read: Type.Object({
		...refFields, uid, refresh,
		format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("html")], {
			description: "默认 text：纯文本优先，缺失或空白时将 HTML 转文字；html：按需读取原 HTML 版本，不执行或加载其中资源。",
		})),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 })),
	}, objectOptions),
	headers: Type.Object({ ...refFields, uid, refresh }, objectOptions),
	attachment: Type.Object({ ...refFields, uid, refresh, part: Type.String({ pattern: "^[1-9][0-9]*(?:\\.[1-9][0-9]*)*$" }), path: id }, objectOptions),
	mark: Type.Object({ ...batchFields, read: Type.Optional(Type.Boolean()), flagged: Type.Optional(Type.Boolean()) }, {
		...objectOptions, anyOf: [{ required: ["read"] }, { required: ["flagged"] }],
	}),
	move: Type.Object({ ...batchFields, targetMailbox: mailbox }, objectOptions),
	trash: Type.Object({ ...batchFields, markRead: Type.Optional(Type.Boolean()) }, objectOptions),
	purge: Type.Object(batchFields, objectOptions),
	junk: Type.Object(batchFields, objectOptions),
	not_junk: Type.Object(batchFields, objectOptions),
	send: Type.Object({
		smtp: Type.Optional(id), to: Type.Array(address, { minItems: 1 }),
		cc: Type.Optional(Type.Array(address)), bcc: Type.Optional(Type.Array(address)),
		subject: Type.String(line), text: Type.Optional(Type.String()), html: Type.Optional(Type.String()),
		fromAddress: Type.Optional(address), fromName: Type.Optional(Type.String(line)),
		replyToMessage: Type.Optional(messageRefSchema),
		attachments: Type.Optional(Type.Array(Type.Object({
			path: id, filename: Type.Optional(Type.String(line)), contentType: Type.Optional(Type.String(line)),
		}, objectOptions))),
	}, { ...objectOptions, anyOf: [{ required: ["text"] }, { required: ["html"] }] }),
};

export const emailOutputSchema = Type.Object({
	ok: Type.Boolean(),
	data: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() }, objectOptions)),
}, objectOptions);
