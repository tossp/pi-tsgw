import type { CalendarComponentEdit, CalendarComponentKind, CalendarTimeInput, ContentValidationResult } from "davkit/ical";
import { assertManagedMetadata, assertValidContent } from "./content.ts";
import { contentOperation, createResourceUrl, getVersionedResource, utcStamp } from "./mutations.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

type Time = string | CalendarTimeInput;
interface Fields {
	summary?: string | null;
	description?: string | null;
	location?: string | null;
	status?: string | null;
	start?: Time | null;
	end?: Time | null;
	due?: Time | null;
	date?: Time | null;
	rrule?: string | null;
	properties?: string[];
	alarms?: string[];
}
export interface CalendarCreateInput extends Fields { account: string; collectionUrl: string; summary: string }
export interface CalendarUpdateInput extends Fields {
	account: string; resourceUrl: string; uid: string; etag: string;
	recurrenceId?: string;
	removeProperties?: string[];
}
export interface CalendarDeleteInput { account: string; resourceUrl: string; uid: string; etag: string }

const contentType = "text/calendar; charset=utf-8";
const protectedNames = new Set(["UID", "VERSION", "PRODID", "RECURRENCE-ID", "DTSTAMP", "LAST-MODIFIED", "SEQUENCE", "BEGIN", "END"]);
const scalarNames = { summary: "SUMMARY", description: "DESCRIPTION", location: "LOCATION", status: "STATUS",
	start: "DTSTART", date: "DTSTART", end: "DTEND", due: "DUE", rrule: "RRULE" } as const;

function invalid(message: string): never { throw new DavToolError("INVALID_INPUT", message); }

/** 只识别调用方属性的基本名以检查业务冲突，完整语法仍交给库；不扫描源原文。 */
function inputPropertyName(line: string): string {
	const match = /^(?:[a-z0-9-]+\.)?([a-z0-9-]+)(?=[;:])/i.exec(line);
	if (!match || /[\r\n]/.test(line)) return invalid("properties 必须是未折行的完整逻辑属性。");
	return match[1]!.toUpperCase();
}

function validateFields(input: Fields & { removeProperties?: string[] }, kind: CalendarComponentKind) {
	if ((kind !== "VEVENT" && (input.end !== undefined || input.rrule !== undefined)) ||
		(kind !== "VTODO" && input.due !== undefined) ||
		(kind !== "VJOURNAL" && input.date !== undefined) ||
		(kind === "VJOURNAL" && (input.start !== undefined || input.alarms !== undefined)))
		invalid("字段不适用于指定日历类型；日记时间使用 date，提醒仅支持事件和待办。");
	const names = new Set((input.properties ?? []).map(inputPropertyName));
	const removals = new Set((input.removeProperties ?? []).map(name => {
		if (!/^[a-z0-9-]+$/i.test(name)) return invalid("removeProperties 仅接受基本属性名。");
		return name.toUpperCase();
	}));
	for (const name of [...names, ...removals]) {
		if (protectedNames.has(name)) invalid("不能直接设置或删除身份、版本及受管修订元数据。");
		if (names.has(name) && removals.has(name)) invalid("同名属性不能同时设置和删除。");
	}
	for (const [key, name] of Object.entries(scalarNames)) {
		if (input[key as keyof typeof scalarNames] !== undefined && (names.has(name) || removals.has(name)))
			invalid("便捷字段与同名完整属性或删除操作冲突。");
	}
}

function createTime(context: DavReadContext, name: string, input: Time): string {
	const value = typeof input === "string"
		? { value: input, ...(/^\d{8}$/.test(input) ? { valueType: "DATE" as const } : {}) }
		: input;
	if (value.tzid !== undefined && !/^[a-z0-9_+\-/]+$/i.test(value.tzid))
		invalid("TZID 必须是明确且可解析的时区标识。");
	const time = context.ical.parseCalendarTime(value.value, value);
	if (time.unresolvedReason !== null) invalid("时间或时区无法唯一解释，不能猜测当地时间。");
	return `${name}${time.kind === "date" ? ";VALUE=DATE" : time.tzid ? `;TZID=${time.tzid}` : ""}:${time.value}`;
}

