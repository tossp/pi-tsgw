import assert from "node:assert/strict";
import { test } from "node:test";
import { DavClient } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { Compile } from "typebox/compile";
import { withDavAccount } from "./client.ts";
import { contactActionSchemas } from "./contact-action-schema.ts";
import { createContact, deleteContact, searchContacts, updateContact } from "./contact-actions.ts";
import { getContact, listContacts } from "./contacts.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = "synthetic";
const collectionUrl = "https://example.invalid/contacts/";
const resourceUrl = `${collectionUrl}one.vcf`;
const uid = "synthetic-uid";
const etag = '"v1"';
const target = { account, resourceUrl, uid, etag };
const card = (lines: string[] = [], version = "4.0") => ["BEGIN:VCARD", `VERSION:${version}`,
	`UID;VALUE=text:${uid}`, "FN:可读姓名", ...lines, "END:VCARD", ""].join("\r\n");
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function fixture(raw = card(), report = [raw]) {
	const seen: { method: string; body: string; headers: Headers }[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		const method = init!.method!;
		seen.push({ method, body: String(init!.body ?? ""), headers: new Headers(init!.headers) });
		if (method === "GET") return new Response(raw, { headers: { etag } });
		if (method === "REPORT") return new Response('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">' +
			report.map((data, i) => `<d:response><d:href>/contacts/${i}.vcf</d:href><d:propstat><d:prop>` +
				`<d:getetag>&quot;v1&quot;</d:getetag><c:address-data>${xml(data)}</c:address-data></d:prop>` +
				"<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>").join("") + "</d:multistatus>", { status: 207 });
		assert.ok(method === "PUT" || method === "DELETE");
		return new Response(null, { status: 204, headers: { etag: '"v2"' } });
	};
	const context: DavReadContext = { client: new DavClient({ baseUrl: collectionUrl, fetch }), ical, vcard };
	return { context, seen };
}
function failure(code: string, stage: string) {
	return (error: unknown) => {
		assert.ok(error instanceof DavToolError);
		assert.equal(error.code, code);
		assert.equal(error.details?.stage, stage);
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(JSON.stringify(error.details), /secret-source|private-value|BEGIN:VCARD/);
		return true;
	};
}

test("混合坏卡逐份保真，GET 默认带实际原文且不假称确认身份", async () => {
	const raw = "secret-source-not-a-card";
	const { context } = fixture(raw, [card(), raw]);
	const list = await listContacts(context, { account, collectionUrl });
	assert.equal(list.resourcesComplete, true);
	assert.equal(list.complete, false);
	assert.equal(list.items.length, 1);
	assert.equal(list.unresolvedResources[0]?.raw, raw);
	assert.equal(list.unresolvedResources[0]?.rawSource, "report");
	const get = await getContact(context, { account, resourceUrl, uid });
	assert.equal(get.complete, false);
	assert.equal(get.raw, raw);
	assert.equal(get.rawSource, "get");
	assert.equal(get.identityConfirmed, false);
	assert.equal(get.uid, undefined);
	assert.equal(get.properties, undefined);
});

test("联系人 GET 区分完整获取与业务解释，成功、坏卡和不可投影均报告资源已取得", async () => {
	for (const [raw, complete] of [[card(), true], ["synthetic-malformed", false],
		[card(["TEL;VALUE=x-opaque:synthetic-opaque"]), false]] as const) {
		const { context } = fixture(raw);
		const result = await getContact(context, { account, resourceUrl });
		assert.equal(result.resourcesComplete, true);
		assert.equal(result.complete, complete);
		assert.equal(result.resourceUrl, resourceUrl);
		assert.equal(result.etag, etag);
	}
});

