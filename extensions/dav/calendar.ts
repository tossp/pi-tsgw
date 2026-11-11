import type { DavResource } from "davkit/dav";
import type { CalendarComponent, CalendarComponentKind, CalendarProperty, ContentValidationResult } from "davkit/ical";
import { unresolvedResource, type ReadFailureStage } from "./content.ts";
import { DavToolError, type CalendarGetInput, type CalendarListInput, type DavReadContext } from "./types.ts";

/** 只包围同步本地内容调用；网络、协议和取消不进入此边界。 */
function readContent<T>(read: () => T): { ok: true; value: T } | { ok: false } {
	try { return { ok: true, value: read() }; }
	catch (error) {
		// 按库公开的异常名称区分，避免工具登记期加载可选依赖。
		if (error instanceof DavToolError || (error instanceof Error &&
			["DavError", "DavConflictError", "DavProtocolError", "AbortError", "TimeoutError"].includes(error.name))) throw error;
		return { ok: false };
	}
}

function validation(context: DavReadContext, raw: string): ContentValidationResult | undefined {
	const result = readContent(() => context.ical.validateCalendarResource(raw));
	return result.ok ? result.value : undefined;
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
		throw new Error("无法解释范围例外");
	}
}

function matches(component: CalendarComponent, input: CalendarListInput, kind: CalendarComponentKind) {
	return component.kind === kind && (input.uid === undefined || component.uid === input.uid) &&
		(input.status === undefined || component.status?.toUpperCase() === input.status.toUpperCase());
}

function summary(component: CalendarComponent) {
	// 不以解析器的首项投影掩盖单值字段歧义。
	for (const name of ["SUMMARY", "LOCATION", "STATUS"]) {
		if (component.properties.filter(property => property.name === name).length > 1) throw new Error("字段有歧义");
	}
	return { kind: component.kind, uid: component.uid, summary: component.summary,
		location: component.location, status: component.status };
}

/** 仅针对筛选/取消语义使用 STATUS 诊断，不用整资源 valid 作为读取门槛。 */
function reliableStatus(component: CalendarComponent, checked: ContentValidationResult | undefined) {
	if (!component.properties.some(property => property.name === "STATUS")) return true;
	return checked !== undefined && !checked.issues.some(issue => issue.property === "STATUS");
}

/** 存储组件只投影时间，不自行解释 floating/DATE 为某个时区的 instant。 */
function storedTimes(context: DavReadContext, component: CalendarComponent) {
	const fields = { DTSTART: "start", DTEND: "end", DUE: "due", COMPLETED: "completed",
		CREATED: "created", "LAST-MODIFIED": "lastModified", DTSTAMP: "dtstamp" } as const;
	const times: Partial<Record<(typeof fields)[keyof typeof fields], ReturnType<DavReadContext["ical"]["parseCalendarTime"]>>> = {};
	for (const [name, field] of Object.entries(fields)) {
		const found = component.properties.filter(property => property.name === name);
		if (found.length > 1) throw new Error("时间字段有歧义");
		const property = found[0];
		if (!property) continue;
		const values = property.parameters.VALUE, zones = property.parameters.TZID;
		const type = values?.[0]?.toUpperCase();
		if ((values && values.length !== 1) || (zones && zones.length !== 1) ||
			(type !== undefined && type !== "DATE" && type !== "DATE-TIME")) throw new Error("时间参数无法解释");
		const options: Parameters<DavReadContext["ical"]["parseCalendarTime"]>[1] = {};
		if (type !== undefined) options.valueType = type;
		if (zones) options.tzid = zones[0];
		const time = context.ical.parseCalendarTime(property.rawValue, options);
		if (time.unresolvedReason !== null) throw new Error("时间无法解释");
		times[field] = time;
	}
	return times;
}

function propertyDetails({ raw: _raw, ...property }: CalendarProperty) { return property; }

/** 保留库确认的身份与结构；不把时间失败时的主件伪装成发生项。 */
function readableComponents(components: CalendarComponent[]) {
	return components.map(component => ({ kind: component.kind, uid: component.uid, recurrenceId: component.recurrenceId,
		properties: component.properties.map(propertyDetails) }));
}

type UnresolvedCalendarResource = ReturnType<typeof unresolvedResource> & { components?: ReturnType<typeof readableComponents> };

function unresolved(context: DavReadContext, resource: DavResource, rawSource: "get" | "report",
	stage: ReadFailureStage, components?: CalendarComponent[]): UnresolvedCalendarResource {
	const result: UnresolvedCalendarResource = unresolvedResource(resource, rawSource, stage, validation(context, resource.data));
	if (components !== undefined) result.components = readableComponents(components);
	return result;
}

function eventItem(resource: DavResource, occurrence: ReturnType<DavReadContext["ical"]["expandEvents"]>[number]) {
	return { resourceUrl: resource.url, etag: resource.etag, ...summary(occurrence.component),
		// 展开身份仅是发生时间值；存储选择器是完整逻辑行，两者不可互换。
		recurrenceId: occurrence.recurrenceId, storedRecurrenceId: occurrence.component.recurrenceId,
		start: occurrence.start, end: occurrence.end, startInstant: occurrence.startInstant, endInstant: occurrence.endInstant };
}

function storedItem(context: DavReadContext, resource: DavResource, component: CalendarComponent) {
	return { resourceUrl: resource.url, etag: resource.etag, ...summary(component),
		recurrenceId: component.recurrenceId, storedRecurrenceId: component.recurrenceId, ...storedTimes(context, component) };
}

