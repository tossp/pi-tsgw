import { randomUUID } from "node:crypto";
import { DavToolError, type DavReadContext } from "./types.ts";

export interface VersionedResourceInput { resourceUrl: string; etag: string }

/** 校验调用方确认的版本，不能用本次 GET 的版本自动替换它。 */
export async function getVersionedResource(context: DavReadContext, input: VersionedResourceInput) {
	const match = /^"[\x21\x23-\x7e\x80-\xff]*"$/.exec(input.etag);
	if (!match || match[0] !== input.etag)
		throw new DavToolError("INVALID_INPUT", "更新或删除必须提供上次读取的单个强 ETag；不能使用弱标签、通配符或标签列表。");
	const resource = await context.client.get(input.resourceUrl);
	if (resource.etag !== input.etag)
		throw new DavToolError("CONFLICT", "资源版本已变化或当前无可用版本，未执行写入；请重新读取并确认变更。");
	return resource;
}

export function createResourceUrl(collectionUrl: string, extension: "ics" | "vcf"): string {
	const url = new URL(collectionUrl);
	if (url.search || url.hash)
		throw new DavToolError("INVALID_INPUT", "创建使用明确集合 URL，不能附查询参数或片段。");
	url.pathname = `${url.pathname.replace(/\/?$/, "/")}${randomUUID()}.${extension}`;
	return url.href;
}

export function utcStamp(): string {
	return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** 库错误可能携带资源值，业务输入/源内容失败只输出安全分类。 */
export function contentOperation<T>(operation: () => T, code: "INVALID_INPUT" | "DATA_INVALID" = "INVALID_INPUT"): T {
	try { return operation(); }
	catch (error) {
		if (error instanceof DavToolError) throw error;
		throw new DavToolError(code, code === "DATA_INVALID"
			? "资源内容无法安全解释，未执行写入。"
			: "内容或字段组合无效，未执行写入；请核对时间表示、目标身份、属性覆盖和提醒依赖。");
	}
}