function recurrenceLine(value: string): string {
	if (!value || /[\r\n]/.test(value)) invalid("rrule 只接收单行规则值，不包含 RRULE:。");
	return `RRULE:${value}`;
}

function selector(input: CalendarUpdateInput, kind: CalendarComponentKind) {
	if (input.recurrenceId !== undefined &&
		(!/^RECURRENCE-ID[;:]/i.test(input.recurrenceId) || /[\r\n]/.test(input.recurrenceId)))
		invalid("例外选择器必须是完整 RECURRENCE-ID 逻辑行，不能使用裸时间或展开实例身份。");
	return { kind, uid: input.uid, ...(input.recurrenceId === undefined ? {} : { recurrenceId: input.recurrenceId }) };
}

/** 旧编辑器失败时尚无最终候选；只附已取得的库源诊断，不猜测或回显底层异常。 */
function candidateOperation<T>(operation: () => T, validation: ContentValidationResult,
	details: Record<string, unknown>, stage: "source" | "edit" | "revision"): T {
	try { return operation(); }
	catch (error) {
		if (error instanceof DavToolError) throw error;
		if (stage === "edit" && validation.valid)
			throw new DavToolError("INVALID_INPUT", "库未能应用本次字段组合，尚未生成最终候选；请核对时间表示、属性覆盖和提醒依赖。",
				{ ...details, stage });
		throw new DavToolError("REPAIR_UNSUPPORTED", stage === "source"
			? "源内容无法可靠解析或确认身份，不能确认受管修订信息，未执行写入。"
			: "库未能生成最终候选，尚未执行最终校验；现有单组件编辑无法确认完成所需修正，不能绕过源或兄弟组件限制。",
			{ ...details, stage, issues: validation.issues });
	}
}

function selectComponent(context: DavReadContext, raw: string, input: CalendarUpdateInput, kind: CalendarComponentKind,
	validation: ContentValidationResult, details: Record<string, unknown>) {
	const components = candidateOperation(() => context.ical.parseCalendar(raw), validation, details, "source").components
		.filter(component => component.kind === kind && component.uid === input.uid &&
			component.recurrenceId === (input.recurrenceId ?? null));
	if (components.length > 1) throw new DavToolError("AMBIGUOUS_TARGET", "资源内目标组件不唯一，未执行写入。");
	const component = components[0];
	if (!component) throw new DavToolError("NOT_FOUND", "资源内未找到指定组件；不能隐式创建例外。");
	if (component.properties.some(property => property.name === "RECURRENCE-ID" && property.parameters.RANGE !== undefined))
		throw new DavToolError("RECURRENCE_UNSUPPORTED", "不支持 RECURRENCE-ID 带 RANGE 的目标。");
	return component;
}

export async function createCalendar(context: DavReadContext, input: CalendarCreateInput, kind: CalendarComponentKind) {
	validateFields(input, kind);
	if (typeof input.summary !== "string") invalid("创建必须提供 summary。");
	if (kind === "VEVENT" && input.start == null) invalid("创建事件必须提供 start。");
	if (kind === "VJOURNAL" && input.date == null) invalid("创建日记必须明确提供 date，不使用默认当天。");
	const raw = contentOperation(() => {
		const properties = [...(input.properties ?? []), `LAST-MODIFIED:${utcStamp()}`, "SEQUENCE:0"];
		for (const [field, name] of [["start", "DTSTART"], ["end", "DTEND"], ["due", "DUE"], ["date", "DTSTART"]] as const) {
			const value = input[field];
			if (value === null) invalid("创建时间字段不能为 null。");
			if (value !== undefined) properties.push(createTime(context, name, value));
		}
		if (input.rrule === null) invalid("创建 rrule 不能为 null。");
		if (input.rrule !== undefined) properties.push(recurrenceLine(input.rrule));
		let data = context.ical.buildCalendarComponent({ kind, summary: input.summary, properties, alarms: input.alarms });
		const component = context.ical.parseCalendar(data).components[0]!;
		const edit: CalendarComponentEdit = {};
		for (const field of ["description", "location", "status"] as const) {
			if (input[field] === null) invalid("创建文字字段不能为 null。");
			if (input[field] !== undefined) edit[field] = input[field];
		}
		data = context.ical.updateCalendarComponent(data, { kind, uid: component.uid }, edit);
		return { data, uid: component.uid };
	});
	const resourceUrl = createResourceUrl(input.collectionUrl, "ics");
	assertValidContent(context.ical.validateCalendarResource(raw.data), { account: input.account, resourceUrl, uid: raw.uid, kind });
	context.writeIdentity = { account: input.account, kind, uid: raw.uid };
	const etag = await context.client.create(resourceUrl, raw.data, contentType);
	return { account: input.account, kind, resourceUrl, uid: raw.uid, etag, outcome: "created" as const };
}