test("不可投影 EMAIL/TEL 不伪装无电话，保留可靠姓名和匹配状态", async () => {
	for (const line of ["EMAIL;ENCODING=QUOTED-PRINTABLE:private-value", "TEL;VALUE=x-opaque:private-value"]) {
		const { context } = fixture(card([line]));
		const list = await listContacts(context, { account, collectionUrl });
		assert.equal(list.complete, false);
		assert.equal(list.items.length, 0);
		const unresolved = list.unresolvedResources[0]!;
		assert.equal(unresolved.stage, "projection");
		assert.equal(unresolved.name, "可读姓名");
		assert.equal(line.startsWith("EMAIL") ? unresolved.emails : unresolved.phones, undefined);
		const known = await searchContacts(context, { account, collectionUrl, query: "可读姓名" });
		assert.equal(known.complete, false);
		assert.equal(known.unresolvedResources[0]?.stage, "projection");
		assert.equal(known.unresolvedResources[0]?.matchStatus, "matched");
		const detail = await getContact(context, { account, resourceUrl, uid });
		assert.equal(detail.complete, false);
		assert.equal(detail.identityConfirmed, true);
		assert.equal(detail.name, "可读姓名");
		assert.equal(detail.rawSource, "get");
		await assert.rejects(getContact(context, { account, resourceUrl, uid: "other" }), { code: "NOT_FOUND" });
	}
});

test("未知搜索字段不当作未匹配；可靠命中无需谎称匹配未知", async () => {
	const { context } = fixture(card(["NOTE;ENCODING=QUOTED-PRINTABLE:needle"]));
	const unknown = await searchContacts(context, { account, collectionUrl, query: "needle" });
	assert.equal(unknown.resourcesComplete, true);
	assert.equal(unknown.complete, false);
	assert.equal(unknown.items.length, 0);
	assert.equal(unknown.unresolvedResources[0]?.matchStatus, "unknown");
	assert.equal(unknown.unresolvedResources[0]?.stage, "search");
	const known = await searchContacts(context, { account, collectionUrl, query: "可读姓名" });
	assert.equal(known.complete, true);
	assert.equal(known.items.length, 1);
	assert.deepEqual(known.unresolvedResources, []);
	const clean = fixture(card());
	const none = await searchContacts(clean.context, { account, collectionUrl, query: "未匹配" });
	assert.equal(none.complete, true);
	assert.deepEqual(none.items, []);
	assert.deepEqual(none.unresolvedResources, []);
});

test("写校验失败的可解析日期卡仍能正常读取和搜索", async () => {
	const raw = card(["BDAY:20260230"]);
	assert.equal(vcard.validateContact(raw).valid, false);
	const { context } = fixture(raw);
	assert.equal((await listContacts(context, { account, collectionUrl })).complete, true);
	assert.equal((await getContact(context, { account, resourceUrl })).name, "可读姓名");
	assert.equal((await searchContacts(context, { account, collectionUrl, query: "可读" })).items.length, 1);
});

test("源 REV 错误、重复及旧编码不可被自动刷新或 no-op 掩盖，零 PUT", async () => {
	for (const lines of [["REV:private-value"], ["REV:20200101T000000Z", "REV:20210101T000000Z"],
		["REV;ENCODING=QUOTED-PRINTABLE:20200101T000000Z"],
		["BDAY:20260230", "REV:private-value"]]) {
		for (const changes of [{}, { name: "新名" }, { properties: ["BDAY:20260228"] }]) {
			const { context, seen } = fixture(card(lines));
			await assert.rejects(updateContact(context, { ...target, ...changes }), failure("REPAIR_UNSUPPORTED", "source"));
			assert.deepEqual(seen.map(item => item.method), ["GET"]);
		}
	}
});

test("REV 修复 schema 必须有 rev、禁止未知键和换行，且只属于 update", () => {
	const schema = Compile(contactActionSchemas.contact_update);
	assert.equal(schema.Check(target), true);
	for (const rev of [null, "20200101T000000Z", "2020-01-01T00:00:00Z", "非法日期交库判断"])
		assert.equal(schema.Check({ ...target, revisionRepair: { rev } }), true);
	for (const revisionRepair of [{}, { rev: null, extra: true }, { rev: 1 }, { rev: false }, null, [],
		{ rev: "\r20200101T000000Z" }, { rev: "20200101T000000Z\n" }, { rev: "20200101T000000Z\r" },
		{ rev: "20200101T000000Z\r\nNOTE:注入" }])
		assert.equal(schema.Check({ ...target, revisionRepair }), false);
	assert.equal(Compile(contactActionSchemas.contact_create).Check({ account, collectionUrl, name: "新建", revisionRepair: { rev: null } }), false);
	assert.equal(Compile(contactActionSchemas.contact_delete).Check({ ...target, revisionRepair: { rev: null } }), false);
});

