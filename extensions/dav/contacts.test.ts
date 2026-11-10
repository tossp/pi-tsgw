import assert from "node:assert/strict";
import { test } from "node:test";
import { DavClient, DavError, type DavResource } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { getContact, listContacts } from "./contacts.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const collectionUrl = "https://example.invalid/contacts/";
const account = "test";
function card(version: "3.0" | "4.0", lines: string[]): string {
	return ["BEGIN:VCARD", `VERSION:${version}`, ...lines, "END:VCARD", ""].join("\r\n");
}
function resource(file: string, data: string, etag: string | null = '"v1"'): DavResource {
	return { url: `${collectionUrl}${file}`, data, etag, contentType: "text/vcard" };
}
class FakeClient extends DavClient {
	readonly queries: Parameters<DavClient["query"]>[] = [];
	readonly gets: string[] = [];
	queryError?: Error;
	getError?: Error;
	constructor(readonly resources: DavResource[]) {
		super({ baseUrl: collectionUrl, fetch: async () => { throw new Error("测试禁止网络请求"); } });
	}
	override async query(...args: Parameters<DavClient["query"]>): Promise<DavResource[]> {
		this.queries.push(args);
		if (this.queryError) throw this.queryError;
		return this.resources;
	}
	override async get(url: string): Promise<DavResource> {
		this.gets.push(url);
		if (this.getError) throw this.getError;
		const result = this.resources.find(item => item.url === url);
		if (!result) throw new DavError(404, "GET");
		return result;
	}
}
function fixture(resources: DavResource[]) {
	const client = new FakeClient(resources);
	const context: DavReadContext = { client, ical, vcard };
	return { client, context };
}
function isSafeInvalid(error: unknown): boolean {
	assert.ok(error instanceof DavToolError);
	assert.equal(error.code, "DATA_INVALID");
	assert.equal(error.message, "联系人资源无法解析");
	assert.equal(error.cause, undefined);
	return true;
}

test("列表使用 addressbook REPORT，真实解析 vCard 3/4，仅返回联系人摘要", async () => {
	const first = resource("one.vcf", card("3.0", [
		"UID:uid-3", "FN:张三\\,朋友", "EMAIL;TYPE=HOME:one@example.invalid",
		"EMAIL;TYPE=WORK:two@example.invalid", "TEL;TYPE=CELL:+86-100", "NOTE:不应进入摘要",
		"URL:https://example.invalid/profile", "X-EMAIL:不是邮箱字段", "X-TEL:不是电话字段",
	]));
	const second = resource("two.vcf", card("4.0", [
		"UID:urn:uuid:uid-4", "FN:李四", "EMAIL:li@example.invalid", "TEL;VALUE=uri:tel:+86-200",
	]), null);
	const { client, context } = fixture([first, second]);
	const result = await listContacts(context, { account, collectionUrl });
	assert.deepEqual(client.queries, [[collectionUrl, "addressbook"]]);
	assert.deepEqual(client.gets, []);
	assert.deepEqual(result, { account, collectionUrl, complete: true, items: [
		{ resourceUrl: first.url, etag: first.etag, uid: "uid-3", version: "3.0", name: "张三,朋友",
			emails: ["one@example.invalid", "two@example.invalid"], phones: ["+86-100"] },
		{ resourceUrl: second.url, etag: null, uid: "urn:uuid:uid-4", version: "4.0", name: "李四",
			emails: ["li@example.invalid"], phones: ["tel:+86-200"] },
	] });
	assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
	assert.doesNotMatch(JSON.stringify(result), /NOTE|不应进入摘要|properties|raw|profile/);
});