export async function updateCalendar(context: DavReadContext, input: CalendarUpdateInput, kind: CalendarComponentKind) {
	validateFields(input, kind);
	const target = selector(input, kind);
	const resource = await getVersionedResource(context, input);
	const details = { account: input.account, resourceUrl: input.resourceUrl, uid: input.uid, kind };
	const validation = context.ical.validateCalendarResource(resource.data);
	const component = selectComponent(context, resource.data, input, kind, validation, details);
	// 不要求整个源 valid；只防止正常刷新覆盖尚不能表达修正的源元数据。
	assertManagedMetadata(validation, ["DTSTAMP", "LAST-MODIFIED", "SEQUENCE"], details);
	const edited = candidateOperation(() => {
		const edit: CalendarComponentEdit = { properties: [...(input.properties ?? [])],
			removeProperties: [...(input.removeProperties ?? [])], alarms: input.alarms };
		for (const field of ["summary", "description", "location", "status", "start", "end", "due"] as const) {
			if (input[field] !== undefined) Object.assign(edit, { [field]: input[field] });
		}
		if (input.date !== undefined) edit.start = input.date;
		if (input.rrule === null) edit.removeProperties!.push("RRULE");
		else if (input.rrule !== undefined) edit.properties!.push(recurrenceLine(input.rrule));
		return context.ical.updateCalendarComponent(resource.data, target, edit);
	}, validation, details, "edit");
	if (edited === resource.data) {
		assertValidContent(context.ical.validateCalendarResource(edited), details);
		return { account: input.account, kind, resourceUrl: input.resourceUrl, uid: input.uid, etag: input.etag, outcome: "unchanged" as const };
	}
	// 值与单值约束由源诊断负责；缺省 SEQUENCE 按既有策略从 0 递增。
	const sequence = Number(component.properties.find(property => property.name === "SEQUENCE")?.rawValue ?? 0) + 1;
	const stamp = utcStamp();
	const data = candidateOperation(() => context.ical.updateCalendarComponent(edited, target,
		{ properties: [`DTSTAMP:${stamp}`, `LAST-MODIFIED:${stamp}`, `SEQUENCE:${sequence}`] }), validation, details, "revision");
	assertValidContent(context.ical.validateCalendarResource(data), details);
	const etag = await context.client.update(input.resourceUrl, data, input.etag, contentType);
	return { account: input.account, kind, resourceUrl: input.resourceUrl, uid: input.uid, etag, outcome: "updated" as const };
}

export async function deleteCalendar(context: DavReadContext, input: CalendarDeleteInput, kind: CalendarComponentKind) {
	if ("recurrenceId" in input) invalid("删除针对整份资源，不接受 recurrenceId。");
	const resource = await getVersionedResource(context, input);
	contentOperation(() => context.ical.assertCalendarResourceIdentity(resource.data, { kind, uid: input.uid }), "DATA_INVALID");
	await context.client.delete(input.resourceUrl, input.etag);
	return { account: input.account, kind, resourceUrl: input.resourceUrl, uid: input.uid, etag: input.etag, outcome: "deleted" as const };
}
