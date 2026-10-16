import { UploadError, invalidResponse } from "./errors.ts";

export const SINGLE_LIMIT = 32 * 1024 ** 2;
export const MAX_BYTES = 5 * 1024 ** 4;
export const UPLOAD_TOOL = "mcp__ts_oht__upload_file";
export const URL_TOOL = "mcp__ts_oht__get_file_url";
// 绝对结尾断言：JavaScript 单独使用 `$` 也会接受末尾换行。
export const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$(?![\s\S])/;
export const RESUME_PATTERN = /^[A-Za-z0-9_-]+$(?![\s\S])/;

export interface FileMetadata {
	filename: string;
	contentType: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}
export type Download = {
	key: string;
	url: string;
	expiresAt: string;
	expiresIn: number;
};
export interface Target {
	partNumber: number;
	offset: number;
	size: number;
	url: string;
	method: "PUT";
	headers: Record<string, string>;
	expiresAt: string;
}
export interface Plan extends Download {
	mode: "single" | "multipart";
	uploaded: boolean;
	uploads: Target[];
	uid?: string;
	partSize?: number;
	totalParts?: number;
}
export interface Receipt {
	version: 1;
	key: string;
	uid?: string;
	mode: "single" | "multipart";
	phase: "upload" | "complete" | "link";
	fingerprint: string;
	metadata: FileMetadata;
}

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalidResponse();
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 16384): string {
	if (typeof value !== "string" || !value || value.length > max) invalidResponse();
	return value;
}
function integer(value: unknown, max: number): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) invalidResponse();
	return value as number;
}
export function validKey(value: unknown): string {
	const key = text(value, 1024);
	if (Buffer.byteLength(key) > 1024 || /[\u0000-\u001f\u007f-\u009f\\%?#]/.test(key) || key.split("/").some(p => !p || p === "." || p === "..")) invalidResponse();
	return key;
}
function httpsUrl(value: unknown): string {
	const input = text(value);
	try {
		const url = new URL(input);
		if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) invalidResponse();
		return input;
	} catch { return invalidResponse(); }
}
function expiry(value: unknown): string {
	const date = text(value, 64);
	if (!Number.isFinite(Date.parse(date))) invalidResponse();
	return date;
}

/** 主机适配器提供的是 MCP CallToolResult，而非 AgentToolCallOutcome。 */
export function mcpData(value: unknown): Record<string, unknown> {
	const result = object(value);
	let data: unknown = result.structuredContent;
	if (data === undefined && Array.isArray(result.content)) {
		const blocks = result.content.filter(b => b && b.type === "text");
		if (blocks.length === 1 && typeof blocks[0].text === "string" && blocks[0].text.length <= 4 * 1024 ** 2) {
			try { data = JSON.parse(blocks[0].text); } catch { /* 拒绝非 JSON 内容，绝不回显。 */ }
		}
	}
	const body = object(data);
	if (result.isError === true || body.error !== undefined) {
		const error = body.error && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
		// 只有明确的 not-found 才允许继续恢复分片上传。
		const code = error.code === "not-found" ? "not-found" : "mcp-error";
		throw new UploadError(code, code === "not-found"
			? "先前的对象不存在。"
			: "远程工具调用失败；为保护凭据，未提供其原始响应。");
	}
	return body;
}

export function download(value: unknown, expectedKey?: string, expectedSeconds = 86400): Download {
	const data = object(value);
	const result = {
		key: validKey(data.key), url: httpsUrl(data.url),
		expiresAt: expiry(data.expiresAt), expiresIn: integer(data.expiresIn, 604800),
	};
	if ((expectedKey && result.key !== expectedKey) || result.expiresIn !== expectedSeconds) invalidResponse();
	return result;
}

export function planIdentity(value: unknown, size: number, previous?: Receipt): Pick<Plan, "key" | "mode" | "uploaded" | "uid" | "partSize" | "totalParts"> {
	const data = object(value);
	const key = validKey(data.key);
	if (previous && key !== previous.key)
		throw new UploadError("session-changed", "旧的分片上传任务已不可用。已拒绝不同的上传计划，未向其发送任何字节。");
	const mode = size <= SINGLE_LIMIT ? "single" : "multipart";
	if (data.mode !== mode || typeof data.uploaded !== "boolean" ||
		!Array.isArray(data.uploads) || data.uploads.length > 1024) invalidResponse();
	const result: Pick<Plan, "key" | "mode" | "uploaded" | "uid" | "partSize" | "totalParts"> = { key, mode, uploaded: data.uploaded };
	if (result.mode === "multipart") {
		result.uid = text(data.uid, 64);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result.uid)) invalidResponse();
		if (previous && previous.uid !== result.uid) invalidResponse();
		result.partSize = integer(data.partSize, 5 * 1024 ** 3);
		result.totalParts = integer(data.totalParts, 1024);
		if (result.partSize < 5 * 1024 ** 2 || Math.ceil(size / result.partSize) !== result.totalParts ||
			data.remainingParts !== data.uploads.length) invalidResponse();
	} else if (result.uploaded || data.uploads.length !== 1) invalidResponse();
	if (result.uploaded !== (data.uploads.length === 0)) invalidResponse();
	return result;
}