test("同 UID 的不同资源全部保留，无 UID 卡仅以资源 URL 标识", async () => {
	const resources = [
		resource("a.vcf", card("3.0", ["UID:same", "FN:甲"])),
		resource("b.vcf", card("4.0", ["UID;VALUE=text:same", "FN:乙"])),
		resource("c.vcf", card("4.0", ["FN:无 UID"])),
	];
	const { context } = fixture(resources);
	const result = await listContacts(context, { account, collectionUrl });
	assert.equal(result.items.length, 3);
	assert.deepEqual(result.items.map(item => item.resourceUrl), resources.map(item => item.url));
	assert.deepEqual(result.items.map(item => item.uid), ["same", "same", undefined]);
	assert.equal(Object.hasOwn(result.items[2]!, "uid"), false);
	assert.deepEqual(result.items[2]?.emails, []);
	assert.deepEqual(result.items[2]?.phones, []);
});

test("EMAIL/TEL 无已投影 value 时不回退解码 rawValue，不读取其他字段", async () => {
	const item = resource("legacy.vcf", card("3.0", [
		"FN:旧卡", "EMAIL;ENCODING=QUOTED-PRINTABLE:legacy=40example.invalid",
		"TEL;CHARSET=ISO-8859-1:opaque-phone", "EMAIL;ENCODING=b:ZW1haWw=",
		"EMAIL;VALUE=x-opaque:opaque-email", "TEL;VALUE=x-opaque:opaque-phone-2",
		"EMAIL:decoded\\,email@example.invalid", "TEL:+123",
		"NOTE:note@example.invalid +999", "IMPP:mailto:im@example.invalid",
	]));
	const { context } = fixture([item]);
	const result = await listContacts(context, { account, collectionUrl });
	assert.deepEqual(result.items[0]?.emails, ["decoded,email@example.invalid"]);
	assert.deepEqual(result.items[0]?.phones, ["+123"]);
	const detail = await getContact(context, { account, resourceUrl: item.url });
	const opaque = detail.properties.find(property => property.rawValue === "legacy=40example.invalid");
	assert.equal(opaque?.value, undefined);
	assert.equal(Object.hasOwn(opaque!, "value"), false);
	assert.deepEqual(opaque?.parameters, { ENCODING: ["QUOTED-PRINTABLE"] });
});

