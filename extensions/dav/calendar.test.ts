import assert from "node:assert/strict";
import { test } from "node:test";
import { DavClient, type DavQueryOptions, type DavResource } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { getCalendar, listCalendar } from "./calendar.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = "test", collectionUrl = "https://dav.example.invalid/calendar/";
const window = { account, collectionUrl, start: "2026-01-01T00:00:00Z", end: "2026-01-04T00:00:00Z" };
const calendar = (...components: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...components, "END:VCALENDAR", ""].join("\r\n");
const component = (kind: string, ...lines: string[]) => [`BEGIN:${kind}`, ...lines, `END:${kind}`].join("\r\n");
const event = (...lines: string[]) => component("VEVENT", ...lines);
function resource(data: string, name = "a.ics", etag: string | null = '"v1"'): DavResource {
	return { url: collectionUrl + name, data, etag, contentType: "text/calendar" };
}
function fixture(resources: DavResource[], timeZone?: string) {
	const queries: { url: string; kind: string; options?: DavQueryOptions }[] = [], gets: string[] = [];
	// 仅替代网络边界；解析、时间与重复均使用真实安装库。
	const client = {
		async query(url: string, kind: string, options?: DavQueryOptions) { queries.push({ url, kind, options }); return resources; },
		async get(url: string) { gets.push(url); return resources[0]; },
	} as unknown as DavClient;
	const context: DavReadContext = { client, ical, vcard, timeZone };
	return { context, queries, gets };
}
function assertCode(code: string) {
	return (error: unknown) => {
		assert.ok(error instanceof DavToolError);
		assert.equal(error.code, code);
		assert.doesNotMatch(error.message, /SECRET|PRIVATE|BEGIN:VCALENDAR/);
		return true;
	};
}
function assertNoRaw(value: unknown) {
	if (!value || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		assert.notEqual(key, "raw");
		assertNoRaw(entry);
	}
}

test("事件按跨资源 instant 排序，同 UID 资源独立展开并保留两种身份", async () => {
	const later = resource(calendar(event("UID:same", "DTSTART:20260102T120000Z", "DTEND:20260102T130000Z",
		"RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:后", "DESCRIPTION:PRIVATE")), "later.ics");
	const recurring = resource(calendar(
		event("UID:same", "DTSTART:20260101T100000Z", "DTEND:20260101T110000Z", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:前"),
		event("UID:same", "RECURRENCE-ID:20260102T100000Z", "DTSTART:20260102T090000Z", "DTEND:20260102T093000Z", "SUMMARY:例外"),
	), "earlier.ics");
	const f = fixture([later, recurring], "UTC");
	const result = await listCalendar(f.context, window, "VEVENT");
	assert.equal(result.complete, true);
	assert.equal(result.account, account); assert.equal(result.collectionUrl, collectionUrl);
	assert.deepEqual(f.queries, [{ url: collectionUrl, kind: "calendar", options: { component: "VEVENT" } }]);
	assert.ok("start" in result && "end" in result && "timeZone" in result);
	assert.equal(result.start, "20260101T000000Z"); assert.equal(result.end, "20260104T000000Z");
	assert.equal(result.timeZone, "UTC");
	assert.deepEqual(result.items.map(item => [item.resourceUrl, item.uid, item.recurrenceId, item.storedRecurrenceId]), [
		[recurring.url, "same", "20260101T100000Z", null],
		[recurring.url, "same", "20260102T100000Z", "RECURRENCE-ID:20260102T100000Z"],
		[later.url, "same", "20260102T120000Z", null], [later.url, "same", "20260103T120000Z", null],
	]);
	const first = result.items[0];
	assert.ok("startInstant" in first && "start" in first && first.start);
	assert.equal(first.startInstant, Date.parse("2026-01-01T10:00:00Z"));
	assert.equal(first.start.kind, "utc");
	assertNoRaw(result); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|description/);
});

