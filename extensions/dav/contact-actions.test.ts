import assert from "node:assert/strict";
import { test } from "node:test";
import { DavClient } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { createContact, deleteContact, searchContacts, updateContact } from "./contact-actions.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = "test";
const collectionUrl = "https://example.invalid/contacts/";
const resourceUrl = `${collectionUrl}not-the-uid.vcf`;
const uid = "actual-uid";
const etag = '"v1"';
const target = { account, resourceUrl, uid, etag };
const card = (lines: string[], version = "4.0") =>
	["BEGIN:VCARD", `VERSION:${version}`, ...lines, "END:VCARD", ""].join("\r\n");
const original = (lines: string[] = [], version = "4.0") => card([
	`UID${version === "4.0" ? ";VALUE=text" : ""}:${uid}`, "FN:原名",
	...(version === "3.0" && !lines.some(line => line.startsWith("N:")) ? ["N:;原名;;;"] : []), ...lines,
], version);
const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
interface Seen { method: string; url: string; headers: Headers; body: string }
function fixture(raw = original(), options: {
	etag?: string | null; newEtag?: string | null; writeStatus?: number;
	report?: { file: string; data: string; etag?: string | null }[];
} = {}) {
	const seen: Seen[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		const method = init!.method!;
		seen.push({ method, url: String(url), headers: new Headers(init!.headers), body: String(init!.body ?? "") });
		if (method === "GET") {
			const version = options.etag === undefined ? etag : options.etag;
			return new Response(raw, { status: 200, headers: { "content-type": "text/vcard", ...(version === null ? {} : { etag: version }) } });
		}
		if (method === "REPORT") {
			const responses = (options.report ?? []).map(item => `<d:response><d:href>/contacts/${xml(item.file)}</d:href>` +
				`<d:propstat><d:prop>${item.etag === null ? "" : `<d:getetag>${xml(item.etag ?? etag)}</d:getetag>`}` +
				`<c:address-data>${xml(item.data)}</c:address-data></d:prop>` +
				"<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>").join("");
			return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">${responses}</d:multistatus>`, { status: 207 });
		}
		assert.ok(method === "PUT" || method === "DELETE", "禁止其他请求和真实网络");
		const next = options.newEtag === undefined ? '"v2"' : options.newEtag;
		return new Response(null, { status: options.writeStatus ?? (method === "DELETE" ? 204 : 201),
			headers: next === null ? {} : { etag: next } });
	};
	const context: DavReadContext = { client: new DavClient({ baseUrl: collectionUrl, fetch }), ical, vcard };
	return { context, seen };
}
function safeError(code: string) {
	return (error: unknown) => {
		assert.ok(error instanceof DavToolError);
		assert.equal(error.code, code);
		assert.equal(error.cause, undefined);
		assert.doesNotMatch(error.message, /secret|private-input|example\.invalid/);
		return true;
	};
}

test("搜索全地址簿后本地覆盖九种字段的已解码叶值，不输出 NOTE 或原文", async () => {
	const fields = ["FN:needle姓名", "N:姓;名字NEEDLE,别名;;;", "NICKNAME:另一个,needle\\,别名",
		"TITLE:needle职位", "ROLE:needle角色", "ORG:公司\\,NEEDLE;部门", "NOTE:第一行\\nneedle备注",
		"EMAIL:NEEDLE@example.invalid", "TEL;VALUE=text:needle电话"];
	const report = fields.map((line, index) => ({ file: `field-${index}.vcf`,
		data: card([`UID:uid-${index}`, ...(index === 0 ? [] : [`FN:人物${index}`]), line]),
		etag: index === 0 ? null : `"field-${index}"` }));
	report.push({ file: "excluded.vcf", data: card(["FN:未匹配", "X-NOTE:needle"]), etag });
	const { context, seen } = fixture(undefined, { report });
	const result = await searchContacts(context, { account, collectionUrl, query: "Needle" });
	assert.equal(result.complete, true);
	assert.equal(result.items.length, 9);
	assert.equal(result.items[0]!.etag, null);
	assert.deepEqual(result.items.map(item => item.resourceUrl), fields.map((_, index) => `${collectionUrl}field-${index}.vcf`));
	assert.deepEqual(result.items.map(item => item.uid), fields.map((_, index) => `uid-${index}`));
	assert.deepEqual(seen.map(request => request.method), ["REPORT"]);
	assert.doesNotMatch(seen[0]!.body, /prop-filter|text-match|Needle|FN/);
	assert.doesNotMatch(JSON.stringify(result), /备注|properties|raw|第一行/);
});