export async function listCalendar(context: DavReadContext, input: CalendarListInput, kind: CalendarComponentKind) {
	const window = kind === "VEVENT" ? eventWindow(context, input) : undefined;
	// 服务端解释 floating 的时区可能不同；只筛组件，避免时间窗预筛选漏项。
	const resources = await context.client.query(input.collectionUrl, "calendar", { component: kind });
	const events: ReturnType<typeof eventItem>[] = [], stored: ReturnType<typeof storedItem>[] = [];
	const unresolvedResources: UnresolvedCalendarResource[] = [];
	for (const resource of resources) {
		const parsed = readContent(() => context.ical.parseCalendar(resource.data));
		if (!parsed.ok) { unresolvedResources.push(unresolved(context, resource, "report", "parse")); continue; }
		const components = parsed.value.components;
		// 身份由库解析确认；未能解析的资源不会进入此排除分支。
		const candidates = components.filter(component => component.kind === kind && (input.uid === undefined || component.uid === input.uid));
		if (!candidates.length) continue;
		const checked = candidates.some(component => component.properties.some(property => property.name === "STATUS"))
			? validation(context, resource.data) : undefined;
		const relevant = candidates.filter(component => !reliableStatus(component, checked) || matches(component, input, kind));
		if (!relevant.length) continue;
		const projected = readContent(() => {
			for (const component of relevant) {
				if (!reliableStatus(component, checked)) throw new Error("状态无法确认");
				summary(component);
			}
			return window ? [] : relevant.map(component => storedItem(context, resource, component));
		});
		if (!projected.ok) { unresolvedResources.push(unresolved(context, resource, "report", "projection", components)); continue; }
		if (!window) { stored.push(...projected.value); continue; }
		// 必须把整份原文交给库：不拆系列/例外，不在失败后输出该资源的部分发生项。
		const expanded = readContent(() => context.ical.expandEvents(resource.data, window));
		if (!expanded.ok) { unresolvedResources.push(unresolved(context, resource, "report", "expand", components)); continue; }
		const items = readContent(() => expanded.value.filter(occurrence => matches(occurrence.component, input, kind))
			.map(occurrence => eventItem(resource, occurrence)));
		if (!items.ok) { unresolvedResources.push(unresolved(context, resource, "report", "projection", components)); continue; }
		events.push(...items.value);
	}
	const common = { complete: unresolvedResources.length === 0, resourcesComplete: true as const,
		account: input.account, collectionUrl: input.collectionUrl, kind, unresolvedResources };
	if (window) {
		events.sort((left, right) => left.startInstant - right.startInstant);
		return { ...common, expanded: true, ...window, items: events };
	}
	return { ...common, storedComponents: true, items: stored };
}

export async function getCalendar(context: DavReadContext, input: CalendarGetInput, kind: CalendarComponentKind) {
	if ((input.uid === undefined && input.raw !== true) || (input.recurrenceId !== undefined && input.uid === undefined)) {
		throw new DavToolError("INVALID_INPUT", "普通组件详情必须指定 uid；仅 raw:true 可省略 uid，recurrenceId 不得单独出现");
	}
	const resource = await context.client.get(input.resourceUrl);
	const identity = { account: input.account, resourceUrl: resource.url, etag: resource.etag, resourcesComplete: true as const };
	if (input.uid === undefined) {
		// complete 仅确认整资源取得，不确认格式、组件身份或发生项；此模式完全不依赖解析。
		return { ...identity, complete: true as const, completenessScope: "resource" as const,
			selectorVerified: false as const, selectorStatus: "not-requested" as const,
			raw: resource.data, rawSource: "get" as const };
	}
	const failed = (stage: ReadFailureStage, components?: CalendarComponent[]) => ({
		...identity, ...unresolved(context, resource, "get", stage, components),
		complete: false as const, completenessScope: "component" as const,
		selectorVerified: false as const, selectorStatus: "unverified" as const,
		selectionMessage: "内容未能完整解释，未验证请求的组件选择器；不能据此确认匹配或不存在。",
		requestedSelector: { kind, uid: input.uid, recurrenceId: input.recurrenceId ?? null },
	});
	const parsed = readContent(() => context.ical.parseCalendar(resource.data));
	if (!parsed.ok) return failed("parse");
	const components = parsed.value.components.filter(component => component.kind === kind &&
		component.uid === input.uid && component.recurrenceId === (input.recurrenceId ?? null));
	// 可靠的选择错误不能被原文降级掩盖；检查在字段投影之前，且不在内容 catch 内。
	if (components.length > 1) throw new DavToolError("AMBIGUOUS_TARGET", "资源内存在多个匹配组件，无法唯一选择目标");
	const component = components[0];
	if (!component) throw new DavToolError("NOT_FOUND", "资源内未找到指定的日历组件");
	const projected = readContent(() => {
		rejectRange(component);
		if (!reliableStatus(component, component.properties.some(property => property.name === "STATUS")
			? validation(context, resource.data) : undefined)) throw new Error("状态无法确认");
		if (component.properties.filter(property => property.name === "DESCRIPTION").length > 1) throw new Error("详情字段有歧义");
		return { ...summary(component), recurrenceId: component.recurrenceId, description: component.description,
			...storedTimes(context, component), properties: component.properties.map(propertyDetails),
			alarms: component.alarms.map(alarm => ({ properties: alarm.properties.map(propertyDetails) })) };
	});
	if (!projected.ok) return failed("projection", parsed.value.components);
	const response: typeof projected.value & typeof identity & { complete: true; completenessScope: "component";
		selectorVerified: true; selectorStatus: "verified"; raw?: string; rawSource?: "get" } = {
		...identity, ...projected.value, complete: true, completenessScope: "component", selectorVerified: true, selectorStatus: "verified",
	};
	if (input.raw === true) { response.raw = resource.data; response.rawSource = "get"; }
	return response;
}