export function plan(value: unknown, size: number, previous?: Receipt): Plan {
	const identity = planIdentity(value, size, previous);
	const data = object(value);
	const link = download(data);
	const result: Plan = { ...identity, ...link, uploads: [] };
	const seen = new Set<number>();
	for (const item of data.uploads as unknown[]) {
		const part = object(item);
		const number = integer(part.partNumber, result.totalParts ?? 1);
		const offset = (number - 1) * (result.partSize ?? size);
		const bytes = Math.min(result.partSize ?? size, size - offset);
		if (seen.has(number) || part.offset !== offset || part.size !== bytes || part.method !== "PUT") invalidResponse();
		seen.add(number);
		const url = httpsUrl(part.url);
		if (new URL(url).origin !== new URL(link.url).origin) invalidResponse();
		const headers = object(part.headers);
		if (Object.keys(headers).length > 64 || Object.values(headers).some(v => typeof v !== "string" || v.length > 8192)) invalidResponse();
		result.uploads.push({ partNumber: number, offset, size: bytes, url, method: "PUT",
			headers: headers as Record<string, string>, expiresAt: expiry(part.expiresAt) });
	}
	return result;
}

/** 凭条不包含 URL、请求头、S3 凭据或 MCP 密钥。 */
export function encodeReceipt(receipt: Receipt): string {
	return Buffer.from(JSON.stringify(receipt)).toString("base64url");
}
export function decodeReceipt(token: string): Receipt {
	try {
		if (!token || token.length > 8192 || !RESUME_PATTERN.test(token)) invalidResponse();
		const data = object(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
		const meta = object(data.metadata);
		if (data.version !== 1 || !["single", "multipart"].includes(String(data.mode)) ||
			!["upload", "complete", "link"].includes(String(data.phase)) ||
			typeof data.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(data.fingerprint) ||
			typeof meta.mtimeMs !== "number" || !Number.isFinite(meta.mtimeMs) ||
			typeof meta.ctimeMs !== "number" || !Number.isFinite(meta.ctimeMs)) invalidResponse();
		const metadata: FileMetadata = { filename: text(meta.filename, 255), contentType: text(meta.contentType, 127),
			size: integer(meta.size, MAX_BYTES), mtimeMs: meta.mtimeMs, ctimeMs: meta.ctimeMs };
		const mode = data.mode as Receipt["mode"];
		if ((metadata.size <= SINGLE_LIMIT) !== (mode === "single")) invalidResponse();
		return { version: 1, key: validKey(data.key), mode, phase: data.phase as Receipt["phase"],
			uid: mode === "multipart" ? text(data.uid, 64) : undefined, fingerprint: data.fingerprint, metadata };
	} catch { throw new UploadError("invalid-resume", "恢复凭条无效。不要以全新上传尝试代替恢复。"); }
}