test("结构化 ORG/N 与 NICKNAME 按解码叶搜索，不把 opaque rawValue 当解码值", async () => {
	const report = [{ file: "decoded.vcf", data: original([
		"ORG:测试\\,甲;研发\\;小组", "N:张;三\\,四;;;", "NICKNAME:小\\,名,其他",
		"NOTE;ENCODING=QUOTED-PRINTABLE:secret-note", "NICKNAME;VALUE=x-opaque:secret-nickname",
		"ORG;ENCODING=b:c2VjcmV0", "EMAIL;VALUE=x-opaque:secret-email",
	]), etag }];
	const { context } = fixture(undefined, { report });
	for (const query of ["测试,甲", "研发;小组", "三,四", "小,名"]) {
		const result = await searchContacts(context, { account, collectionUrl, query });
		assert.equal(result.items.length, 0);
		assert.equal(result.complete, false);
		assert.equal(result.unresolvedResources[0]?.matchStatus, "matched");
		assert.equal(result.unresolvedResources[0]?.stage, "projection");
	}
	for (const query of ["测试\\,甲", "secret", "c2VjcmV0"]) {
		const result = await searchContacts(context, { account, collectionUrl, query });
		assert.equal(result.items.length, 0);
		assert.equal(result.complete, false);
		assert.equal(result.unresolvedResources[0]?.matchStatus, "unknown");
		assert.equal(result.unresolvedResources[0]?.stage, "search");
	}
});

test("电话搜索沿用旧标点和空白规范化，但不猜测分机或扩展 URI 语法", async () => {
	const { context } = fixture(undefined, { report: [
		{ file: "a.vcf", data: original(["TEL;VALUE=uri:tel:+86 (010) 1234-5678"]), etag },
		{ file: "b.vcf", data: card(["FN:带分机", "TEL;VALUE=uri:tel:+86-999;ext=1234"]), etag },
	] });
	for (const query of ["01012345678", "+86 (010) 1234/5678"])
		assert.deepEqual((await searchContacts(context, { account, collectionUrl, query })).items.map(item => item.resourceUrl), [`${collectionUrl}a.vcf`]);
	assert.equal((await searchContacts(context, { account, collectionUrl, query: "86999" })).items.length, 0);
	assert.equal((await searchContacts(context, { account, collectionUrl, query: "() -" })).items.length, 0);
});

test("空搜索在联网前拒绝；坏卡保留为未知，不截断或跳过", async () => {
	const { context, seen } = fixture(undefined, { report: [
		{ file: "ok.vcf", data: original(), etag }, { file: "bad.vcf", data: "secret-invalid-card", etag },
	] });
	for (const query of ["", " \t\n"])
		await assert.rejects(searchContacts(context, { account, collectionUrl, query }), safeError("INVALID_INPUT"));
	assert.equal(seen.length, 0);
	const result = await searchContacts(context, { account, collectionUrl, query: "原名" });
	assert.equal(result.complete, false);
	assert.equal(result.items.length, 1);
	assert.equal(result.unresolvedResources[0]?.raw, "secret-invalid-card");
	assert.equal(result.unresolvedResources[0]?.matchStatus, "unknown");
	assert.deepEqual(seen.map(item => item.method), ["REPORT"]);
});

