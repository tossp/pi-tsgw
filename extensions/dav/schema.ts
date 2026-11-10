import { Type } from "typebox";
import { calendarWriteSchemas } from "./calendar-write-schema.ts";
import { contactActionSchemas } from "./contact-action-schema.ts";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const url = Type.String({ minLength: 1, description: "collections 或列表返回的同源完整 URL，不按 UID 拼接路径。" });
const account = { account: id };
const collection = { ...account, collectionUrl: url };
const uid = Type.Optional(id);
const timeZone = Type.Optional(Type.String({ minLength: 1, description: "显式 IANA 时区；未传时只采用账户配置，不用主机时区。" }));
const windowTime = Type.String({ minLength: 1, description: "UTC 基本时间 YYYYMMDDTHHmmssZ，或带 Z/偏移的 ISO 8601；起点含、终点不含。" });
const getCalendar = Type.Object({ ...account, resourceUrl: url, uid: id,
	recurrenceId: Type.Optional(Type.String({ ...id, description: "已有例外的完整 RECURRENCE-ID 逻辑行；省略选择主件，不能直接用展开实例身份代替。" })),
	raw: Type.Optional(Type.Boolean()),
}, objectOptions);

export const schemas = {
	...calendarWriteSchemas,
	...contactActionSchemas,
	accounts: Type.Object({}, objectOptions),
	collections: Type.Object({ ...account, kind: Type.Union([Type.Literal("calendar"), Type.Literal("addressbook")]) }, objectOptions),
	event_list: Type.Object({ ...collection, uid, start: windowTime, end: windowTime, timeZone }, objectOptions),
	event_get: getCalendar,
	todo_list: Type.Object({ ...collection, uid, status: Type.Optional(id) }, objectOptions),
	todo_get: getCalendar,
	journal_list: Type.Object({ ...collection, uid, status: Type.Optional(id) }, objectOptions),
	journal_get: getCalendar,
	contact_list: Type.Object(collection, objectOptions),
	contact_get: Type.Object({ ...account, resourceUrl: url, uid, raw: Type.Optional(Type.Boolean()) }, objectOptions),
};

export const davOutputSchema = Type.Object({
	ok: Type.Boolean(), data: Type.Optional(Type.Unknown()),
	error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String(), details: Type.Optional(Type.Unknown()) }, objectOptions)),
}, objectOptions);
