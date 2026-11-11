import assert from "node:assert/strict";
import { test } from "node:test";
import { DavClient, DavProtocolError, type DavResource } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { getCalendar, listCalendar } from "./calendar.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = "fixture", collectionUrl = "https://dav.example.invalid/cal/";
const input = { account, collectionUrl, start: "20260101T000000Z", end: "20260104T000000Z" };
const component = (kind: string, ...lines: string[]) => [`BEGIN:${kind}`, ...lines, `END:${kind}`].join("\r\n");
const event = (...lines: string[]) => component("VEVENT", ...lines);
const calendar = (...parts: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...parts, "END:VCALENDAR", ""].join("\r\n");
function resource(data: string, name = "actual.ics"): DavResource {
	return { url: collectionUrl + name, etag: '"actual-v2"', data, contentType: "text/calendar" };
}
function fixture(resources: DavResource[]) {
	const calls: string[] = [];
	const client = {
		async query() { calls.push("REPORT"); return resources; },
		async get() { calls.push("GET"); return resources[0]; },
	} as unknown as DavClient;
	const context: DavReadContext = { client, ical, vcard, timeZone: "UTC" };
	return { context, calls };
}
const good = resource(calendar(event("UID:good", "DTSTART:20260101T090000Z")), "good.ics");

test("四类展开兼容问题独立保真：结束冲突、重复规则、时区、范围例外", async () => {
	const failures = [
		calendar(event("UID:bad", "DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", "DURATION:PT1H")),
		calendar(event("UID:bad", "DTSTART:20260101T090000Z", "RRULE:FREQ=PRIVATE")),
		calendar(event("UID:bad", "DTSTART;TZID=PRIVATE:20260101T090000")),
		calendar(event("UID:bad", "RECURRENCE-ID;RANGE=THISANDFUTURE:20260101T090000Z", "DTSTART:20260101T100000Z")),
	];
	for (const raw of failures) {
		const bad = resource(raw), f = fixture([good, bad]);
		const result = await listCalendar(f.context, input, "VEVENT");
		assert.equal(result.complete, false); assert.equal(result.resourcesComplete, true);
		assert.deepEqual(result.items.map(item => item.uid), ["good"]);
		assert.equal(result.unresolvedResources.length, 1);
		const unresolved = result.unresolvedResources[0];
		assert.equal(unresolved.stage, "expand"); assert.equal(unresolved.rawSource, "report");
		assert.equal(unresolved.resourceUrl, bad.url); assert.equal(unresolved.etag, bad.etag);
		assert.equal(unresolved.raw, raw); assert.ok(unresolved.issues.length);
		assert.deepEqual(unresolved.issues, ical.validateCalendarResource(raw).issues);
		assert.doesNotMatch(JSON.stringify(unresolved.issues), /PRIVATE|BEGIN:VCALENDAR/);
	}
});

test("失败资源中的正常兄弟发生项也不部分输出，且不拆分系列后重新展开", async () => {
	const raw = calendar(event("UID:sibling", "DTSTART:20260101T080000Z"),
		event("UID:broken", "DTSTART:20260101T090000Z", "RDATE;VALUE=PERIOD:20260102T090000Z/PT1H"));
	const f = fixture([good, resource(raw)]), expanded: string[] = [];
	f.context.ical = { ...ical, expandEvents(data, options) { expanded.push(data); return ical.expandEvents(data, options); } };
	const result = await listCalendar(f.context, input, "VEVENT");
	assert.deepEqual(result.items.map(item => item.uid), ["good"]);
	assert.equal(result.unresolvedResources[0]?.raw, raw);
	assert.deepEqual(expanded, [good.data, raw]);
});