test("非法、重复和旧参数 REV 可显式替换或删除，刷新前检查候选且最终正文合规", async () => {
	for (const lines of [["REV:private-value"], ["REV:20200101T000000Z", "REV:20210101T000000Z"],
		["REV;ENCODING=QUOTED-PRINTABLE:20200101T000000Z"]]) {
		for (const rev of ["20220101T000000Z", null]) {
			const keep = ["item1.EMAIL;TYPE=WORK;X-LABEL=保留:old@example.invalid", "EMAIL;TYPE=HOME:later@example.invalid",
				"X-KEEP:合成扩展", "NOTE:折叠\r\n 保留"];
			const { context, seen } = fixture(card([...lines, ...keep]));
			const validated: string[] = [];
			context.vcard = { ...vcard, validateContact: raw => { validated.push(raw); return vcard.validateContact(raw); } };
			const result = await updateContact(context, { ...target, revisionRepair: { rev } });
			assert.equal(result.outcome, "updated");
			assert.deepEqual(seen.map(item => item.method), ["GET", "PUT"]);
			const repaired = vcard.parseContact(validated[1]!).properties.filter(property => property.name === "REV");
			assert.deepEqual(repaired.map(property => property.rawValue), rev === null ? [] : [rev]);
			const put = seen[1]!;
			assert.equal(put.headers.get("if-match"), etag);
			assert.equal(put.headers.get("if-none-match"), null);
			assert.equal(validated.at(-1), put.body);
			assert.equal(vcard.validateContact(put.body).valid, true);
			const finalRevs = vcard.parseContact(put.body).properties.filter(property => property.name === "REV");
			assert.equal(finalRevs.length, 1);
			assert.equal(finalRevs[0]!.parameters.size, 0);
			assert.match(finalRevs[0]!.rawValue, /^\d{8}T\d{6}Z$/);
			assert.notEqual(finalRevs[0]!.rawValue, rev);
			for (const line of keep) assert.ok(put.body.includes(`${line}\r\n`));
		}
	}
});

test("REV 与姓名、首项及普通属性业务修复合并为一次源卡编辑", async () => {
	const raw = card(["REV:private-value", "BDAY:20260230", "NOTE;ENCODING=QUOTED-PRINTABLE:private-value",
		"item1.EMAIL;TYPE=WORK:old@example.invalid", "EMAIL;TYPE=HOME:later@example.invalid", "X-KEEP:保留"]);
	const { context, seen } = fixture(raw);
	let sourceEdits = 0;
	context.vcard = { ...vcard, updateContact: (source, edit) => {
		if (source === raw) {
			sourceEdits++;
			assert.equal(edit.name, "修正姓名");
			assert.equal(edit.firstProperties?.email, "new@example.invalid");
			assert.deepEqual(edit.properties, ["BDAY:20260228", "TITLE:新职务", "REV:20220101T000000Z"]);
			assert.deepEqual(edit.removeProperties, ["NOTE"]);
		}
		return vcard.updateContact(source, edit);
	} };
	await updateContact(context, { ...target, name: "修正姓名", email: "new@example.invalid",
		properties: ["BDAY:20260228", "TITLE:新职务"], removeProperties: ["NOTE"], revisionRepair: { rev: "20220101T000000Z" } });
	assert.equal(sourceEdits, 1);
	assert.deepEqual(seen.map(item => item.method), ["GET", "PUT"]);
	const output = seen[1]!.body;
	assert.equal(vcard.validateContact(output).valid, true);
	for (const line of ["FN:修正姓名", "item1.EMAIL;TYPE=WORK:new@example.invalid", "EMAIL;TYPE=HOME:later@example.invalid",
		"BDAY:20260228", "TITLE:新职务", "X-KEEP:保留"]) assert.ok(output.includes(`${line}\r\n`));
	assert.doesNotMatch(output, /NOTE|private-value/);
});

