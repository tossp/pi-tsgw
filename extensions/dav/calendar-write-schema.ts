import { Type } from "typebox";

const options = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const url = Type.String({ minLength: 1, description: "已发现的同源完整 URL；创建仅接受明确集合，不接受自定资源路径。" });
const basicTime = Type.String({ pattern: "^\\d{8}(?:T\\d{6}Z?)?$" });
const time = Type.Union([
	basicTime,
	Type.Object({ value: basicTime,
		valueType: Type.Optional(Type.Union([Type.Literal("DATE"), Type.Literal("DATE-TIME")])),
		tzid: Type.Optional(Type.String({ minLength: 1 })),
	}, options),
], { description: "仅基本日历时间 YYYYMMDD / YYYYMMDDTHHmmss[Z]，不支持 ISO；对象 DATE 须声明 valueType。创建不猜时区；更新字符串沿用原表示，新增时间属性须用对象。TZID 明确指定，不将当地重复系列固定转 UTC。" });
const nullableTime = Type.Optional(Type.Union([time, Type.Null()]));
const scalar = Type.Optional(Type.String());
const nullableScalar = Type.Optional(Type.Union([Type.String(), Type.Null()]));
const properties = Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
	description: "未折行的完整逻辑属性；更新按基本名整组替换，省略或 [] 不修改。不得与便捷字段冲突，不能设置 UID/VERSION/RECURRENCE-ID 或受管 DTSTAMP/LAST-MODIFIED/SEQUENCE。",
}));
const alarms = Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
	description: "完整 VALARM 块，由库验证依赖；省略保留，[] 清空。不支持日记提醒。",
}));
const create = { account: id, collectionUrl: url, summary: Type.String(),
	description: scalar, location: scalar, status: scalar, properties };
const identity = { account: id, resourceUrl: url, uid: id,
	etag: Type.String({ minLength: 1, description: "上次读取并确认的单个强 ETag；不接受弱标签、通配符或列表。" }) };
const utcRevisionTime = Type.String({ minLength: 16, maxLength: 16, pattern: "^\\d{8}T\\d{6}Z$", description: "已确认的源时间修正值，必须明确换算为基本 UTC；不自动猜时区。实际更新仍生成本次修订时间。" });
const revisionRepair = Type.Optional(Type.Object({
	dtstamp: Type.Optional(utcRevisionTime),
	lastModified: Type.Optional(Type.Union([utcRevisionTime, Type.Null()])),
	sequence: Type.Optional(Type.Union([Type.Integer({ minimum: 0, maximum: 2147483647 }), Type.Null()])),
}, { ...options, minProperties: 1, description: "仅修正该目标直接属性源诊断指出的受管字段，须先说明并取得明确授权；省略仍拒绝异常源。null 只可丢弃可选旧值；SEQUENCE 从修正值或缺省零递增，修订时间正常刷新。仍检查最终整份资源，不是关闭校验开关。" }));
const update = { ...identity, revisionRepair,
	recurrenceId: Type.Optional(Type.String({ minLength: 1, description: "已有例外的完整 RECURRENCE-ID 逻辑行；省略只选主件，拒绝 RANGE，不隐式创建例外。" })),
	summary: nullableScalar, description: nullableScalar, location: nullableScalar, status: nullableScalar,
	properties,
	removeProperties: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		description: "显式删除整组基本属性名；不能与同名字段/properties 混用，也不能删除身份或受管修订元数据。",
	})),
};
const rrule = Type.Optional(Type.String({ minLength: 1, description: "RRULE 的完整值（不带 RRULE:）；与 properties/removeProperties 的 RRULE 操作互斥。" }));
const deleteResource = Type.Object(identity, { ...options,
	description: "删除整份资源而非单次发生项；GET 版本核对及整资源 kind/UID 校验后条件删除，不接受 recurrenceId。" });

export const calendarWriteSchemas = {
	event_create: Type.Object({ ...create, start: time, end: Type.Optional(time), rrule, alarms }, options),
	event_update: Type.Object({ ...update, start: nullableTime, end: nullableTime,
		rrule: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])), alarms }, options),
	event_delete: deleteResource,
	todo_create: Type.Object({ ...create, start: Type.Optional(time), due: Type.Optional(time), alarms }, options),
	todo_update: Type.Object({ ...update, start: nullableTime, due: nullableTime, alarms }, options),
	todo_delete: deleteResource,
	journal_create: Type.Object({ ...create, date: time }, options),
	journal_update: Type.Object({ ...update, date: nullableTime }, options),
	journal_delete: deleteResource,
};