test("详情 GET 后解析，参数 Map 转普通 JSON，保留分组、属性 rawValue 和已投影 value", async () => {
	const item = resource("detail.vcf", card("4.0", [
		"UID:urn:uuid:detail", "FN:甲\\,乙",
		"item1.EMAIL;TYPE=work,internet;X-LABEL=研发^n小组:dev@example.invalid",
		"NOTE:第一行\\n第二行\\,结尾", "N:张;三;;;", "X-OPAQUE:a;b,c",
	]));
	const { client, context } = fixture([item]);
	const result = await getContact(context, { account, resourceUrl: item.url });
	assert.deepEqual(client.gets, [item.url]);
	assert.deepEqual(client.queries, []);
	assert.equal(result.account, account);
	assert.equal(result.resourceUrl, item.url);
	assert.equal(result.etag, item.etag);
	assert.equal(result.uid, "urn:uuid:detail");
	assert.equal(result.version, "4.0");
	assert.equal(result.name, "甲,乙");
	const email = result.properties.find(property => property.name === "EMAIL");
	assert.deepEqual(email, { name: "EMAIL", group: "item1", parameters: {
		TYPE: ["work", "internet"], "X-LABEL": ["研发\n小组"],
	}, rawValue: "dev@example.invalid", value: "dev@example.invalid" });
	assert.equal(Object.getPrototypeOf(email!.parameters), Object.prototype);
	assert.deepEqual(result.properties.find(property => property.name === "NOTE"), {
		name: "NOTE", parameters: {}, rawValue: "第一行\\n第二行\\,结尾", value: "第一行\n第二行,结尾",
	});
	assert.deepEqual(result.properties.find(property => property.name === "N"), {
		name: "N", parameters: {}, rawValue: "张;三;;;",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
	assert.equal(Object.hasOwn(result, "raw"), false);
});

test("vCard 3 参数不执行 vCard 4 的 RFC 6868 解码", async () => {
	const item = resource("three.vcf", card("3.0", ["FN:三", 'EMAIL;TYPE="work,internet";X-LABEL=研发^n小组:a@example.invalid']));
	const { context } = fixture([item]);
	const result = await getContact(context, { account, resourceUrl: item.url });
	assert.equal(result.version, "3.0");
	assert.deepEqual(result.properties.find(property => property.name === "EMAIL")?.parameters,
		{ TYPE: ["work,internet"], "X-LABEL": ["研发^n小组"] });
});

test("只有 raw:true 才附 GET 逐字原文，不附 REPORT 数据或重新序列化内容", async () => {
	const raw = "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:折叠\r\n 名称\r\nEND:VCARD\r\n";
	const item = resource("raw.vcf", raw);
	const { client, context } = fixture([item]);
	for (const flag of [undefined, false]) {
		const result = await getContact(context, { account, resourceUrl: item.url, raw: flag });
		assert.equal(Object.hasOwn(result, "raw"), false);
		assert.equal(result.name, "折叠名称");
	}
	const result = await getContact(context, { account, resourceUrl: item.url, raw: true });
	assert.equal(result.raw, raw);
	assert.equal(Object.hasOwn(result, "uid"), false);
	assert.deepEqual(client.gets, [item.url, item.url, item.url]);
	assert.deepEqual(client.queries, []);
});

test("可选 UID 精确核对，不做包含、大小写或空白归一化，无 UID 不生成身份", async () => {
	const item = resource("uid.vcf", card("4.0", ["UID;VALUE=text:Exact", "FN:身份"]));
	const noUid = resource("no-uid.vcf", card("3.0", ["FN:无身份"]));
	const { context } = fixture([item, noUid]);
	assert.equal((await getContact(context, { account, resourceUrl: item.url, uid: "Exact" })).uid, "Exact");
	for (const uid of ["exact", "Ex", "Exact ", ""]) {
		await assert.rejects(getContact(context, { account, resourceUrl: item.url, uid, raw: true }),
			{ code: "NOT_FOUND", message: "联系人 UID 与资源不匹配" });
	}
	await assert.rejects(getContact(context, { account, resourceUrl: noUid.url, uid: "Exact" }), { code: "NOT_FOUND" });
	assert.equal(Object.hasOwn(await getContact(context, { account, resourceUrl: noUid.url }), "uid"), false);
});

test("空 REPORT 才返回完整空列表", async () => {
	const { context } = fixture([]);
	assert.deepEqual(await listContacts(context, { account, collectionUrl }),
		{ account, collectionUrl, complete: true, items: [] });
});

test("任一无效资源使整个列表失败，详情也安全报 DATA_INVALID，不泄露库异常或原文", async () => {
	const valid = resource("valid.vcf", card("4.0", ["FN:有效"]));
	const invalidCards = [
		"secret-invalid-document", card("4.0", ["UID:secret-missing-fn"]),
		card("3.0", ["FN:甲", "FN:secret-extra-fn"]),
		card("4.0", ["FN:甲", "UID:first", "UID:secret-duplicate"]),
		card("4.0", ["FN:甲"]) + card("4.0", ["FN:secret-second-card"]),
	];
	for (const data of invalidCards) {
		const bad = resource("invalid.vcf", data);
		for (const resources of [[valid, bad], [bad, valid]]) {
			const { context } = fixture(resources);
			await assert.rejects(listContacts(context, { account, collectionUrl }), isSafeInvalid);
			await assert.rejects(getContact(context, { account, resourceUrl: bad.url, raw: true }), isSafeInvalid);
		}
	}
});

test("网络、HTTP 和取消错误原样上抛，不变为空列表或解析错误", async () => {
	for (const error of [new Error("离线网络错误"), new DavError(403, "REPORT"),
		new DOMException("离线取消", "AbortError")]) {
		const { client, context } = fixture([]);
		client.queryError = error;
		client.getError = error;
		await assert.rejects(listContacts(context, { account, collectionUrl }), received => received === error);
		await assert.rejects(getContact(context, { account, resourceUrl: `${collectionUrl}failed.vcf` }), received => received === error);
	}
	const { context } = fixture([]);
	await assert.rejects(getContact(context, { account, resourceUrl: `${collectionUrl}missing.vcf` }), { status: 404 });
});
