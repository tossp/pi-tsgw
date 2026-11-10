import type { CalendarComponent, CalendarComponentKind, CalendarProperty } from "davkit/ical";
import { DavToolError, type CalendarGetInput, type CalendarListInput, type DavReadContext } from "./types.ts";

function invalidData(): never {
	throw new DavToolError("DATA_INVALID", "日历源数据无效或无法完整解释，未返回部分结果");
}

function parse(context: DavReadContext, raw: string) {
	try { return context.ical.parseCalendar(raw); }
	catch { return invalidData(); }
}

/** 日期是否合法由公开库校验；Date 只转换显式 offset，不丢弃非零毫秒。 */
function windowTime(context: DavReadContext, value: string | undefined): { value: string; instant: number } {
	try {
		if (!value) throw new Error();
		let basic = value;
		if (basic.length !== 16 || !/^\d{8}T\d{6}Z$/.test(basic)) {
			const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.000)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
			if (!iso) throw new Error();
			// Date 会把 2 月 30 日等输入归一化，须先验证原始墙钟字段。
			context.ical.parseCalendarTime(`${iso[1]}${iso[2]}${iso[3]}T${iso[4]}${iso[5]}${iso[6]}`);
			basic = new Date(value).toISOString().replace(/[-:]/g, "").replace(".000", "");
		}
		const time = context.ical.parseCalendarTime(basic);
		if (time.kind !== "utc" || time.epochMilliseconds === null) throw new Error();
		return { value: basic, instant: time.epochMilliseconds };
	} catch {
		throw new DavToolError("INVALID_INPUT", "事件时间窗须为有效的秒精度基本 UTC 时间或带显式 Z／offset 的 ISO 8601 时间");
	}
}

function eventWindow(context: DavReadContext, input: CalendarListInput) {
	const start = windowTime(context, input.start), end = windowTime(context, input.end);
	if (start.instant >= end.instant) throw new DavToolError("INVALID_INPUT", "事件时间窗的 start 必须早于 end");
	const timeZone = input.timeZone ?? context.timeZone;
	if (!timeZone) throw new DavToolError("TIMEZONE_REQUIRED", "事件展开需要显式指定 timeZone 或配置账户时区");
	try { new Intl.DateTimeFormat("en-US", { timeZone }); }
	catch { throw new DavToolError("INVALID_INPUT", "事件展开时区无效"); }
	return { start: start.value, end: end.value, timeZone };
}

function rejectRange(component: CalendarComponent) {
	if (component.properties.some(property => property.name === "RECURRENCE-ID" && property.parameters.RANGE !== undefined)) {
		throw new DavToolError("RECURRENCE_UNSUPPORTED", "不支持 RECURRENCE-ID 带 RANGE 的目标");
	}
}

function matches(component: CalendarComponent, input: CalendarListInput, kind: CalendarComponentKind) {
	return component.kind === kind && (input.uid === undefined || component.uid === input.uid) &&
		(input.status === undefined || component.status?.toUpperCase() === input.status.toUpperCase());
}

function summary(component: CalendarComponent) {
	return { kind: component.kind, uid: component.uid, summary: component.summary,
		location: component.location, status: component.status };
}

/** 存储组件只投影时间，不自行解释 floating/DATE 为某个时区的 instant。 */
function storedTimes(context: DavReadContext, component: CalendarComponent) {
	const fields = { DTSTART: "start", DTEND: "end", DUE: "due", COMPLETED: "completed",
		CREATED: "created", "LAST-MODIFIED": "lastModified", DTSTAMP: "dtstamp" } as const;
	const times: Partial<Record<(typeof fields)[keyof typeof fields], ReturnType<DavReadContext["ical"]["parseCalendarTime"]>>> = {};
	try {
		for (const [name, field] of Object.entries(fields)) {
			const found = component.properties.filter(property => property.name === name);
			if (found.length > 1) return invalidData();
			const property = found[0];
			if (!property) continue;
			const values = property.parameters.VALUE, zones = property.parameters.TZID;
			const type = values?.[0]?.toUpperCase();
			if ((values && values.length !== 1) || (zones && zones.length !== 1) ||
				(type !== undefined && type !== "DATE" && type !== "DATE-TIME")) return invalidData();
			const options: Parameters<DavReadContext["ical"]["parseCalendarTime"]>[1] = {};
			if (type !== undefined) options.valueType = type;
			if (zones) options.tzid = zones[0];
			const time = context.ical.parseCalendarTime(property.rawValue, options);
			if (time.unresolvedReason !== null) return invalidData();
			times[field] = time;
		}
		return times;
	} catch { return invalidData(); }
}