test("可靠 kind/uid/status 无关可先排除时间错误；未知身份或状态不能假定不匹配", async () => {
	const irrelevant = [
		resource(calendar(component("VTODO", "UID:other", "DUE:PRIVATE")), "kind.ics"),
		resource(calendar(event("UID:other", "DTSTART:PRIVATE")), "uid.ics"),
		resource(calendar(event("UID:good", "STATUS:CANCELLED", "DTSTART:PRIVATE")), "status.ics"),
	];
	const f = fixture([good, ...irrelevant]);
	const result = await listCalendar(f.context, { ...input, uid: "good", status: "CONFIRMED" }, "VEVENT");
	assert.equal(result.complete, true); assert.equal(result.resourcesComplete, true);
	assert.deepEqual(result.items, []); assert.deepEqual(result.unresolvedResources, []);
	for (const raw of ["PRIVATE malformed", calendar(event("DTSTART:PRIVATE")),
		calendar(event("UID:good", "STATUS:CANCELLED", "STATUS:CONFIRMED", "DTSTART:20260101T090000Z")),
		calendar(event("UID:good", "STATUS;ENCODING=BASE64:UFJJVkFURQ==", "DTSTART:20260101T090000Z"))]) {
		const unknown = await listCalendar(fixture([resource(raw)]).context, { ...input, uid: "good", status: "CONFIRMED" }, "VEVENT");
		assert.equal(unknown.complete, false); assert.equal(unknown.unresolvedResources[0]?.raw, raw);
		assert.deepEqual(unknown.items, []);
	}
});

test("结构与字段投影分别降级；GET 明示选择器未验证并保留可靠身份", async () => {
	for (const [raw, stage] of [["PRIVATE malformed", "parse"],
		[calendar(component("VTODO", "UID:u", "SUMMARY:可读", "DUE:PRIVATE")), "projection"]] as const) {
		const r = resource(raw), f = fixture([r]);
		const list = await listCalendar(f.context, { account, collectionUrl }, "VTODO");
		assert.equal(list.complete, false); assert.equal(list.unresolvedResources[0]?.stage, stage);
		const result = await getCalendar(f.context, { account, resourceUrl: collectionUrl + "requested.ics", uid: "u" }, "VTODO");
		assert.equal(result.complete, false); assert.equal(result.selectorVerified, false);
		assert.equal(result.raw, raw); assert.equal(result.rawSource, "get");
		assert.equal(result.resourceUrl, r.url); assert.equal(result.etag, r.etag);
		if (stage === "projection") {
			assert.ok("components" in result); assert.equal(result.components?.[0]?.uid, "u");
		}
	}
});

test("GET 可靠不匹配或歧义始终报错，raw 不掩盖选错且不依赖业务时间", async () => {
	for (const raw of [calendar(event("UID:other", "DTSTART:PRIVATE")),
		calendar(component("VTODO", "UID:u", "DUE:PRIVATE"))]) {
		for (const explicitRaw of [true, false]) {
			await assert.rejects(getCalendar(fixture([resource(raw)]).context,
				{ account, resourceUrl: collectionUrl + "x.ics", uid: "u", raw: explicitRaw }, "VEVENT"),
				error => error instanceof DavToolError && error.code === "NOT_FOUND");
		}
	}
	const raw = calendar(event("UID:u", "DTSTART:PRIVATE"), event("UID:u", "DTSTART:PRIVATE"));
	await assert.rejects(getCalendar(fixture([resource(raw)]).context,
		{ account, resourceUrl: collectionUrl + "x.ics", uid: "u", raw: true }, "VEVENT"),
		error => error instanceof DavToolError && error.code === "AMBIGUOUS_TARGET");
});

test("无 UID raw GET 只确认整资源取得，零解析、不伪造组件身份", async () => {
	const r = resource("PRIVATE malformed"), f = fixture([r]);
	f.context.ical = { ...ical, parseCalendar() { assert.fail("整资源原文模式不得依赖解析"); } };
	const result = await getCalendar(f.context, { account, resourceUrl: collectionUrl + "requested.ics", raw: true }, "VEVENT");
	assert.equal(result.complete, true); assert.equal(result.completenessScope, "resource");
	assert.equal(result.selectorVerified, false); assert.equal(result.selectorStatus, "not-requested");
	assert.equal(result.raw, r.data); assert.equal(result.rawSource, "get");
	assert.equal(result.resourceUrl, r.url); assert.equal(result.etag, r.etag);
	for (const name of ["uid", "kind", "recurrenceId", "summary", "properties"]) assert.equal(name in result, false);
	assert.deepEqual(f.calls, ["GET"]);
});