test("合法或缺省 REV 没有源诊断，不得借修复入口任意改写或删除", async () => {
	for (const lines of [[], ["REV:20200101T000000Z"], ["BDAY:20260230"]]) {
		for (const rev of [null, "20220101T000000Z"]) {
			const { context, seen } = fixture(card(lines));
			await assert.rejects(updateContact(context, { ...target, name: "新名", revisionRepair: { rev } }), failure("INVALID_INPUT", "repair"));
			assert.deepEqual(seen.map(item => item.method), ["GET"]);
		}
	}
});

test("声明修复后仍非法的 REV 不能被自动刷新掩盖，版本日期语义交真实库判断", async () => {
	for (const rev of ["private-value", "20260230T000000Z", "REV:20200101T000000Z", "2020-01-01T00:00:00Z"]) {
		const { context, seen } = fixture(card(["REV:private-value"]));
		await assert.rejects(updateContact(context, { ...target, name: "新名", revisionRepair: { rev } }), failure("REPAIR_UNSUPPORTED", "repair"));
		assert.deepEqual(seen.map(item => item.method), ["GET"]);
	}
	const raw = card(["N:姓;名;;;", "REV:private-value"], "3.0").replace(`UID;VALUE=text:${uid}`, `UID:${uid}`);
	const { context, seen } = fixture(raw);
	assert.equal((await updateContact(context, { ...target, revisionRepair: { rev: "2020-01-01T00:00:00Z" } })).outcome, "updated");
	assert.equal(vcard.validateContact(seen[1]!.body).valid, true);
});

test("REV 修复不是总确认开关，其它业务问题未修仍拒写", async () => {
	for (const line of ["BDAY:20260230", "TEL;VALUE=uri:not a uri", "NOTE;ENCODING=QUOTED-PRINTABLE:private-value"]) {
		for (const rev of [null, "20220101T000000Z"]) {
			const { context, seen } = fixture(card(["REV:private-value", line]));
			await assert.rejects(updateContact(context, { ...target, revisionRepair: { rev } }), failure("CONTENT_VALIDATION_FAILED", "final"));
			assert.deepEqual(seen.map(item => item.method), ["GET"]);
		}
	}
});

test("显式 REV 修复不放宽普通属性、UID 或版本保护", async () => {
	for (const changes of [{ properties: ["rEv:20200101T000000Z"] }, { removeProperties: ["rev"] },
		{ properties: ["NOTE:合成\r\nREV:20200101T000000Z"] }, { properties: ["UID:other"] }, { properties: ["VERSION:3.0"] }]) {
		const { context, seen } = fixture(card(["REV:private-value"]));
		await assert.rejects(updateContact(context, { ...target, ...changes, revisionRepair: { rev: null } }), error => {
			assert.ok(error instanceof DavToolError);
			assert.equal(error.code, "INVALID_INPUT");
			assert.equal(error.cause, undefined);
			return true;
		});
		assert.deepEqual(seen.map(item => item.method), ["GET"]);
	}
	for (const [changes, code, methods] of [[{ uid: "other" }, "NOT_FOUND", ["GET"]],
		[{ etag: '"other"' }, "CONFLICT", ["GET"]], [{ etag: 'W/"v1"' }, "INVALID_INPUT", []]] as const) {
		const { context, seen } = fixture(card(["REV:private-value"]));
		await assert.rejects(updateContact(context, { ...target, ...changes, revisionRepair: { rev: null } }), { code });
		assert.deepEqual(seen.map(item => item.method), methods);
	}
});