test("显式时区是展开前提，输入时区优先于账户；floating 与全天由库解释", async () => {
	const data = calendar(event("UID:floating", "DTSTART:20260101T090000", "DURATION:PT1H"),
		event("UID:day", "DTSTART;VALUE=DATE:20260102", "SUMMARY:全天"));
	const f = fixture([resource(data)], "America/New_York");
	const result = await listCalendar(f.context, { ...window, timeZone: "Asia/Shanghai" }, "VEVENT");
	const first = result.items[0], second = result.items[1];
	assert.ok("startInstant" in first && "endInstant" in first);
	assert.equal(first.startInstant, Date.parse("2026-01-01T01:00:00Z"));
	assert.equal(first.endInstant, Date.parse("2026-01-01T02:00:00Z"));
	assert.ok("startInstant" in second && "start" in second && second.start);
	assert.equal(second.startInstant, Date.parse("2026-01-01T16:00:00Z"));
	assert.equal(second.start.kind, "date");
	const missing = fixture([resource(data)]);
	await assert.rejects(listCalendar(missing.context, window, "VEVENT"), assertCode("TIMEZONE_REQUIRED"));
	assert.equal(missing.queries.length, 0);
	await assert.rejects(listCalendar(f.context, { ...window, timeZone: "PRIVATE" }, "VEVENT"), assertCode("INVALID_INPUT"));
});

