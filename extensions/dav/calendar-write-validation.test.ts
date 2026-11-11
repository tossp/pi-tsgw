import assert from "node:assert/strict";
import { test } from "node:test";
import { DavClient } from "davkit/dav";
import * as ical from "davkit/ical";
import * as vcard from "davkit/vcard";
import { createCalendar, deleteCalendar, updateCalendar } from "./calendar-write.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = "fixture", collectionUrl = "https://dav.example.invalid/calendar/";
const identity = { account, resourceUrl: collectionUrl + "old.ics", uid: "series", etag: '"v1"' };
const stamp = "DTSTAMP:20260101T000000Z";
const component = (kind: string, ...lines: string[]) => [`BEGIN:${kind}`, ...lines, `END:${kind}`].join("\r\n");
const calendar = (...children: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//合成测试//ZH", ...children, "END:VCALENDAR", ""].join("\r\n");
const event = (...lines: string[]) => component("VEVENT", "UID:series", stamp, "DTSTART:20261112T090000Z", "SUMMARY:原文", ...lines);
const alarm = component("VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "DESCRIPTION:提醒");

/** 使用真实公开库，仅记录校验输入与模拟 HTTP；不加载个人配置。 */
function fixture(raw = calendar(event())) {
	const calls: { method: string; body: string; headers: Headers }[] = [];
	const checks: string[] = [];
	const edits: string[] = [];
	const client = new DavClient({ baseUrl: collectionUrl, fetch: async (_url, init) => {
		const method = init?.method ?? "GET";
		calls.push({ method, body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
		return method === "GET" ? new Response(raw, { headers: { ETag: identity.etag } })
			: new Response(null, { status: 204, headers: { ETag: '"v2"' } });
	} });
	const context: DavReadContext = { client, vcard, ical: { ...ical,
		validateCalendarResource(data) { checks.push(data); return ical.validateCalendarResource(data); },
		updateCalendarComponent(data, target, edit) { edits.push(data); return ical.updateCalendarComponent(data, target, edit); },
	} };
	return { context, calls, checks, edits };
}
function failure(code: string, stage: string, expectedIssues?: ical.ContentValidationResult["issues"]) {
	return (error: unknown) => {
		assert.ok(error instanceof DavToolError);
		assert.equal(error.code, code);
		assert.equal(error.details?.stage, stage);
		assert.equal(error.details?.account, account);
		assert.equal(error.details?.kind, "VEVENT");
		if (expectedIssues) assert.deepEqual(error.details?.issues, expectedIssues);
		assert.doesNotMatch(JSON.stringify({ message: error.message, details: error.details }), /PRIVATE|SECRET|BEGIN:VCALENDAR|rawValue/);
		return true;
	};
}
const methods = (f: ReturnType<typeof fixture>) => f.calls.map(call => call.method);

for (const [name, fields] of [
	["错误 RRULE", { rrule: "FREQ=PRIVATE" }],
	["根属性放错位置", { properties: ["CALSCALE:GREGORIAN"] }],
	["已知但不支持的语义", { properties: ["CLASS:X-PRIVATE"] }],
] as [string, { rrule?: string; properties?: string[] }][]) {
	test(`创建${name}：最终真实候选不合规时零 PUT`, async () => {
		const f = fixture();
		await assert.rejects(createCalendar(f.context, { account, collectionUrl, summary: "合成",
			start: "20261112T090000Z", ...fields }, "VEVENT"), failure("CONTENT_VALIDATION_FAILED", "final"));
		assert.deepEqual(methods(f), []);
		assert.equal(f.checks.length, 1);
		assert.equal(ical.validateCalendarResource(f.checks[0]!).valid, false);
		const built = ical.parseCalendar(f.checks[0]!).components[0]!;
		for (const name of ["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"]) assert.ok(built.properties.some(p => p.name === name));
	});
}

for (const [name, raw, category] of [
	["错误 RRULE", calendar(event("RRULE:FREQ=PRIVATE")), "invalid"],
	["缺失根 PRODID", calendar(event()).replace("PRODID:-//合成测试//ZH\r\n", ""), "invalid"],
	["错误根 VERSION", calendar(event()).replace("VERSION:2.0", "VERSION:1.0"), "invalid"],
	["既有提醒缺描述", calendar(event(component("VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M"))), "invalid"],
	["既有时区结构", calendar(component("VTIMEZONE", "TZID:Asia/Shanghai"), event()), "invalid"],
	["未知时区", calendar(event()).replace("DTSTART:20261112T090000Z", "DTSTART;TZID=PRIVATE:20261112T090000"), "unsupported"],
	["兄弟组件 RRULE", calendar(event(), component("VTODO", "UID:other", stamp, "DTSTART:20261112T090000Z", "RRULE:FREQ=PRIVATE")), "invalid"],
	["无法验证的 CLASS", calendar(event("CLASS:X-PRIVATE")), "unsupported"],
	["未知兄弟组件", calendar(event(), component("X-PRIVATE", "X-NOTE:SECRET")), "unsupported"],
] as const) {
	for (const changed of [false, true]) {
		test(`${name}：${changed ? "改标题" : "no-op"}不能跳过整份最终校验`, async () => {
			const f = fixture(raw);
			const issues = ical.validateCalendarResource(raw).issues;
			assert.ok(issues.some(issue => issue.category === category));
			await assert.rejects(updateCalendar(f.context, { ...identity, ...(changed ? { summary: "新" } : {}) }, "VEVENT"),
				failure("CONTENT_VALIDATION_FAILED", "final"));
			assert.deepEqual(methods(f), ["GET"]);
			assert.equal(f.checks.length, 2);
			assert.equal(f.checks[0], raw);
			if (!changed) { assert.equal(f.checks[1], raw); assert.equal(f.edits.length, 1); }
			else assert.equal(f.edits.length, 2);
		});
	}
}

for (const [name, raw] of [
	["非法 DTSTAMP", calendar(event()).replace(stamp, "DTSTAMP:PRIVATE")],
	["重复 DTSTAMP", calendar(event(stamp))],
	["缺少必需 DTSTAMP", calendar(event()).replace(stamp + "\r\n", "")],
	["非法 LAST-MODIFIED", calendar(event("LAST-MODIFIED:PRIVATE"))],
	["重复 LAST-MODIFIED", calendar(event("LAST-MODIFIED:20260101T000000Z", "LAST-MODIFIED:20260101T000000Z"))],
	["负数 SEQUENCE", calendar(event("SEQUENCE:-1"))],
	["重复 SEQUENCE", calendar(event("SEQUENCE:3", "SEQUENCE:3"))],
	["错误 SEQUENCE 类型", calendar(event("SEQUENCE;VALUE=TEXT:3"))],
	["无法确认 SEQUENCE 编码", calendar(event("SEQUENCE;ENCODING=BASE64:Mw=="))],
	["RRULE 和 SEQUENCE 同时错误", calendar(event("RRULE:FREQ=PRIVATE", "SEQUENCE:SECRET"))],
]) {
	test(`${name}：标题修改及 no-op 均不能自动覆盖，且早于编辑拒绝`, async () => {
		const issues = ical.validateCalendarResource(raw).issues.filter(issue =>
			issue.property !== undefined && ["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"].includes(issue.property));
		assert.ok(issues.length);
		for (const fields of [{}, { summary: "新" }]) {
			const f = fixture(raw);
			await assert.rejects(updateCalendar(f.context, { ...identity, ...fields }, "VEVENT"),
				failure("REPAIR_UNSUPPORTED", "source", issues));
			assert.deepEqual(methods(f), ["GET"]);
			assert.deepEqual(f.checks, [raw]);
			assert.deepEqual(f.edits, []);
		}
	});
}

test("结构或身份无法可靠解析时停在 source，不把缺诊断视为元数据合法", async () => {
	for (const raw of ["PRIVATE SECRET", calendar(event()).replace("END:VEVENT", "END:VTODO"),
		calendar(event()).replace("UID:series", "UID:series\r\nUID:other")]) {
		const f = fixture(raw), validation = ical.validateCalendarResource(raw);
		await assert.rejects(updateCalendar(f.context, { ...identity, summary: "新" }, "VEVENT"),
			failure("REPAIR_UNSUPPORTED", "source", validation.issues));
		assert.deepEqual(methods(f), ["GET"]); assert.deepEqual(f.edits, []);
		assert.deepEqual(f.checks, [raw]);
	}
});

test("旧编辑器被兄弟组件错误阻塞时报告 edit 阶段源诊断，而非谎称已跑 final", async () => {
	const raw = calendar(event("STATUS:PRIVATE"), component("VTODO", "UID:other", stamp, "STATUS:PRIVATE"));
	const f = fixture(raw), issues = ical.validateCalendarResource(raw).issues;
	await assert.rejects(updateCalendar(f.context, { ...identity, status: "CONFIRMED" }, "VEVENT"),
		failure("REPAIR_UNSUPPORTED", "edit", issues));
	assert.deepEqual(methods(f), ["GET"]);
	assert.deepEqual(f.checks, [raw]); assert.equal(f.edits.length, 1);
	const input = fixture();
	await assert.rejects(updateCalendar(input.context, { ...identity, end: { value: "20261112T080000Z" } }, "VEVENT"),
		failure("INVALID_INPUT", "edit"));
	assert.deepEqual(methods(input), ["GET"]); assert.equal(input.checks.length, 1);
});

test("明确修正同一组件多个问题可以发送；源非 valid 不作为编辑前置", async () => {
	const sibling = component("VTODO", "UID:other", stamp, "SUMMARY:保留");
	const raw = calendar(event("DTEND:20261112T080000Z", "STATUS:PRIVATE", "RRULE:FREQ=PRIVATE", alarm), sibling);
	assert.equal(ical.validateCalendarResource(raw).valid, false);
	const f = fixture(raw);
	const result = await updateCalendar(f.context, { ...identity, summary: "修正", status: "CONFIRMED",
		end: { value: "20261112T100000Z" }, rrule: "FREQ=DAILY;COUNT=2" }, "VEVENT");
	assert.equal(result.outcome, "updated"); assert.deepEqual(methods(f), ["GET", "PUT"]);
	const put = f.calls[1]!;
	assert.equal(put.headers.get("if-match"), identity.etag);
	assert.equal(f.checks.at(-1), put.body);
	assert.equal(f.checks.length, 2);
	assert.deepEqual(ical.validateCalendarResource(put.body), { valid: true, issues: [] });
	const [edited, kept] = ical.parseCalendar(put.body).components;
	assert.equal(edited!.summary, "修正"); assert.equal(kept!.raw, ical.parseCalendar(raw).components[1]!.raw);
	assert.equal(edited!.properties.find(p => p.name === "SEQUENCE")?.value, "1");
	const dtstamp = edited!.properties.find(p => p.name === "DTSTAMP")?.value;
	assert.notEqual(dtstamp, "20260101T000000Z");
	assert.equal(edited!.properties.find(p => p.name === "LAST-MODIFIED")?.value, dtstamp);
});

test("最后校验的是修订后正文：合法源 SEQUENCE 递增后越界也不能 PUT", async () => {
	const raw = calendar(event("SEQUENCE:2147483647"));
	assert.equal(ical.validateCalendarResource(raw).valid, true);
	const f = fixture(raw);
	await assert.rejects(updateCalendar(f.context, { ...identity, summary: "新" }, "VEVENT"),
		failure("CONTENT_VALIDATION_FAILED", "final"));
	assert.deepEqual(methods(f), ["GET"]); assert.equal(f.checks.length, 2);
	assert.match(f.checks[1]!, /SEQUENCE:2147483648/);
	const unchanged = fixture(raw);
	assert.equal((await updateCalendar(unchanged.context, identity, "VEVENT")).outcome, "unchanged");
	assert.deepEqual(unchanged.checks, [raw, raw]);
});

test("合法缺省可初始化，有效 no-op 不刷新，创建和更新均校验实际发送文本", async () => {
	const raw = calendar(event(alarm));
	const noop = fixture(raw);
	assert.equal((await updateCalendar(noop.context, { ...identity, summary: "原文" }, "VEVENT")).outcome, "unchanged");
	assert.deepEqual(methods(noop), ["GET"]); assert.deepEqual(noop.checks, [raw, raw]);
	const update = fixture(raw);
	await updateCalendar(update.context, { ...identity, summary: "新" }, "VEVENT");
	assert.equal(update.checks.at(-1), update.calls[1]!.body);
	assert.deepEqual(ical.validateCalendarResource(update.calls[1]!.body), { valid: true, issues: [] });
	const create = fixture();
	await createCalendar(create.context, { account, collectionUrl, summary: "合成", start: "20261112T090000Z", alarms: [alarm] }, "VEVENT");
	assert.deepEqual(methods(create), ["PUT"]); assert.deepEqual(create.checks, [create.calls[0]!.body]);
	assert.deepEqual(ical.validateCalendarResource(create.calls[0]!.body), { valid: true, issues: [] });
});

test("待办和日记同样拒绝非法受管字段，合法 no-op 不刷新", async () => {
	for (const kind of ["VTODO", "VJOURNAL"] as const) {
		const raw = calendar(component(kind, "UID:series", stamp, "SUMMARY:原文"));
		const valid = fixture(raw);
		assert.equal((await updateCalendar(valid.context, { ...identity, summary: "原文" }, kind)).outcome, "unchanged");
		assert.deepEqual(methods(valid), ["GET"]); assert.deepEqual(valid.checks, [raw, raw]);
		for (const fields of [{}, { summary: "新" }]) {
			const invalid = fixture(raw.replace(stamp, "DTSTAMP:PRIVATE"));
			await assert.rejects(updateCalendar(invalid.context, { ...identity, ...fields }, kind), (error: unknown) => {
				assert.ok(error instanceof DavToolError); assert.equal(error.code, "REPAIR_UNSUPPORTED");
				assert.equal(error.details?.stage, "source"); assert.equal(error.details?.kind, kind);
				return true;
			});
			assert.deepEqual(methods(invalid), ["GET"]); assert.deepEqual(invalid.edits, []);
		}
	}
});

test("强 ETag 和输入冲突仍先拒绝；DELETE 不新增正文合规门槛", async () => {
	const raw = calendar(event("RRULE:FREQ=PRIVATE"));
	const conflict = fixture(raw);
	await assert.rejects(updateCalendar(conflict.context, { ...identity, etag: '"old"' }, "VEVENT"),
		(error: unknown) => error instanceof DavToolError && error.code === "CONFLICT");
	assert.deepEqual(methods(conflict), ["GET"]); assert.deepEqual(conflict.checks, []);
	const input = fixture(raw);
	await assert.rejects(updateCalendar(input.context, { ...identity, summary: "新", properties: ["SUMMARY:冲突"] }, "VEVENT"),
		(error: unknown) => error instanceof DavToolError && error.code === "INVALID_INPUT");
	assert.deepEqual(methods(input), []); assert.deepEqual(input.checks, []);
	for (const invalid of [raw.replace("PRODID:-//合成测试//ZH\r\n", ""),
		raw.replace(stamp, "DTSTAMP:PRIVATE"), calendar(event("SEQUENCE:SECRET"))]) {
		assert.equal(ical.validateCalendarResource(invalid).valid, false);
		const deletion = fixture(invalid);
		assert.equal((await deleteCalendar(deletion.context, identity, "VEVENT")).outcome, "deleted");
		assert.deepEqual(methods(deletion), ["GET", "DELETE"]); assert.deepEqual(deletion.checks, []);
		assert.equal(deletion.calls[1]!.headers.get("if-match"), identity.etag);
	}
});

for (const kind of ["VEVENT", "VTODO", "VJOURNAL"] as const) {
	test(`${kind} 显式修复与业务修改合并，修订后校验实际正文且保留其它组件`, async () => {
		const fields = kind === "VEVENT"
			? ["DTSTART;VALUE=DATE:20261112", "DTEND;VALUE=DATE:20261113", "RRULE:FREQ=DAILY;UNTIL=20261212T000000"]
			: ["DTSTART:20261112T090000Z"];
		const source = component(kind, "UID:series", "DTSTAMP:20260101T090000", "LAST-MODIFIED:20260101T090000",
			"CREATED:20260101T090000", "SEQUENCE;VALUE=TEXT:3", "SUMMARY:原文", "STATUS:PRIVATE",
			"X-KEEP;X-P=unchanged:保留", ...fields, ...(kind === "VJOURNAL" ? [] : [alarm]));
		const sibling = component("VTODO", "UID:other", stamp, "SUMMARY:保留兄弟");
		const raw = calendar(source, sibling), f = fixture(raw);
		const result = await updateCalendar(f.context, { ...identity, summary: "修复后的名称",
			status: kind === "VEVENT" ? "CONFIRMED" : kind === "VTODO" ? "NEEDS-ACTION" : "DRAFT",
			...(kind === "VEVENT" ? { rrule: "FREQ=DAILY;UNTIL=20261212" } : {}),
			properties: ["CREATED:20260101T010000Z"],
			revisionRepair: { dtstamp: "20260101T010000Z", lastModified: "20260101T010000Z", sequence: 7 },
		}, kind);
		assert.equal(result.outcome, "updated"); assert.deepEqual(methods(f), ["GET", "PUT"]);
		const put = f.calls[1]!;
		assert.equal(put.headers.get("if-match"), identity.etag);
		assert.equal(f.checks.at(-1), put.body);
		assert.equal(ical.validateCalendarResource(put.body).valid, true);
		const [changed, kept] = ical.parseCalendar(put.body).components;
		assert.equal(kept!.raw, ical.parseCalendar(raw).components[1]!.raw);
		assert.equal(changed!.properties.find(p => p.name === "SEQUENCE")?.value, "8");
		assert.equal(changed!.properties.find(p => p.name === "CREATED")?.value, "20260101T010000Z");
		const currentStamp = changed!.properties.find(p => p.name === "DTSTAMP")?.value;
		assert.match(currentStamp!, /^\d{8}T\d{6}Z$/);
		assert.notEqual(currentStamp, "20260101T010000Z");
		assert.equal(changed!.properties.find(p => p.name === "LAST-MODIFIED")?.value, currentStamp);
		assert.ok(put.body.includes("X-KEEP;X-P=unchanged:保留"));
		assert.deepEqual(changed!.alarms.map(item => item.raw), ical.parseCalendar(raw).components[0]!.alarms.map(item => item.raw));
	});
}

test("重复修订字段可明确整组替换或丢弃，源删除不阻止正常生成本次修订", async () => {
	const f = fixture(calendar(event(stamp, "LAST-MODIFIED:20200101T000000Z", "LAST-MODIFIED:20210101T000000Z",
		"SEQUENCE:3", "SEQUENCE:8")));
	await updateCalendar(f.context, { ...identity,
		revisionRepair: { dtstamp: "20260101T000000Z", lastModified: null, sequence: null } }, "VEVENT");
	assert.deepEqual(methods(f), ["GET", "PUT"]);
	const beforeRefresh = ical.parseCalendar(f.edits[1]!).components[0]!;
	assert.equal(beforeRefresh.properties.filter(p => p.name === "DTSTAMP").length, 1);
	assert.ok(!beforeRefresh.properties.some(p => ["LAST-MODIFIED", "SEQUENCE"].includes(p.name)));
	const changed = ical.parseCalendar(f.calls[1]!.body).components[0]!;
	assert.equal(changed.properties.filter(p => p.name === "DTSTAMP").length, 1);
	assert.equal(changed.properties.filter(p => p.name === "LAST-MODIFIED").length, 1);
	assert.equal(changed.properties.find(p => p.name === "SEQUENCE")?.value, "1");
	assert.equal(ical.validateCalendarResource(f.calls[1]!.body).valid, true);
});

test("缺失必需时间戳及旧编码只能用明确修复值解决，不能静默补齐", async () => {
	for (const raw of [calendar(event()).replace(stamp + "\r\n", ""),
		calendar(event()).replace(stamp, "DTSTAMP;ENCODING=QUOTED-PRINTABLE:20260101T000000Z")]) {
		const f = fixture(raw);
		await updateCalendar(f.context, { ...identity, revisionRepair: { dtstamp: "20260101T000000Z" } }, "VEVENT");
		assert.deepEqual(methods(f), ["GET", "PUT"]);
		assert.equal(ical.validateCalendarResource(f.calls[1]!.body).valid, true);
		assert.doesNotMatch(f.calls[1]!.body, /ENCODING=QUOTED-PRINTABLE/);
	}
});

test("不能借显式修复任意改写合法修订历史，且修复值仍须合规", async () => {
	const clean = fixture(calendar(event("SEQUENCE:1")));
	await assert.rejects(updateCalendar(clean.context, { ...identity, revisionRepair: { sequence: 7 } }, "VEVENT"),
		failure("INVALID_INPUT", "repair"));
	assert.deepEqual(methods(clean), ["GET"]); assert.deepEqual(clean.edits, []);
	const bad = fixture(calendar(event("SEQUENCE;ENCODING=QUOTED-PRINTABLE:3")));
	await assert.rejects(updateCalendar(bad.context, { ...identity, revisionRepair: { sequence: -1 } }, "VEVENT"),
		(error: unknown) => error instanceof DavToolError && error.code === "REPAIR_UNSUPPORTED");
	assert.deepEqual(methods(bad), ["GET"]);
	const incomplete = fixture(calendar(event("LAST-MODIFIED;ENCODING=QUOTED-PRINTABLE:20260101T000000Z",
		"SEQUENCE;ENCODING=QUOTED-PRINTABLE:3")));
	await assert.rejects(updateCalendar(incomplete.context, { ...identity, revisionRepair: { sequence: 3 } }, "VEVENT"),
		failure("REPAIR_UNSUPPORTED", "repair"));
	assert.deepEqual(methods(incomplete), ["GET"]); assert.equal(incomplete.edits.length, 1);
});

test("兄弟同名诊断不能代替目标修复证明，VTIMEZONE 不参与目标数组下标推断", async () => {
	const timezone = component("VTIMEZONE", "TZID:Asia/Shanghai", component("STANDARD", "DTSTART:19700101T000000",
		"TZOFFSETFROM:+0800", "TZOFFSETTO:+0800"));
	const primary = event("SEQUENCE:1");
	const other = component("VEVENT", "UID:other", stamp, "DTSTART:20261112T090000Z",
		"SEQUENCE;ENCODING=QUOTED-PRINTABLE:3");
	const raw = calendar(timezone, primary, other);
	const wrong = fixture(raw);
	await assert.rejects(updateCalendar(wrong.context, { ...identity, revisionRepair: { sequence: 7 } }, "VEVENT"),
		failure("INVALID_INPUT", "repair"));
	assert.deepEqual(methods(wrong), ["GET"]); assert.deepEqual(wrong.edits, []);
	const correct = fixture(raw);
	await updateCalendar(correct.context, { ...identity, uid: "other", revisionRepair: { sequence: 3 } }, "VEVENT");
	assert.deepEqual(methods(correct), ["GET", "PUT"]);
	const changed = ical.parseCalendar(correct.calls[1]!.body);
	assert.equal(changed.components[0]!.raw, ical.parseCalendar(raw).components[0]!.raw);
	assert.equal(changed.timezones[0], ical.parseCalendar(raw).timezones[0]);
	assert.equal(changed.components[1]!.properties.find(p => p.name === "SEQUENCE")?.value, "4");
});

test("无关嵌套提醒的同名异常不能授权改写目标合法 SEQUENCE，且零 PUT", async () => {
	const raw = calendar(event("SEQUENCE:5", component("VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M",
		"DESCRIPTION:待删除提醒", "SEQUENCE:-1")));
	const sourceValidation = ical.validateCalendarResource(raw);
	assert.ok(sourceValidation.issues.some(issue => issue.property === "SEQUENCE" && issue.componentPath.length === 2));
	assert.ok(!sourceValidation.issues.some(issue => issue.property === "SEQUENCE" && issue.componentPath.length === 1));
	const f = fixture(raw);
	await assert.rejects(updateCalendar(f.context, { ...identity, alarms: [], revisionRepair: { sequence: 100 } }, "VEVENT"),
		failure("INVALID_INPUT", "repair"));
	assert.deepEqual(methods(f), ["GET"]); assert.deepEqual(f.edits, []);
	assert.equal(ical.parseCalendar(raw).components[0]!.properties.find(property => property.name === "SEQUENCE")?.value, "5");
});

test("前置时区、已有例外、兄弟组件与嵌套提醒下只修复目标直接异常字段", async () => {
	const timezone = component("VTIMEZONE", "TZID:Asia/Shanghai", component("STANDARD", "DTSTART:19700101T000000",
		"TZOFFSETFROM:+0800", "TZOFFSETTO:+0800"));
	const primary = event("RRULE:FREQ=DAILY;COUNT=2", "SEQUENCE:5", alarm);
	const recurrenceId = "RECURRENCE-ID:20261113T090000Z";
	const exception = component("VEVENT", "UID:series", stamp, "SEQUENCE;ENCODING=QUOTED-PRINTABLE:2",
		recurrenceId, "DTSTART:20261113T100000Z", "SUMMARY:已有例外", alarm);
	const sibling = component("VTODO", "UID:other", stamp, "SEQUENCE:1", "SUMMARY:兄弟");
	const raw = calendar(timezone, primary, exception, sibling), before = ical.parseCalendar(raw), f = fixture(raw);
	await updateCalendar(f.context, { ...identity, recurrenceId, revisionRepair: { sequence: 9 } }, "VEVENT");
	assert.deepEqual(methods(f), ["GET", "PUT"]);
	const changed = ical.parseCalendar(f.calls[1]!.body);
	assert.equal(changed.timezones[0], before.timezones[0]);
	assert.equal(changed.components[0]!.raw, before.components[0]!.raw);
	assert.equal(changed.components[2]!.raw, before.components[2]!.raw);
	assert.equal(changed.components[1]!.properties.find(property => property.name === "SEQUENCE")?.value, "10");
	assert.deepEqual(changed.components[1]!.alarms.map(item => item.raw), before.components[1]!.alarms.map(item => item.raw));
	assert.equal(ical.validateCalendarResource(f.calls[1]!.body).valid, true);
});

test("目标直接异常字段有源诊断时，同次删除含同名异常的提醒仍可修复", async () => {
	const raw = calendar(event("SEQUENCE:-1", component("VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M",
		"DESCRIPTION:待删除提醒", "SEQUENCE:-1")));
	const f = fixture(raw);
	await updateCalendar(f.context, { ...identity, alarms: [], revisionRepair: { sequence: 5 } }, "VEVENT");
	assert.deepEqual(methods(f), ["GET", "PUT"]);
	const changed = ical.parseCalendar(f.calls[1]!.body).components[0]!;
	assert.deepEqual(changed.alarms, []);
	assert.equal(changed.properties.find(property => property.name === "SEQUENCE")?.value, "6");
	assert.equal(ical.validateCalendarResource(f.calls[1]!.body).valid, true);
});

test("显式修复不放宽其它最终校验、修订越界或调用方版本", async () => {
	const badRule = fixture(calendar(event("SEQUENCE;ENCODING=QUOTED-PRINTABLE:3", "RRULE:FREQ=PRIVATE")));
	await assert.rejects(updateCalendar(badRule.context, { ...identity, revisionRepair: { sequence: 3 } }, "VEVENT"),
		failure("CONTENT_VALIDATION_FAILED", "final"));
	assert.deepEqual(methods(badRule), ["GET"]);
	const overflow = fixture(calendar(event("SEQUENCE:-1")));
	await assert.rejects(updateCalendar(overflow.context, { ...identity, revisionRepair: { sequence: 2147483647 } }, "VEVENT"),
		failure("CONTENT_VALIDATION_FAILED", "final"));
	assert.deepEqual(methods(overflow), ["GET"]);
	assert.match(overflow.checks.at(-1)!, /SEQUENCE:2147483648/);
	const conflict = fixture(calendar(event("SEQUENCE:-1")));
	await assert.rejects(updateCalendar(conflict.context, { ...identity, etag: '"stale"', revisionRepair: { sequence: 3 } }, "VEVENT"),
		(error: unknown) => error instanceof DavToolError && error.code === "CONFLICT");
	assert.deepEqual(methods(conflict), ["GET"]); assert.deepEqual(conflict.edits, []);
});

test("已有例外可独立修复修订字段，不改主件、发生身份及原提醒", async () => {
	const primary = event("RRULE:FREQ=DAILY;COUNT=2", "SEQUENCE:4", alarm);
	const recurrenceId = "RECURRENCE-ID:20261113T090000Z";
	const exception = component("VEVENT", "UID:series", "DTSTAMP:20260101T090000", "SEQUENCE;ENCODING=QUOTED-PRINTABLE:2",
		recurrenceId, "DTSTART:20261113T100000Z", "SUMMARY:已有例外", alarm);
	const raw = calendar(primary, exception), f = fixture(raw);
	await updateCalendar(f.context, { ...identity, recurrenceId,
		revisionRepair: { dtstamp: "20260101T010000Z", sequence: 2 } }, "VEVENT");
	assert.deepEqual(methods(f), ["GET", "PUT"]);
	const changed = ical.parseCalendar(f.calls[1]!.body);
	assert.equal(changed.components[0]!.raw, ical.parseCalendar(raw).components[0]!.raw);
	assert.equal(changed.components[1]!.recurrenceId, recurrenceId);
	assert.equal(changed.components[1]!.properties.find(p => p.name === "SEQUENCE")?.value, "3");
	assert.deepEqual(changed.components[1]!.alarms.map(item => item.raw), ical.parseCalendar(raw).components[1]!.alarms.map(item => item.raw));
	assert.equal(ical.validateCalendarResource(f.calls[1]!.body).valid, true);
});