test("创建通过库生成身份、随机 vcf 路径、组件式 ORG、TEXT 转义及受管 REV", async () => {
	const { context, seen } = fixture();
	const result = await createContact(context, { account, collectionUrl, name: "张,三", email: "a,b@example.invalid",
		phone: "tel:+86-100", org: ["公司;甲", "研发,组"], note: "第一行\n第二行", properties: ["TITLE:工程师"] });
	assert.deepEqual(seen.map(item => item.method), ["PUT"]);
	assert.match(result.resourceUrl, /^https:\/\/example\.invalid\/contacts\/[0-9a-f-]{36}\.vcf$/);
	assert.equal(result.outcome, "created");
	assert.equal(result.etag, '"v2"');
	assert.match(result.uid, /^[0-9a-f-]{36}$/);
	assert.notEqual(result.uid, result.resourceUrl.split("/").at(-1)!.replace(/\.vcf$/, ""));
	const request = seen[0]!;
	assert.equal(request.headers.get("if-none-match"), "*");
	assert.equal(request.headers.get("if-match"), null);
	assert.match(request.headers.get("content-type")!, /^text\/vcard/);
	const parsed = vcard.parseContact(request.body);
	assert.equal(parsed.uid, result.uid);
	assert.equal(parsed.version, "4.0");
	assert.equal(parsed.name, "张,三");
	assert.deepEqual(parsed.properties.find(property => property.name === "ORG")?.components, [["公司;甲"], ["研发,组"]]);
	assert.equal(parsed.properties.find(property => property.name === "EMAIL")?.value, "a,b@example.invalid");
	assert.equal(parsed.properties.find(property => property.name === "NOTE")?.value, "第一行\n第二行");
	assert.match(parsed.properties.find(property => property.name === "REV")!.rawValue, /^\d{8}T\d{6}Z$/);
	assert.equal(Object.hasOwn(result, "raw"), false);
});

test("创建禁止保留字段、REV、注入和首项/高级属性冲突，安全失败且不 PUT", async () => {
	for (const properties of [["UID:secret"], ["VERSION:3.0"], ["FN:secret"], ["item1.rEv:secret"],
		["NOTE:secret\r\nREV:secret"], ["EMAIL:private-input"]]) {
		const { context, seen } = fixture();
		await assert.rejects(createContact(context, { account, collectionUrl, name: "测试", email: "first", properties }), safeError("INVALID_INPUT"));
		assert.equal(seen.length, 0);
	}
	const { context, seen } = fixture();
	await assert.rejects(createContact(context, { account, collectionUrl, name: " \t" }), safeError("INVALID_INPUT"));
	assert.equal(seen.length, 0);
});

test("更新 3/4 联系人只改首项并保留参数、分组、后续值及非目标属性", async () => {
	for (const version of ["3.0", "4.0"]) {
		const raw = original([
			"itemA.EMAIL;TYPE=WORK;X-LABEL=标签:old@example.invalid", "EMAIL;TYPE=HOME:later@example.invalid",
			`itemB.TEL;VALUE=${version === "3.0" ? "phone-number" : "text"};TYPE=CELL:+86-1`, "TEL:+86-2",
			"itemC.ORG;TYPE=work:旧公司;旧部门", "ORG:后续公司;后续部门",
			"itemD.NOTE;X-KEEP=yes:旧备注", "NOTE:后续备注", "N:姓;名;;;", "REV:20200101T000000Z",
		], version);
		const { context, seen } = fixture(raw);
		const result = await updateContact(context, { ...target, email: "new@example.invalid", phone: "+86;100", org: ["公司;甲", "部门,乙"], note: "新\n备注" });
		assert.deepEqual(seen.map(item => item.method), ["GET", "PUT"]);
		assert.equal(seen[1]!.headers.get("if-match"), etag);
		assert.equal(seen[1]!.headers.get("if-none-match"), null);
		assert.equal(seen[1]!.url, resourceUrl);
		assert.deepEqual(result, { account, resourceUrl, uid, etag: '"v2"', outcome: "updated" });
		const output = seen[1]!.body;
		for (const line of ["EMAIL;TYPE=HOME:later@example.invalid", "TEL:+86-2", "ORG:后续公司;后续部门", "NOTE:后续备注", "N:姓;名;;;"])
			assert.ok(output.includes(`${line}\r\n`));
		assert.ok(output.includes("itemA.EMAIL;TYPE=WORK;X-LABEL=标签:new@example.invalid\r\n"));
		assert.ok(output.includes(`itemB.TEL;VALUE=${version === "3.0" ? "phone-number" : "text"};TYPE=CELL:${version === "3.0" ? "+86;100" : "+86\\;100"}\r\n`));
		assert.ok(output.includes("itemC.ORG;TYPE=work:公司\\;甲;部门\\,乙\r\n"));
		assert.ok(output.includes("itemD.NOTE;X-KEEP=yes:新\\n备注\r\n"));
		assert.doesNotMatch(output, /REV:20200101/);
		assert.equal(vcard.parseContact(output).version, version);
	}
});