test("服务器按 UTC 解释 floating 时不做时间窗预筛选，避免漏掉调用时区内的事件", async () => {
	const data = [
		resource(calendar(event("UID:floating", "DTSTART:20260101T090000", "DURATION:PT1H")), "floating.ics"),
		resource(calendar(event("UID:outside", "DTSTART:20260103T090000", "DURATION:PT1H")), "outside.ics"),
	];
	const requests: string[] = [];
	const client = new DavClient({
		baseUrl: collectionUrl, basicAuth: { username: "fixture", password: "fixture" },
		fetch: async (_url, init) => {
			assert.equal(init?.method, "REPORT");
			const body = String(init.body); requests.push(body);
			// 服务端使用 UTC，09:00 floating 不在 00:30–02:30 UTC 内。
			const candidates = body.includes(":time-range") ? [] : data;
			return new Response(`<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${candidates.map(item =>
				`<d:response><d:href>${item.url}</d:href><d:propstat><d:prop><d:getetag>${item.etag}</d:getetag><c:calendar-data><![CDATA[${item.data}]]></c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("")}</d:multistatus>`, { status: 207 });
		},
	});
	assert.deepEqual(await client.query(collectionUrl, "calendar", { component: "VEVENT", start: "20260101T003000Z", end: "20260101T023000Z" }), []);
	requests.length = 0;
	const result = await listCalendar({ client, ical, vcard }, { account, collectionUrl,
		start: "2026-01-01T00:30:00Z", end: "2026-01-01T02:30:00Z", timeZone: "Asia/Shanghai" }, "VEVENT");
	assert.equal(result.complete, true);
	assert.deepEqual(result.items.map(item => item.uid), ["floating"]);
	const item = result.items[0]; assert.ok("startInstant" in item);
	assert.equal(item.startInstant, Date.parse("2026-01-01T01:00:00Z"));
	assert.equal(requests.length, 1);
	assert.doesNotMatch(requests[0], /:time-range/);
});

test("窗口接受基本 UTC 和显式 Z／offset 的秒精度 ISO，不使用主机时区或修复无效日期", async () => {
	const f = fixture([], "UTC");
	const basic = await listCalendar(f.context, { ...window, start: "20260101T000000Z", end: "2026-01-04T00:00:00.000Z" }, "VEVENT");
	assert.ok("end" in basic); assert.equal(basic.end, "20260104T000000Z");
	const offset = await listCalendar(f.context, { ...window, start: "2026-01-01T08:00:00+08:00", end: "2026-01-03T19:00:00-05:00" }, "VEVENT");
	assert.ok("start" in offset && "end" in offset);
	assert.equal(offset.start, "20260101T000000Z"); assert.equal(offset.end, "20260104T000000Z");
	assert.deepEqual(f.queries.map(query => query.options), [{ component: "VEVENT" }, { component: "VEVENT" }]);
	for (const start of [undefined, "2026-01-01T00:00:00", "2026-01-01T00:00:00.123Z", "20260230T000000Z",
		"2026-02-30T00:00:00+08:00", "2026-01-01T00:00:00+08:99", "20260104T000000Z"]) {
		await assert.rejects(listCalendar(f.context, { ...window, start }, "VEVENT"), assertCode("INVALID_INPUT"));
	}
	assert.equal(f.queries.length, 2);
});

test("待办与日记按 kind/UID/status 过滤，只返回存储组件及可用时间，不展开 RRULE", async () => {
	const f = fixture([resource(calendar(
		component("VTODO", "UID:todo", "DTSTART:20260101T090000", "DUE:20260101T100000", "STATUS:NEEDS-ACTION", "RRULE:FREQ=DAILY;COUNT=99", "DESCRIPTION:PRIVATE"),
		component("VTODO", "UID:todo", "RECURRENCE-ID:20260102T090000", "DTSTART:20260102T090000", "STATUS:COMPLETED", "COMPLETED:20260102T100000Z"),
		component("VJOURNAL", "UID:journal", "DTSTART;VALUE=DATE:20260101", "STATUS:FINAL", "RRULE:FREQ=DAILY;COUNT=99"),
		event("UID:other", "DTSTART:20260101T000000Z"),
	))]);
	const todos = await listCalendar(f.context, { account, collectionUrl, uid: "todo", status: "completed" }, "VTODO");
	assert.ok("storedComponents" in todos && todos.storedComponents);
	assert.equal(todos.items.length, 1);
	assert.equal(todos.items[0]?.recurrenceId, "RECURRENCE-ID:20260102T090000");
	assert.ok("completed" in todos.items[0]);
	const journals = await listCalendar(f.context, { account, collectionUrl }, "VJOURNAL");
	assert.ok("storedComponents" in journals && journals.storedComponents);
	assert.equal(journals.items.length, 1);
	const journal = journals.items[0];
	assert.ok("start" in journal && journal.start); assert.equal(journal.start.kind, "date");
	assert.equal(journal.start.epochMilliseconds, null);
	assert.deepEqual(f.queries.map(query => query.options), [{ component: "VTODO" }, { component: "VJOURNAL" }]);
	assertNoRaw(todos); assertNoRaw(journals); assert.doesNotMatch(JSON.stringify(todos), /PRIVATE|description/);
});

test("GET 精确匹配 kind/UID/完整 recurrenceId，默认主件且保留属性提醒，不泄露各层 raw", async () => {
	const raw = calendar(
		event("UID:series", "DTSTART;TZID=Asia/Shanghai:20260101T090000", "DESCRIPTION:详情", "SUMMARY:主件",
			component("VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:提醒")),
		event("UID:series", "RECURRENCE-ID;TZID=Asia/Shanghai:\r\n 20260102T090000", "DTSTART;TZID=Asia/Shanghai:20260102T100000", "SUMMARY:例外"),
		component("VTODO", "UID:series", "SUMMARY:不是事件"),
	);
	const r = resource(raw, "identity.ics", null), f = fixture([r]);
	const input = { account, resourceUrl: r.url, uid: "series" };
	const master = await getCalendar(f.context, input, "VEVENT");
	assert.ok(master.selectorVerified);
	assert.equal(master.summary, "主件"); assert.equal(master.recurrenceId, null);
	assert.equal(master.description, "详情"); assert.equal(master.etag, null);
	assert.equal(master.alarms[0]?.properties.find(property => property.name === "TRIGGER")?.value, "-PT15M");
	assert.equal(master.properties.find(property => property.name === "DTSTART")?.parameters.TZID[0], "Asia/Shanghai");
	assertNoRaw(master);
	const selected = await getCalendar(f.context, { ...input, recurrenceId: "RECURRENCE-ID;TZID=Asia/Shanghai:20260102T090000", raw: true }, "VEVENT");
	assert.ok(selected.selectorVerified);
	assert.equal(selected.summary, "例外"); assert.equal(selected.raw, raw);
	const { raw: _raw, ...details } = selected; assertNoRaw(details);
	await assert.rejects(getCalendar(f.context, { ...input, recurrenceId: "20260102T090000" }, "VEVENT"), assertCode("NOT_FOUND"));
	assert.deepEqual(f.gets, [r.url, r.url, r.url]); assert.equal(f.queries.length, 0);
	const todo = await getCalendar(f.context, input, "VTODO");
	assert.ok(todo.selectorVerified); assert.equal(todo.summary, "不是事件");
});

test("GET 拒绝主件/例外歧义，RANGE 内容降级，例外独存时不假选主件", async () => {
	const base = event("UID:u", "DTSTART:20260101T000000Z");
	const recurrenceId = "RECURRENCE-ID;VALUE=DATE:20260102";
	const detached = event("UID:u", recurrenceId, "DTSTART;VALUE=DATE:20260102");
	const input = { account, resourceUrl: collectionUrl + "a.ics", uid: "u" };
	for (const data of [calendar(base, base), calendar(detached, detached)]) {
		const f = fixture([resource(data)]);
		await assert.rejects(getCalendar(f.context, { ...input, ...(data.includes(recurrenceId) ? { recurrenceId } : {}) }, "VEVENT"), assertCode("AMBIGUOUS_TARGET"));
	}
	const f = fixture([resource(calendar(detached))]);
	await assert.rejects(getCalendar(f.context, input, "VEVENT"), assertCode("NOT_FOUND"));
	const selected = await getCalendar(f.context, { ...input, recurrenceId }, "VEVENT");
	assert.ok(selected.selectorVerified); assert.equal(selected.recurrenceId, recurrenceId);
	const range = "RECURRENCE-ID;RANGE=THISANDFUTURE:20260102T000000Z";
	const unsupported = fixture([resource(calendar(event("UID:u", range, "DTSTART:20260102T000000Z")))], "UTC");
	const detail = await getCalendar(unsupported.context, { ...input, recurrenceId: range }, "VEVENT");
	assert.equal(detail.complete, false); assert.equal(detail.selectorVerified, false);
	assert.equal(detail.raw, calendar(event("UID:u", range, "DTSTART:20260102T000000Z")));
	const list = await listCalendar(unsupported.context, window, "VEVENT");
	assert.equal(list.complete, false); assert.equal(list.resourcesComplete, true);
	assert.deepEqual(list.items, []); assert.equal(list.unresolvedResources[0]?.stage, "expand");
});

test("坏资源独立保留原文与诊断，正常发生项和存储组件继续返回", async () => {
	const good = resource(calendar(event("UID:good", "DTSTART:20260101T000000Z")));
	for (const bad of ["PRIVATE invalid source", calendar(event("UID:bad", "DTSTART:20260230T000000Z")),
		calendar(event("UID:bad", "DTSTART:20260101T000000Z", "RRULE:FREQ=PRIVATE")),
		calendar(event("UID:bad", "DTSTART:20260101T000000Z"), event("UID:bad", "DTSTART:20260101T000000Z"))]) {
		const broken = resource(bad, "bad.ics"), f = fixture([good, broken], "UTC");
		const result = await listCalendar(f.context, window, "VEVENT");
		assert.equal(result.complete, false); assert.equal(result.resourcesComplete, true);
		assert.deepEqual(result.items.map(item => item.uid), ["good"]);
		const unresolved = result.unresolvedResources[0];
		assert.equal(unresolved?.raw, bad); assert.equal(unresolved.resourceUrl, broken.url);
		assert.equal(unresolved.rawSource, "report"); assert.ok(unresolved.issues.length);
		assert.doesNotMatch(JSON.stringify(unresolved.issues), /PRIVATE|invalid source/);
	}
	for (const data of ["SECRET malformed", calendar(component("VTODO", "UID:u", "DUE:PRIVATE"))]) {
		const goodTodo = resource(calendar(component("VTODO", "UID:good", "DUE:20260102T090000Z")), "good.ics");
		const f = fixture([resource(data), goodTodo]);
		const list = await listCalendar(f.context, { account, collectionUrl }, "VTODO");
		assert.equal(list.complete, false); assert.equal(list.resourcesComplete, true);
		assert.deepEqual(list.items.map(item => item.uid), ["good"]);
		assert.equal(list.unresolvedResources[0]?.raw, data);
		const detail = await getCalendar(f.context, { account, resourceUrl: collectionUrl + "a.ics", uid: "u" }, "VTODO");
		assert.equal(detail.complete, false); assert.equal(detail.selectorVerified, false);
		assert.equal(detail.raw, data); assert.equal(detail.rawSource, "get");
	}
});

test("网络与取消错误不被解析错误映射掩盖，也不自动重试", async () => {
	for (const error of [new DOMException("已取消", "AbortError"), new DavToolError("CANCELLED", "已取消"), new Error("网络错误")]) {
		let calls = 0;
		const client = { async query() { calls++; throw error; }, async get() { calls++; throw error; } } as unknown as DavClient;
		const context: DavReadContext = { client, ical, vcard, timeZone: "UTC" };
		await assert.rejects(listCalendar(context, window, "VEVENT"), candidate => candidate === error);
		await assert.rejects(getCalendar(context, { account, resourceUrl: collectionUrl + "a.ics", uid: "u" }, "VEVENT"), candidate => candidate === error);
		assert.equal(calls, 2);
	}
});
