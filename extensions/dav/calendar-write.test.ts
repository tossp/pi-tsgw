import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { DavClient, DavConflictError } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { createCalendar, deleteCalendar, updateCalendar } from "./calendar-write.ts";
import { calendarWriteSchemas } from "./calendar-write-schema.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = "fixture", collectionUrl = "https://dav.example.invalid/calendar/", resourceUrl = collectionUrl + "old.ics";
const identity = { account, resourceUrl, uid: "series", etag: '"v1"' };
const stamp = "DTSTAMP:20260101T000000Z";
const calendar = (...components: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "X-ROOT:保留", ...components, "END:VCALENDAR", ""].join("\r\n");
const component = (kind: string, ...lines: string[]) => [`BEGIN:${kind}`, ...lines, `END:${kind}`].join("\r\n");
const event = (...lines: string[]) => component("VEVENT", "UID:series", stamp, ...lines);
const simple = () => calendar(event("DTSTART:20260101T090000Z", "SUMMARY:原文", "SEQUENCE:3"));
const alarm = component("VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:合成提醒") + "\r\n";

function fixture(raw = simple(), currentEtag: string | null = identity.etag, writeEtag: string | null = '"v2"', writeStatus = 204) {
	const calls: { method: string; url: string; headers: Headers; body: string }[] = [];
	const client = new DavClient({ baseUrl: collectionUrl, fetch: async (url, init) => {
		const method = init?.method ?? "GET";
		calls.push({ method, url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
		if (method === "GET") return new Response(raw, { status: 200, headers: currentEtag ? { ETag: currentEtag } : {} });
		return new Response(null, { status: writeStatus, headers: writeEtag ? { ETag: writeEtag } : {} });
	} });
	const context: DavReadContext = { client, ical, vcard };
	return { context, calls };
}
function assertCode(code: string) {
	return (error: unknown) => {
		assert.ok(error instanceof DavToolError);
		assert.equal(error.code, code);
		assert.doesNotMatch(error.message, /PRIVATE|SECRET|BEGIN:VCALENDAR/);
		return true;
	};
}
function prop(data: string, name: string, recurrenceId: string | null = null) {
	return ical.parseCalendar(data).components.find(value => value.recurrenceId === recurrenceId)?.properties.find(value => value.name === name);
}
function validate(name: keyof typeof calendarWriteSchemas, args: Parameters<typeof validateToolArguments>[1]["arguments"]) {
	return validateToolArguments({ name, description: "合成日历写入", parameters: calendarWriteSchemas[name] },
		{ id: "fixture", type: "toolCall", name, arguments: args });
}

test("九个 schema 约束时间和分型，创建必填字段与整资源删除边界", () => {
	const input = { account, collectionUrl, summary: "合成" };
	assert.deepEqual(validate("event_create", { ...input, start: { value: "20261112T090000", tzid: "Asia/Shanghai" } }),
		{ ...input, start: { value: "20261112T090000", tzid: "Asia/Shanghai" } });
	assert.deepEqual(validate("todo_create", input), input);
	assert.deepEqual(validate("journal_create", { ...input, date: "20261112" }), { ...input, date: "20261112" });
	assert.deepEqual(validate("event_update", { ...identity, start: null, rrule: null, alarms: [], properties: [] }),
		{ ...identity, start: null, rrule: null, alarms: [], properties: [] });
	assert.deepEqual(validate("todo_update", { ...identity, due: { value: "20261112T000000Z" } }),
		{ ...identity, due: { value: "20261112T000000Z" } });
	assert.deepEqual(validate("journal_update", { ...identity, date: null }), { ...identity, date: null });
	for (const name of ["event_delete", "todo_delete", "journal_delete"] as const) {
		assert.deepEqual(validate(name, identity), identity);
		assert.throws(() => validate(name, { ...identity, recurrenceId: "RECURRENCE-ID:20261112T000000Z" }));
	}
	for (const name of ["event_create", "journal_create"] as const) assert.throws(() => validate(name, input));
	assert.throws(() => validate("event_create", { ...input, start: "2026-11-12T00:00:00Z" }));
	assert.throws(() => validate("event_create", { ...input, start: "20261112T000000Z", uid: "caller" }));
	assert.throws(() => validate("todo_update", { ...identity, end: "20261112T000000Z" }));
	assert.throws(() => validate("journal_update", { ...identity, alarms: [] }));
});

test("事件创建保留 TZID 重复系列、库 UID 和 TEXT 转义，随机路径条件创建且不回读", async () => {
	const f = fixture();
	const result = await createCalendar(f.context, { account, collectionUrl, summary: "合成,标题;一\n二", description: "描述,\n下一行",
		location: "会议室;甲", status: "CONFIRMED", start: { value: "20261112T090000", tzid: "Asia/Shanghai" },
		end: { value: "20261112T100000", tzid: "Asia/Shanghai" }, rrule: "FREQ=DAILY;COUNT=3", alarms: [alarm],
		properties: ["X-KEEP:opaque"] }, "VEVENT");
	assert.equal(result.outcome, "created"); assert.equal(result.etag, '"v2"');
	assert.match(result.uid, /^[0-9a-f-]{36}$/i);
	assert.match(result.resourceUrl, /^https:\/\/dav\.example\.invalid\/calendar\/[0-9a-f-]{36}\.ics$/i);
	assert.notEqual(result.resourceUrl, collectionUrl + result.uid + ".ics");
	assert.equal(f.calls.length, 1);
	const call = f.calls[0]!; assert.equal(call.method, "PUT"); assert.equal(call.url, result.resourceUrl);
	assert.equal(call.headers.get("if-none-match"), "*"); assert.equal(call.headers.get("if-match"), null);
	assert.equal(call.headers.get("content-type"), "text/calendar; charset=utf-8");
	const built = ical.parseCalendar(call.body).components[0]!;
	assert.equal(built.uid, result.uid); assert.equal(built.summary, "合成,标题;一\n二");
	assert.equal(built.description, "描述,\n下一行"); assert.equal(built.location, "会议室;甲");
	assert.equal(built.alarms.length, 1); assert.equal(prop(call.body, "RRULE")?.value, "FREQ=DAILY;COUNT=3");
	assert.equal(prop(call.body, "DTSTART")?.parameters.TZID?.[0], "Asia/Shanghai");
	assert.equal(prop(call.body, "DTSTART")?.value, "20261112T090000");
	assert.equal(prop(call.body, "SEQUENCE")?.value, "0");
	assert.match(prop(call.body, "LAST-MODIFIED")!.value, /^\d{8}T\d{6}Z$/);
	assert.match(prop(call.body, "DTSTAMP")!.value, /^\d{8}T\d{6}Z$/);
	assert.deepEqual(Object.keys(result).sort(), ["account", "etag", "kind", "outcome", "resourceUrl", "uid"]);
});

test("创建待办可无时间，日记必须明确日期；基本 DATE/floating 不绑定主机时区", async () => {
	for (const kind of ["VTODO", "VJOURNAL"] as const) {
		const f = fixture(undefined, identity.etag, null);
		const result = await createCalendar(f.context, { account, collectionUrl, summary: "合成",
			...(kind === "VJOURNAL" ? { date: "20261112" } : { start: "20261112T090000", due: "20261112T100000" }) }, kind);
		assert.equal(result.kind, kind); assert.equal(result.etag, null); assert.equal(f.calls.length, 1);
		const start = prop(f.calls[0]!.body, "DTSTART")!;
		assert.equal(start.parameters.TZID, undefined);
		assert.equal(start.parameters.VALUE?.[0], kind === "VJOURNAL" ? "DATE" : undefined);
	}
	const f = fixture();
	await createCalendar(f.context, { account, collectionUrl, summary: "无时间待办" }, "VTODO");
	assert.equal(prop(f.calls[0]!.body, "DTSTART"), undefined);
	for (const [kind, fields] of [["VJOURNAL", {}], ["VEVENT", {}], ["VEVENT", { start: "2026-11-12T00:00:00Z" }],
		["VEVENT", { start: { value: "20261112T090000", tzid: "PRIVATE" } }]] as const) {
		const invalid = fixture();
		await assert.rejects(createCalendar(invalid.context, { account, collectionUrl, summary: "合成", ...fields }, kind), assertCode("INVALID_INPUT"));
		assert.equal(invalid.calls.length, 0);
	}
});

test("高级属性、便捷字段、显式删除冲突及受管元数据均在写入前拒绝", async () => {
	for (const properties of [["SUMMARY:冲突"], ["DTSTART:20260101T100000Z"], ["LAST-MODIFIED:20260101T000000Z"],
		["x.dtstamp:20260101T000000Z"], ["SEQUENCE:99"], ["VERSION:1.0"], ["UID:caller"], ["RRULE:FREQ=DAILY"],
		["X-KEEP:SECRET\r\nSEQUENCE:99"]]) {
		const f = fixture();
		await assert.rejects(createCalendar(f.context, { account, collectionUrl, summary: "合成", start: "20260101T090000Z",
			rrule: "FREQ=DAILY;COUNT=2", properties }, "VEVENT"), assertCode("INVALID_INPUT"));
		assert.equal(f.calls.length, 0);
	}
	for (const fields of [{ summary: null, properties: ["SUMMARY:冲突"] }, { start: null, removeProperties: ["DTSTART"] },
		{ rrule: null, properties: ["RRULE:FREQ=DAILY"] }, { properties: ["X-KEEP:x"], removeProperties: ["x-keep"] },
		{ properties: ["DTSTAMP:20260101T000000Z"] }, { removeProperties: ["LAST-MODIFIED"] },
		{ removeProperties: ["SEQUENCE"] }, { properties: ["RECURRENCE-ID:20260101T090000Z"] }]) {
		const f = fixture();
		await assert.rejects(updateCalendar(f.context, { ...identity, ...fields }, "VEVENT"), assertCode("INVALID_INPUT"));
		assert.equal(f.calls.length, 0);
	}
});

test("旧强 ETag 是 GET 与条件 PUT 的门槛，冲突不得换用新版本或重试", async () => {
	for (const current of ['"changed"', null, 'W/"v1"']) {
		const f = fixture(simple(), current);
		await assert.rejects(updateCalendar(f.context, { ...identity, summary: "新" }, "VEVENT"), assertCode("CONFLICT"));
		assert.deepEqual(f.calls.map(call => call.method), ["GET"]);
	}
	for (const etag of ['W/"v1"', "*", '"v1", "v2"', "", '"v1"\n']) {
		const f = fixture();
		await assert.rejects(updateCalendar(f.context, { ...identity, etag, summary: "新" }, "VEVENT"), assertCode("INVALID_INPUT"));
		assert.equal(f.calls.length, 0);
	}
	const f = fixture(simple(), identity.etag, null, 412);
	await assert.rejects(updateCalendar(f.context, { ...identity, summary: "新" }, "VEVENT"), DavConflictError);
	assert.deepEqual(f.calls.map(call => call.method), ["GET", "PUT"]);
	assert.equal(f.calls[1]!.headers.get("if-match"), identity.etag);
});

test("no-op 保留原文、旧元数据和提醒；properties:[] 不清空，也不 PUT", async () => {
	const raw = calendar(event("DTSTART;TZID=Asia/Shanghai;X-KEEP=yes:20261112T090000", "SUMMARY;LANGUAGE=zh:原文",
		"SEQUENCE:3", "LAST-MODIFIED:20260101T000000Z", "X-KEEP:opaque", alarm.trimEnd()));
	const f = fixture(raw);
	const result = await updateCalendar(f.context, { ...identity, summary: "原文", start: "20261112T090000", properties: [] }, "VEVENT");
	assert.deepEqual(result, { ...identity, kind: "VEVENT", outcome: "unchanged" });
	assert.deepEqual(f.calls.map(call => call.method), ["GET"]);
});

test("实际更新保留其他属性参数，刷新修订元数据且成功后不回读", async () => {
	const raw = calendar(event("DTSTART;TZID=Asia/Shanghai;X-KEEP=yes:20261112T090000", "DURATION:PT1H", "SUMMARY:原文",
		"DESCRIPTION:删除", "LOCATION:删除", "STATUS:CONFIRMED", "SEQUENCE:3", "RRULE:FREQ=DAILY;COUNT=2", "X-KEEP:opaque"));
	const f = fixture(raw, identity.etag, null);
	const result = await updateCalendar(f.context, { ...identity, start: { value: "20261113T020000Z" }, description: null,
		location: null, status: null, rrule: null, properties: ["X-EDIT:新增"] }, "VEVENT");
	assert.equal(result.outcome, "updated"); assert.equal(result.etag, null);
	assert.deepEqual(f.calls.map(call => call.method), ["GET", "PUT"]);
	const data = f.calls[1]!.body;
	assert.equal(f.calls[1]!.headers.get("if-match"), identity.etag);
	assert.equal(prop(data, "DTSTART")?.value, "20261113T100000");
	assert.deepEqual(prop(data, "DTSTART")?.parameters, { TZID: ["Asia/Shanghai"], "X-KEEP": ["yes"] });
	assert.equal(prop(data, "X-KEEP")?.value, "opaque"); assert.equal(prop(data, "X-EDIT")?.value, "新增");
	for (const name of ["DESCRIPTION", "LOCATION", "STATUS", "RRULE"]) assert.equal(prop(data, name), undefined);
	assert.equal(prop(data, "SEQUENCE")?.value, "4");
	assert.notEqual(prop(data, "DTSTAMP")?.value, "20260101T000000Z");
	assert.equal(prop(data, "LAST-MODIFIED")?.value, prop(data, "DTSTAMP")?.value);
});

test("RRULE 可用便捷值或完整属性明确编辑，显式 removeProperties 删除而空列表保留", async () => {
	const raw = calendar(event("DTSTART:20261112T090000Z", "RRULE:FREQ=DAILY;COUNT=2", "X-KEEP:opaque"));
	for (const fields of [{ rrule: "FREQ=WEEKLY;COUNT=3" }, { properties: ["RRULE:FREQ=WEEKLY;COUNT=3"] }]) {
		const f = fixture(raw);
		await updateCalendar(f.context, { ...identity, ...fields }, "VEVENT");
		assert.equal(prop(f.calls[1]!.body, "RRULE")?.value, "FREQ=WEEKLY;COUNT=3");
		assert.equal(prop(f.calls[1]!.body, "X-KEEP")?.value, "opaque");
	}
	const f = fixture(raw);
	await updateCalendar(f.context, { ...identity, removeProperties: ["rrule", "X-KEEP"] }, "VEVENT");
	assert.equal(prop(f.calls[1]!.body, "RRULE"), undefined); assert.equal(prop(f.calls[1]!.body, "X-KEEP"), undefined);
	const unchanged = fixture(raw);
	assert.equal((await updateCalendar(unchanged.context, { ...identity, rrule: "FREQ=DAILY;COUNT=2" }, "VEVENT")).outcome, "unchanged");
	assert.equal(unchanged.calls.length, 1);
});

test("待办 due 与日记 date 使用公开保留式编辑，省略时间保留；提醒清空与删除明确区分", async () => {
	const todo = calendar(component("VTODO", "UID:series", stamp, "DTSTART:20261112T090000Z", "DUE:20261112T100000Z", alarm.trimEnd()));
	const f = fixture(todo);
	await updateCalendar(f.context, { ...identity, start: null, alarms: [], due: "20261112T110000Z" }, "VTODO");
	const data = f.calls[1]!.body;
	assert.equal(prop(data, "DTSTART"), undefined); assert.equal(prop(data, "DUE")?.value, "20261112T110000Z");
	assert.equal(ical.parseCalendar(data).components[0]!.alarms.length, 0); assert.equal(prop(data, "SEQUENCE")?.value, "1");
	const journal = fixture(calendar(component("VJOURNAL", "UID:series", stamp, "DTSTART;VALUE=DATE;X-KEEP=yes:20261112")));
	await updateCalendar(journal.context, { ...identity, date: "20261113" }, "VJOURNAL");
	assert.equal(prop(journal.calls[1]!.body, "DTSTART")?.value, "20261113");
	assert.deepEqual(prop(journal.calls[1]!.body, "DTSTART")?.parameters, { VALUE: ["DATE"], "X-KEEP": ["yes"] });
	const retained = fixture(todo);
	await updateCalendar(retained.context, { ...identity, summary: "新" }, "VTODO");
	assert.equal(ical.parseCalendar(retained.calls[1]!.body).components[0]!.alarms.length, 1);
	const dependency = fixture(todo);
	await assert.rejects(updateCalendar(dependency.context, { ...identity, start: null }, "VTODO"), assertCode("INVALID_INPUT"));
	assert.equal(dependency.calls.length, 1);
});

test("例外只按完整逻辑行精确更新，未选主件和其他组件原文保留", async () => {
	const recurrenceId = "RECURRENCE-ID;TZID=Asia/Shanghai:20261113T090000";
	const raw = calendar(event("DTSTART;TZID=Asia/Shanghai:20261112T090000", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:主件"),
		event(recurrenceId, "DTSTART;TZID=Asia/Shanghai:20261113T100000", "SUMMARY:例外", "SEQUENCE:4"),
		component("VTODO", "UID:other", stamp, "SUMMARY:不动"));
	const f = fixture(raw);
	await updateCalendar(f.context, { ...identity, recurrenceId, summary: "修改例外" }, "VEVENT");
	const before = ical.parseCalendar(raw).components, after = ical.parseCalendar(f.calls[1]!.body).components;
	assert.equal(after[0]!.raw, before[0]!.raw); assert.equal(after[2]!.raw, before[2]!.raw);
	assert.equal(after[1]!.summary, "修改例外"); assert.equal(after[1]!.recurrenceId, recurrenceId);
	assert.equal(prop(f.calls[1]!.body, "SEQUENCE", recurrenceId)?.value, "5");
	const bare = fixture(raw);
	await assert.rejects(updateCalendar(bare.context, { ...identity, recurrenceId: "20261113T090000", summary: "不动" }, "VEVENT"), assertCode("INVALID_INPUT"));
	assert.equal(bare.calls.length, 0);
});

test("坏源、目标歧义、RANGE、缺目标和无效修订序列拒绝写入", async () => {
	const recurrenceId = "RECURRENCE-ID:20261113T090000Z";
	for (const [raw, fields, code] of [
		["PRIVATE SECRET invalid", {}, "DATA_INVALID"],
		[calendar(event("DTSTART:20261112T090000Z"), event("DTSTART:20261112T090000Z")), {}, "AMBIGUOUS_TARGET"],
		[calendar(event(recurrenceId, "DTSTART:20261113T100000Z"), event(recurrenceId, "DTSTART:20261113T110000Z")), { recurrenceId }, "AMBIGUOUS_TARGET"],
		[calendar(event("RECURRENCE-ID;RANGE=THISANDFUTURE:20261113T090000Z", "DTSTART:20261113T100000Z")),
			{ recurrenceId: "RECURRENCE-ID;RANGE=THISANDFUTURE:20261113T090000Z" }, "RECURRENCE_UNSUPPORTED"],
		[calendar(event(recurrenceId, "DTSTART:20261113T100000Z")), {}, "NOT_FOUND"],
		[simple(), { uid: "missing" }, "NOT_FOUND"],
		[calendar(event("DTSTART:20261112T090000Z", `SEQUENCE:${Number.MAX_SAFE_INTEGER}`)), {}, "DATA_INVALID"],
	] as const) {
		const f = fixture(raw);
		await assert.rejects(updateCalendar(f.context, { ...identity, ...fields, summary: "新" }, "VEVENT"), assertCode(code));
		assert.deepEqual(f.calls.map(call => call.method), ["GET"]);
	}
});

test("整资源删除接受同 kind/UID 系列，用旧 ETag 且不回读；混合、未知或歧义拒绝", async () => {
	const master = event("DTSTART:20261112T090000Z"), detached = event("RECURRENCE-ID:20261113T090000Z", "DTSTART:20261113T100000Z");
	for (const kind of ["VEVENT", "VTODO", "VJOURNAL"] as const) {
		const f = fixture(kind === "VEVENT" ? calendar(master, detached) : calendar(component(kind, "UID:series", stamp)));
		const result = await deleteCalendar(f.context, identity, kind);
		assert.deepEqual(result, { ...identity, kind, outcome: "deleted" });
		assert.deepEqual(f.calls.map(call => call.method), ["GET", "DELETE"]);
		assert.equal(f.calls[1]!.headers.get("if-match"), identity.etag);
	}
	for (const raw of [calendar(master, component("VTODO", "UID:series", stamp)),
		calendar(master, component("VEVENT", "UID:other", stamp, "DTSTART:20261112T090000Z")),
		calendar(master, component("X-UNKNOWN", "X-SECRET:PRIVATE")), calendar(master, master),
		calendar(master, detached, detached)]) {
		const f = fixture(raw);
		await assert.rejects(deleteCalendar(f.context, identity, "VEVENT"), assertCode("DATA_INVALID"));
		assert.deepEqual(f.calls.map(call => call.method), ["GET"]);
	}
	const conflict = fixture(simple(), '"new"');
	await assert.rejects(deleteCalendar(conflict.context, identity, "VEVENT"), assertCode("CONFLICT"));
	assert.deepEqual(conflict.calls.map(call => call.method), ["GET"]);
});