test("v4 显式 URI 电话不能用便捷标量改写；普通电话、删除首项和完整替换仍可用", async () => {
	for (const version of ["4.0"]) {
		const uriLine = "item1.TEL;VALUE=uri;TYPE=work:tel:+86-111";
		const raw = original([uriLine, "TEL;VALUE=text:+86-222", "X-KEEP:保留"], version);
		const blocked = fixture(raw);
		await assert.rejects(updateContact(blocked.context, { ...target, phone: "+86 (010) 1234-5678" }), error => {
			assert.ok(safeError("INVALID_INPUT")(error));
			assert.match((error as DavToolError).message, /properties/);
			return true;
		});
		assert.deepEqual(blocked.seen.map(item => item.method), ["GET"]);
		const unchanged = fixture(raw);
		await updateContact(unchanged.context, { ...target, note: "其他字段" });
		assert.ok(unchanged.seen[1]!.body.includes(`${uriLine}\r\n`));
		const removed = fixture(raw);
		await updateContact(removed.context, { ...target, phone: null });
		assert.deepEqual(vcard.parseContact(removed.seen[1]!.body).properties.filter(p => p.name === "TEL").map(p => p.value), ["+86-222"]);
		const explicit = fixture(raw);
		await updateContact(explicit.context, { ...target, properties: ["item1.TEL;VALUE=uri;TYPE=work:tel:+86-333", "TEL;VALUE=text:+86-222"] });
		assert.ok(explicit.seen[1]!.body.includes("item1.TEL;VALUE=uri;TYPE=work:tel:+86-333\r\n"));
		assert.ok(explicit.seen[1]!.body.includes("X-KEEP:保留\r\n"));
	}
	const ordinary = fixture(original(["TEL;VALUE=text:旧电话", "item2.TEL;VALUE=URI:tel:+86-222"]));
	await updateContact(ordinary.context, { ...target, phone: "+86 (010) 1234-5678" });
	assert.ok(ordinary.seen[1]!.body.includes("TEL;VALUE=text:+86 (010) 1234-5678\r\n"));
	assert.ok(ordinary.seen[1]!.body.includes("item2.TEL;VALUE=URI:tel:+86-222\r\n"));
	const created = fixture();
	await createContact(created.context, { account, collectionUrl, name: "普通电话", phone: "+86 (010) 1234-5678" });
	assert.equal(vcard.parseContact(created.seen[0]!.body).properties.find(p => p.name === "TEL")?.value, "+86 (010) 1234-5678");
});

test("null 只删除首项；高级 properties/removeProperties 则整组操作", async () => {
	const raw = original(["item1.EMAIL:a", "EMAIL:b", "TEL;VALUE=text:first", "TEL;VALUE=text:second",
		"ORG:第一公司;部门", "ORG:第二公司", "NOTE:第一条", "NOTE:第二条", "TITLE:旧职务", "X-KEEP:保留"]);
	const { context, seen } = fixture(raw);
	await updateContact(context, { ...target, email: null, phone: null, org: null, note: null });
	const output = vcard.parseContact(seen[1]!.body);
	for (const [name, expected] of [["EMAIL", "b"], ["TEL", "second"], ["ORG", "第二公司"], ["NOTE", "第二条"]])
		assert.deepEqual(output.properties.filter(property => property.name === name).map(property => property.rawValue), [expected]);
	const next = fixture(raw);
	await updateContact(next.context, { ...target, properties: ["EMAIL:new1", "EMAIL:new2"], removeProperties: ["title"] });
	const edited = vcard.parseContact(next.seen[1]!.body);
	assert.deepEqual(edited.properties.filter(property => property.name === "EMAIL").map(property => property.value), ["new1", "new2"]);
	assert.equal(edited.properties.some(property => property.name === "TITLE"), false);
	assert.equal(edited.properties.find(property => property.name === "X-KEEP")?.rawValue, "保留");
});

test("空操作、相同首项、缺失首项 null、相同折叠 FN 均不 PUT 或刷新 REV", async () => {
	const raw = original(["EMAIL:a", "ORG:公司;部门", "REV:20200101T000000Z"]).replace("FN:原名\r\n", "FN:原\r\n 名\r\n");
	for (const changes of [{}, { properties: [], removeProperties: [] }, { name: "原名", email: "a", org: ["公司", "部门"] }, { note: null }]) {
		const { context, seen } = fixture(raw);
		assert.deepEqual(await updateContact(context, { ...target, ...changes }), { account, resourceUrl, uid, etag, outcome: "unchanged" });
		assert.deepEqual(seen.map(item => item.method), ["GET"]);
	}
});

