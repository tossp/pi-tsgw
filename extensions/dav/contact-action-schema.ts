import { Type, type Static } from "typebox";

const objectOptions = { additionalProperties: false } as const;
const id = Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const url = Type.String({ minLength: 1, description: "发现或列表返回的完整集合/资源 URL，不按 UID 推导路径。" });
const collection = { account: id, collectionUrl: url };
const target = { account: id, resourceUrl: url, uid: id,
	etag: Type.String({ minLength: 1, description: "上次读取返回的单个强 ETag；不接受弱标签、通配符或标签列表。" }) };
const name = Type.String({ minLength: 1, pattern: "\\S", description: "显示名称 FN，不修改结构化 N；不能为 null。" });
const org = Type.Array(Type.String(), { minItems: 1, description: "明确的组织/部门 TEXT 组件数组；每项由库独立转义，不传分号拼接字符串。" });
const properties = Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
	description: "完整逻辑属性行，同名属性整组替换；[] 不修改。不能更改 UID、VERSION、REV，创建也禁止 FN。与首项字段或 removeProperties 同名时拒绝。",
}));
const nullable = <T extends ReturnType<typeof Type.String> | typeof org>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

export const contactActionSchemas = {
	contact_search: Type.Object({ ...collection,
		query: Type.String({ minLength: 1, pattern: "\\S", description: "本地多字段大小写不敏感子串搜索，电话忽略空白及常用标点；不使用服务端 FN 筛选。" }),
	}, objectOptions),
	contact_create: Type.Object({ ...collection, name,
		email: Type.Optional(Type.String()), phone: Type.Optional(Type.String()), org: Type.Optional(org),
		note: Type.Optional(Type.String()), properties,
	}, objectOptions),
	contact_update: Type.Object({ ...target, name: Type.Optional(name),
		revisionRepair: Type.Optional(Type.Object({
			rev: Type.Union([Type.String({ minLength: 1, pattern: "^(?![\\s\\S]*[\\r\\n])",
				description: "单个 REV 值，不带属性名、参数或换行；由库按 vCard 版本判断有效性。实际更新仍正常生成本次新 REV。" }),
				Type.Null({ description: "明确丢弃异常源 REV；实际更新仍正常生成本次新 REV，不承诺最终缺省。" })]),
		}, objectOptions)),
		email: nullable(Type.String()), phone: nullable(Type.String({ description: "首个普通电话；显式 VALUE=uri 的首项须用 properties 完整替换，null 仍可只删首项。" })),
		org: nullable(org), note: nullable(Type.String()),
		properties, removeProperties: Type.Optional(Type.Array(id, {
			description: "显式删除整个属性组，仅接受不带分组/参数的基础名称；不能删除 UID、VERSION、FN 或受管 REV。首项字段 null 仅删除第一项。",
		})),
	}, objectOptions),
	contact_delete: Type.Object(target, objectOptions),
};

export type ContactSearchInput = Static<typeof contactActionSchemas.contact_search>;
export type ContactCreateInput = Static<typeof contactActionSchemas.contact_create>;
export type ContactUpdateInput = Static<typeof contactActionSchemas.contact_update>;
export type ContactDeleteInput = Static<typeof contactActionSchemas.contact_delete>;