test("GET 参数关系在联网前一次拒绝：普通详情缺 UID、例外选择器单独出现", async () => {
	const f = fixture([good]);
	for (const selector of [{}, { raw: false }, { recurrenceId: "RECURRENCE-ID:20260101T090000Z" },
		{ raw: true, recurrenceId: "RECURRENCE-ID:20260101T090000Z" }]) {
		await assert.rejects(getCalendar(f.context, { account, resourceUrl: good.url, ...selector }, "VEVENT"),
			error => error instanceof DavToolError && error.code === "INVALID_INPUT");
	}
	assert.deepEqual(f.calls, []);
});

test("既有四份问题形态均保留原文，不把无法展开的源记录当作空日程", async () => {
	for (const fields of [
		["DTSTART:20260101T090000Z", "DTEND:20260101T100000Z", "DURATION:PT1H"],
		["DTSTART:20260101T090000Z", "RRULE:FREQ=DAILY;COUNT=2;UNTIL=20260103T090000Z"],
		["DTSTART;VALUE=DATE:20260101", "RRULE:FREQ=DAILY;UNTIL=20260103T000000Z"],
		["DTSTART;VALUE=DATE:20260101", "RRULE:FREQ=DAILY;UNTIL=20260103T000000"],
	]) {
		const raw = calendar("PRODID:-//fixture//CN", event("UID:bad", "DTSTAMP:20260101T000000Z", ...fields));
		const result = await listCalendar(fixture([good, resource(raw)]).context, input, "VEVENT");
		assert.equal(result.resourcesComplete, true); assert.equal(result.complete, false);
		assert.deepEqual(result.items.map(item => item.uid), ["good"]);
		assert.equal(result.unresolvedResources.length, 1);
		assert.equal(result.unresolvedResources[0]?.stage, "expand");
		assert.equal(result.unresolvedResources[0]?.raw, raw);
		assert.ok(result.unresolvedResources[0]?.issues.length);
	}
});

test("写校验失败不阻止能可靠计算的读取；无法解释的诊断也不能替代发生项计算", async () => {
	assert.equal(ical.validateCalendarResource(good.data).valid, false); // 合成资源缺少 PRODID/DTSTAMP。
	const result = await listCalendar(fixture([good]).context, input, "VEVENT");
	assert.equal(result.complete, true); assert.equal(result.items.length, 1);
	assert.deepEqual(result.unresolvedResources, []);
	const f = fixture([good]);
	f.context.ical = { ...ical, expandEvents() { throw new Error("PRIVATE budget exhausted"); },
		validateCalendarResource() { return { valid: true, issues: [] }; } };
	const failed = await listCalendar(f.context, input, "VEVENT");
	assert.equal(failed.complete, false); assert.deepEqual(failed.items, []);
	assert.equal(failed.unresolvedResources[0]?.stage, "expand");
	assert.equal(failed.unresolvedResources[0]?.raw, good.data);
	assert.doesNotMatch(JSON.stringify(failed.unresolvedResources[0]?.issues), /PRIVATE|budget exhausted/);
});