test("所有更新/删除都先核对强 ETag 和 UID，无条件写入及隐式生成 UID 均不发生", async () => {
	for (const action of [updateContact, deleteContact]) {
		for (const badEtag of ["*", "v1", 'W/"v1"', '"v1", "v2"', '"v1"\n']) {
			const { context, seen } = fixture();
			await assert.rejects(action(context, { ...target, etag: badEtag }), safeError("INVALID_INPUT"));
			assert.equal(seen.length, 0);
		}
		for (const current of ['"changed"', null]) {
			const { context, seen } = fixture(undefined, { etag: current });
			await assert.rejects(action(context, target), safeError("CONFLICT"));
			assert.deepEqual(seen.map(item => item.method), ["GET"]);
		}
		for (const raw of [card(["FN:无身份"]), card(["UID:other", "FN:其他人"])]) {
			const { context, seen } = fixture(raw);
			await assert.rejects(action(context, target), safeError("NOT_FOUND"));
			assert.deepEqual(seen.map(item => item.method), ["GET"]);
		}
	}
});

test("更新拒绝受管属性、首项冲突及 opaque 首项，不输出源内容或库错误", async () => {
	for (const changes of [{ properties: ["rEv:secret"] }, { removeProperties: ["rev"] },
		{ properties: ["UID:secret"] }, { properties: ["VERSION:3.0"] },
		{ email: "a", properties: ["item1.EMAIL:b"] }, { email: null, removeProperties: ["EMAIL"] },
		{ name: "原名", properties: ["FN:其他名"] }]) {
		const { context, seen } = fixture();
		await assert.rejects(updateContact(context, { ...target, ...changes }), safeError("INVALID_INPUT"));
		assert.deepEqual(seen.map(item => item.method), ["GET"]);
	}
	const { context, seen } = fixture(original(["EMAIL;ENCODING=QUOTED-PRINTABLE:private-input"]));
	await assert.rejects(updateContact(context, { ...target, email: null }), error => {
		assert.ok(safeError("REPAIR_UNSUPPORTED")(error));
		assert.equal((error as DavToolError).details?.stage, "edit");
		return true;
	});
	assert.deepEqual(seen.map(item => item.method), ["GET"]);
	for (const action of [updateContact, deleteContact]) {
		const bad = fixture("secret-bad-source");
		await assert.rejects(action(bad.context, target), safeError(action === updateContact ? "REPAIR_UNSUPPORTED" : "DATA_INVALID"));
		assert.deepEqual(bad.seen.map(item => item.method), ["GET"]);
	}
});

test("条件 DELETE 用调用方旧版本，只写一次且成功后不回读", async () => {
	const { context, seen } = fixture();
	assert.deepEqual(await deleteContact(context, target), { account, resourceUrl, uid, etag, outcome: "deleted" });
	assert.deepEqual(seen.map(item => item.method), ["GET", "DELETE"]);
	assert.equal(seen[1]!.headers.get("if-match"), etag);
	assert.equal(seen[1]!.url, resourceUrl);
});

test("写入 412 冲突不重试，创建/更新响应无 ETag 时不补 GET", async () => {
	for (const action of [updateContact, deleteContact]) {
		const { context, seen } = fixture(undefined, { writeStatus: 412 });
		await assert.rejects(action(context, { ...target, name: "新名" }), { status: 412 });
		assert.deepEqual(seen.map(item => item.method), ["GET", action === updateContact ? "PUT" : "DELETE"]);
	}
	const first = fixture(undefined, { newEtag: null });
	assert.equal((await createContact(first.context, { account, collectionUrl, name: "创建" })).etag, null);
	assert.deepEqual(first.seen.map(item => item.method), ["PUT"]);
	const second = fixture(undefined, { newEtag: null });
	assert.equal((await updateContact(second.context, { ...target, note: "更新" })).etag, null);
	assert.deepEqual(second.seen.map(item => item.method), ["GET", "PUT"]);
});
