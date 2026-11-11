import type { DavResource } from "davkit/dav";
import type { ContentValidationResult } from "davkit/ical";
import { DavToolError } from "./types.ts";

export type ReadFailureStage = "parse" | "projection" | "expand" | "search";

const readMessages = {
	parse: "资源无法可靠解析，已保留实际返回的原文；未确认组件身份。",
	projection: "部分字段或目标语义无法可靠解释，已保留原文与可确认的字段。",
	expand: "资源的发生项无法完整计算，已保留原文；不能据此判定时间窗内有无日程。",
	search: "部分搜索字段无法可靠解码，已保留原文；该资源是否匹配仍未知。",
} as const;

/** 仅用于已经取得正文后的内容阶段；获取、协议和取消错误不得送入此分支。 */
export function unresolvedResource(
	resource: Pick<DavResource, "url" | "etag" | "data">,
	rawSource: "get" | "report",
	stage: ReadFailureStage,
	validation?: ContentValidationResult,
) {
	return {
		resourceUrl: resource.url, etag: resource.etag, raw: resource.data, rawSource, stage,
		issues: validation?.issues.length ? validation.issues : [{
			code: `DAV_CONTENT_${stage.toUpperCase()}_UNRESOLVED`, category: "unsupported" as const,
			componentPath: [], message: readMessages[stage],
		}],
	};
}

/** 此前须已可靠解析并确认目标；源整体异常不妨碍表达修正，但受管字段不能静默覆盖。 */
export function assertManagedMetadata(
	validation: ContentValidationResult,
	names: readonly string[],
	details: Record<string, unknown>,
	stage: "source" | "repair" = "source",
): void {
	const issues = validation.issues.filter(issue =>
		(issue.property !== undefined && names.includes(issue.property)) ||
		issue.code === "structure" || issue.code === "ICAL_STRUCTURE");
	if (issues.length) throw new DavToolError("REPAIR_UNSUPPORTED", stage === "repair"
		? "明确修复后，资源中仍有异常修订信息或无法确认的结构，未执行写入；请核对全部诊断和修正范围。"
		: "源修订信息存在错误或无法确认；请先说明并确认具体修正，通过 revisionRepair 表达受管字段修复，未执行写入。",
		{ ...details, stage, issues });
}

/** 必须检查实际候选；调用方不能在通过后刷新元数据或发送另一份字符串。 */
export function assertValidContent(validation: ContentValidationResult, details: Record<string, unknown>): void {
	if (!validation.valid) throw new DavToolError("CONTENT_VALIDATION_FAILED",
		"最终整份资源仍有错误或无法验证的内容，未执行写入；请结合原文确认修正及影响。",
		{ ...details, stage: "final", issues: validation.issues });
}