test("REV 修复条件写的冲突和未知结果不重试或补读", async () => {
	for (const [status, code] of [[412, "CONFLICT"], [202, "REMOTE_RESULT_UNKNOWN"], [null, "REMOTE_RESULT_UNKNOWN"]] as const) {
		const methods: string[] = [];
		await assert.rejects(withDavAccount({ url: collectionUrl, user: "synthetic", password: "synthetic" }, undefined,
			context => updateContact(context, { ...target, revisionRepair: { rev: null } }), {
				fetch: async (_url, init) => {
					methods.push(init!.method!);
					if (init!.method === "GET") return new Response(card(["REV:private-value"]), { headers: { etag } });
					assert.equal(init!.method, "PUT");
					assert.equal(new Headers(init!.headers).get("if-match"), etag);
					assert.equal(vcard.validateContact(String(init!.body)).valid, true);
					if (status === null) throw new Error("合成断连");
					return new Response(null, { status });
				},
			}), { code });
		assert.deepEqual(methods, ["GET", "PUT"]);
	}
});

test("最终坏日期、URI、旧编码及版本相关错误包括 no-op 均零 PUT", async () => {
	const cases = [card(["BDAY:20260230"]), card(["TEL;VALUE=uri:not a uri"]),
		card(["NOTE;ENCODING=QUOTED-PRINTABLE:private-value"]), card([], "3.0"),
		card(["N:姓;名;;;", "TEL;VALUE=text:123"], "3.0"),
		card(["N:姓;名;;;", "TEL;VALUE=uri:tel:+123"], "3.0"),
		card().replace(`UID;VALUE=text:${uid}`, `UID:${uid}`)];
	for (const raw of cases) {
		assert.equal(vcard.validateContact(raw).valid, false);
		for (const changes of [{}, { name: "新名" }]) {
			const { context, seen } = fixture(raw);
			await assert.rejects(updateContact(context, { ...target, ...changes }), failure("CONTENT_VALIDATION_FAILED", "final"));
			assert.deepEqual(seen.map(item => item.method), ["GET"]);
		}
	}
});

test("创建候选坏日期与 URI 不能 PUT；旧编辑器提前拒绝不冒充最终校验", async () => {
	for (const properties of [["BDAY:20260230"], ["TEL;VALUE=uri:not a uri"]]) {
		const { context, seen } = fixture();
		await assert.rejects(createContact(context, { account, collectionUrl, name: "新建", properties }),
			failure("CONTENT_VALIDATION_FAILED", "final"));
		assert.deepEqual(seen, []);
	}
	const legacy = fixture(card(["EMAIL;ENCODING=QUOTED-PRINTABLE:private-value"]));
	await assert.rejects(updateContact(legacy.context, { ...target, email: null }), failure("REPAIR_UNSUPPORTED", "edit"));
	assert.deepEqual(legacy.seen.map(item => item.method), ["GET"]);
	const version = fixture(card([], "2.1"));
	await assert.rejects(updateContact(version.context, { ...target, name: "新名" }), failure("REPAIR_UNSUPPORTED", "source"));
	assert.deepEqual(version.seen.map(item => item.method), ["GET"]);
});

test("明确修正业务问题后才条件写回，实际发送文本已完成最终校验与 REV 维护", async () => {
	const cases = [
		{ raw: card(["BDAY:20260230"]), changes: { properties: ["BDAY:20260228"] } },
		{ raw: card([], "3.0"), changes: { properties: ["N:姓;名;;;"] } },
		{ raw: card(["TEL;VALUE=uri:not a uri"]), changes: { properties: ["TEL;VALUE=uri:tel:+123"] } },
		{ raw: card(["NOTE;ENCODING=QUOTED-PRINTABLE:private-value"]), changes: { removeProperties: ["NOTE"] } },
		{ raw: card(["N:姓;名;;;", "TEL;VALUE=uri:tel:+123"], "3.0"), changes: { properties: ["TEL;VALUE=phone-number:+123"] } },
	];
	for (const { raw, changes } of cases) {
		const { context, seen } = fixture(raw);
		const validated: string[] = [];
		context.vcard = { ...vcard, validateContact: candidate => { validated.push(candidate); return vcard.validateContact(candidate); } };
		assert.equal((await updateContact(context, { ...target, ...changes })).outcome, "updated");
		assert.deepEqual(seen.map(item => item.method), ["GET", "PUT"]);
		const put = seen[1]!;
		assert.equal(put.headers.get("if-match"), etag);
		assert.equal(validated.at(-1), put.body);
		assert.equal(vcard.validateContact(put.body).valid, true);
		assert.match(put.body, /REV:\d{8}T\d{6}Z/);
	}
});