function propertyDetails({ raw: _raw, ...property }: CalendarProperty) { return property; }

export async function listCalendar(context: DavReadContext, input: CalendarListInput, kind: CalendarComponentKind) {
	if (kind === "VEVENT") {
		const window = eventWindow(context, input);
		// 服务端解释 floating 的时区可能不同；只筛组件，避免时间窗预筛选漏项。
		const resources = await context.client.query(input.collectionUrl, "calendar", { component: kind });
		const items = resources.flatMap(resource => {
			for (const component of parse(context, resource.data).components) {
				if (component.kind === kind) rejectRange(component);
			}
			let occurrences: ReturnType<DavReadContext["ical"]["expandEvents"]>;
			try { occurrences = context.ical.expandEvents(resource.data, window); }
			catch { return invalidData(); }
			return occurrences.filter(occurrence => matches(occurrence.component, input, kind)).map(occurrence => ({
				resourceUrl: resource.url, etag: resource.etag, ...summary(occurrence.component),
				// 展开身份仅是发生时间值；存储选择器是完整逻辑行，两者不可互换。
				recurrenceId: occurrence.recurrenceId, storedRecurrenceId: occurrence.component.recurrenceId,
				start: occurrence.start, end: occurrence.end,
				startInstant: occurrence.startInstant, endInstant: occurrence.endInstant,
			}));
		});
		items.sort((left, right) => left.startInstant - right.startInstant);
		return { complete: true, account: input.account, collectionUrl: input.collectionUrl,
			kind, expanded: true, start: window.start, end: window.end, timeZone: window.timeZone, items };
	}
	const resources = await context.client.query(input.collectionUrl, "calendar", { component: kind });
	const items = resources.flatMap(resource => parse(context, resource.data).components
		.filter(component => component.kind === kind)
		.map(component => ({ component, times: storedTimes(context, component) }))
		.filter(({ component }) => matches(component, input, kind))
		.map(({ component, times }) => ({ resourceUrl: resource.url, etag: resource.etag, ...summary(component),
			recurrenceId: component.recurrenceId, storedRecurrenceId: component.recurrenceId, ...times })));
	return { complete: true, account: input.account, collectionUrl: input.collectionUrl, kind, storedComponents: true, items };
}

export async function getCalendar(context: DavReadContext, input: CalendarGetInput, kind: CalendarComponentKind) {
	const resource = await context.client.get(input.resourceUrl);
	const components = parse(context, resource.data).components.filter(component => component.kind === kind &&
		component.uid === input.uid && component.recurrenceId === (input.recurrenceId ?? null));
	if (components.length > 1) throw new DavToolError("AMBIGUOUS_TARGET", "资源内存在多个匹配组件，无法唯一选择目标");
	const component = components[0];
	if (!component) throw new DavToolError("NOT_FOUND", "资源内未找到指定的日历组件");
	rejectRange(component);
	const result = { account: input.account, resourceUrl: resource.url, etag: resource.etag,
		...summary(component), recurrenceId: component.recurrenceId, description: component.description,
		...storedTimes(context, component), properties: component.properties.map(propertyDetails),
		alarms: component.alarms.map(alarm => ({ properties: alarm.properties.map(propertyDetails) })),
	};
	const response: typeof result & { raw?: string } = result;
	if (input.raw === true) response.raw = resource.data;
	return response;
}