test("投影按整资源提交，不泄露失败资源的部分待办/日记，但可排除可靠无关组件", async () => {
	for (const kind of ["VTODO", "VJOURNAL"] as const) {
		const goodPart = component(kind, "UID:u", "DTSTART;VALUE=DATE:20260101");
		const badPart = component(kind, "UID:u", "DTSTART:PRIVATE", "RECURRENCE-ID:20260102T090000Z");
		const raw = calendar(goodPart, badPart);
		const mixed = await listCalendar(fixture([resource(raw)]).context, { account, collectionUrl }, kind);
		assert.equal(mixed.complete, false); assert.deepEqual(mixed.items, []);
		assert.equal(mixed.unresolvedResources[0]?.stage, "projection");
		assert.equal(mixed.unresolvedResources[0]?.raw, raw);
		const filtered = await listCalendar(fixture([resource(calendar(goodPart,
			component(kind, "UID:other", "DTSTART:PRIVATE")))]).context, { account, collectionUrl, uid: "u" }, kind);
		assert.equal(filtered.complete, true); assert.equal(filtered.items.length, 1);
	}
});

test("GET 与 REPORT 保留各自实际正文，不把 XML 规范化结果冒充 GET 原文", async () => {
	const raw = calendar(event("UID:u", "DTSTART:PRIVATE", "SUMMARY:原文"));
	const methods: string[] = [];
	const client = new DavClient({ baseUrl: collectionUrl, basicAuth: { username: "fixture", password: "fixture" },
		fetch: async (_url, init) => {
			methods.push(String(init?.method));
			if (init?.method === "GET") return new Response(raw, { status: 200, headers: { etag: '"get-v2"' } });
			assert.doesNotMatch(String(init?.body), /:time-range/);
			return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${collectionUrl}actual.ics</d:href><d:propstat><d:prop><d:getetag>"report-v1"</d:getetag><c:calendar-data><![CDATA[${raw}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`, { status: 207 });
		} });
	const context: DavReadContext = { client, ical, vcard, timeZone: "UTC" };
	const list = await listCalendar(context, input, "VEVENT");
	assert.equal(list.unresolvedResources[0]?.raw, raw.replace(/\r\n/g, "\n"));
	assert.equal(list.unresolvedResources[0]?.rawSource, "report");
	assert.equal(list.unresolvedResources[0]?.etag, '"report-v1"');
	const detail = await getCalendar(context, { account, resourceUrl: collectionUrl + "actual.ics", uid: "u" }, "VEVENT");
	assert.equal(detail.complete, false); assert.equal(detail.raw, raw);
	assert.equal(detail.rawSource, "get"); assert.equal(detail.etag, '"get-v2"');
	assert.deepEqual(methods, ["REPORT", "GET"]);
});

test("本地内容边界也不吞掉明确的取消、权限或协议异常", async () => {
	for (const error of [new DOMException("PRIVATE cancelled", "AbortError"), new DavToolError("FORBIDDEN", "PRIVATE denied"),
		new DavProtocolError("PRIVATE protocol")]) {
		for (const stage of ["parse", "expand", "projection"] as const) {
			const f = fixture([good]);
			f.context.ical = { ...ical,
				...(stage === "parse" ? { parseCalendar() { throw error; } } : {}),
				...(stage === "expand" ? { expandEvents() { throw error; } } : {}),
				...(stage === "projection" ? { parseCalendarTime() { throw error; } } : {}),
			};
			// 投影失败使用详情，避免先触发列表窗口的参数解析。
			const request = stage === "projection" ? getCalendar(f.context, { account, resourceUrl: good.url, uid: "good" }, "VEVENT")
				: listCalendar(f.context, input, "VEVENT");
			await assert.rejects(request, candidate => candidate === error);
		}
	}
});

test("本地 fetch 的认证、协议、网络及取消失败仍传播，不降级为内容成功", async () => {
	for (const reply of [() => new Response("PRIVATE", { status: 403 }),
		() => new Response("PRIVATE not XML", { status: 207 }),
		() => { throw new Error("PRIVATE network"); },
		() => { throw new DOMException("PRIVATE cancel", "AbortError"); }]) {
		let calls = 0;
		const client = new DavClient({ baseUrl: collectionUrl, basicAuth: { username: "fixture", password: "fixture" },
			fetch: async () => { calls++; return reply(); } });
		await assert.rejects(listCalendar({ client, ical, vcard, timeZone: "UTC" }, input, "VEVENT"));
		assert.equal(calls, 1);
	}
});