test("合法 REV 正常刷新，缺省正常初始化，合规 no-op 仍校验但不 PUT", async () => {
	for (const lines of [[], ["REV:20200101T000000Z"]]) {
		const { context, seen } = fixture(card(lines));
		let calls = 0;
		context.vcard = { ...vcard, validateContact: raw => { calls++; return vcard.validateContact(raw); } };
		assert.equal((await updateContact(context, target)).outcome, "unchanged");
		assert.ok(calls > 0);
		assert.deepEqual(seen.map(item => item.method), ["GET"]);
		assert.equal((await updateContact(context, { ...target, name: "新名" })).outcome, "updated");
		const put = seen.at(-1)!;
		assert.equal(vcard.validateContact(put.body).valid, true);
		assert.match(put.body, /REV:\d{8}T\d{6}Z/);
		assert.doesNotMatch(put.body, /REV:20200101/);
	}
});

test("输入冲突预检不覆盖源 TEL 的 TEXT 序列化语义", async () => {
	const { context, seen } = fixture(card(["TEL;VALUE=text:原电话"]));
	assert.equal((await updateContact(context, { ...target, phone: "第一行\n第二行", properties: ["TITLE:合成职务"] })).outcome, "updated");
	assert.deepEqual(seen.map(item => item.method), ["GET", "PUT"]);
	assert.equal(vcard.parseContact(seen[1]!.body).properties.find(property => property.name === "TEL")?.value, "第一行\n第二行");
});

test("源有业务错误时仍区分明确输入冲突和可确认的 UID 不匹配", async () => {
	const conflicting = fixture(card(["BDAY:20260230"]));
	await assert.rejects(updateContact(conflicting.context, { ...target, email: "first", properties: ["EMAIL:second"] }),
		failure("INVALID_INPUT", "edit"));
	assert.deepEqual(conflicting.seen.map(item => item.method), ["GET"]);
	const mismatch = fixture(card(["REV:private-value"]));
	await assert.rejects(updateContact(mismatch.context, { ...target, uid: "other", name: "新名" }), { code: "NOT_FOUND" });
	assert.deepEqual(mismatch.seen.map(item => item.method), ["GET"]);
});

test("搜索的网络、权限、取消及 REPORT 协议失败不降级为未知卡", async () => {
	for (const fetch of [
		async () => { throw new Error("合成离线"); },
		async () => { throw new DOMException("合成取消", "AbortError"); },
		async () => new Response(null, { status: 403 }),
		async () => new Response("not-xml", { status: 207 }),
	]) {
		const context: DavReadContext = { client: new DavClient({ baseUrl: collectionUrl, fetch }), ical, vcard };
		await assert.rejects(searchContacts(context, { account, collectionUrl, query: "任意" }), error => {
			assert.ok(error instanceof Error);
			assert.ok(!(error instanceof DavToolError), "不能将协议或传输错误映射为内容问题");
			return true;
		});
	}
});

test("创建最终校验的是已含 REV 的实际 PUT 文本", async () => {
	const { context, seen } = fixture();
	const validated: string[] = [];
	context.vcard = { ...vcard, validateContact: raw => { validated.push(raw); return vcard.validateContact(raw); } };
	await createContact(context, { account, collectionUrl, name: "合成创建", properties: ["BDAY:20260228"] });
	assert.deepEqual(seen.map(item => item.method), ["PUT"]);
	assert.equal(validated.at(-1), seen[0]!.body);
	assert.match(validated.at(-1)!, /REV:\d{8}T\d{6}Z/);
	assert.equal(vcard.validateContact(seen[0]!.body).valid, true);
});

test("删除异常业务字段及 REV 不增加写回合规要求，仍使用原强 ETag", async () => {
	const { context, seen } = fixture(card(["REV:private-value", "BDAY:20260230"]));
	assert.equal((await deleteContact(context, target)).outcome, "deleted");
	assert.deepEqual(seen.map(item => item.method), ["GET", "DELETE"]);
	assert.equal(seen[1]!.headers.get("if-match"), etag);
});
