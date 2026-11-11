import type { ContentValidationResult } from "davkit/ical";
import { DavToolError } from "./types.ts";

export interface CalendarRevisionRepair {
	dtstamp?: string;
	lastModified?: string | null;
	sequence?: number | null;
}

/** 只生成已明确声明且有源诊断的属性操作；validation 必须只含所选目标的直接属性诊断，修复是否成功仍由库检查候选。 */
export function revisionRepairEdit(
	fields: readonly (readonly [string, string | number | null | undefined])[],
	validation: ContentValidationResult,
	details: Record<string, unknown>,
): { properties: string[]; removeProperties: string[] } {
	const properties: string[] = [];
	const removeProperties: string[] = [];
	for (const [name, value] of fields) {
		if (value === undefined) continue;
		if (!validation.issues.some(issue => issue.property === name))
			throw new DavToolError("INVALID_INPUT", "所声明修订字段没有对应的源问题诊断，不能通过修复入口任意改写合法修订信息。",
				{ ...details, stage: "repair", property: name });
		if (value === null) removeProperties.push(name);
		else properties.push(`${name}:${value}`);
	}
	return { properties, removeProperties };
}
