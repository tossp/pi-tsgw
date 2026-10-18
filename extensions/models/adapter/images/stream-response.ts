import type { ImageContent } from "@earendil-works/pi-ai";
import type { ImageFormat, ImageOperation } from "./parameters.ts";
import { ImageFailure, MAX_RESPONSE_BYTES, abortable, parseImages, readJson, record } from "./response.ts";

export interface ExpectedImageResponse { count: number; format: ImageFormat; stream: boolean; operation: ImageOperation }
// 单事件仍是单图预算；总预算覆盖每图最多三张 partial、一张 completed 及少量控制帧。
export const MAX_SSE_EVENT_BYTES = MAX_RESPONSE_BYTES;
const CONTROL_BYTES = 64 * 1024;
const fail = (message: string): never => { throw new ImageFailure(message); };

export async function readImageResponse(
	response: Response, signal: AbortSignal, expected: ExpectedImageResponse, reportUsage: (raw: unknown) => void,
): Promise<ImageContent[]> {
	if (!Number.isInteger(expected.count) || expected.count < 1 || expected.count > 10 ||
		!["png", "jpeg", "webp"].includes(expected.format) || !["generate", "edit"].includes(expected.operation) ||
		typeof expected.stream !== "boolean") return fail("图片响应解析参数无效。");
	if (!expected.stream) {
		const raw = await readJson(response, signal, MAX_RESPONSE_BYTES * expected.count);
		reportUsage(raw); // 即使坏图或数量错误，也保留上游已报告的有效 usage。
		return parseImages(raw, expected.count, expected.format);
	}
	const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
	if (contentType !== "text/event-stream") return fail("图片流式响应不是 SSE。");
	return readSse(response, signal, expected, reportUsage);
}

async function readSse(
	response: Response, signal: AbortSignal, expected: ExpectedImageResponse, reportUsage: (raw: unknown) => void,
): Promise<ImageContent[]> {
	const budget = MAX_SSE_EVENT_BYTES * 4 * expected.count + CONTROL_BYTES;
	const length = response.headers.get("content-length");
	if (length && /^\d+$/.test(length) && Number(length) > budget) return fail("图片流式响应超过读取预算上限。");
	if (!response.body) return fail("图片响应为空。");
	const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
	const finals: ImageContent[] = [], usageReports: unknown[] = [];
	const completedIndices = new Set<number>();
	const prefix = expected.operation === "edit" ? "image_edit" : "image_generation";
	let usageSeen = false, partials = 0, terminated = false;
	let totalBytes = 0, eventBytes = 0, frames = 0, complete = false;
	let line = "", event = "", data: string[] = [], skipLf = false, touched = false;
	let previousCrEventBytes: number | undefined;

	function usage(raw: Record<string, unknown>): void {
		if (raw.usage === undefined) return;
		if (expected.count > 1) {
			// 保留原始报告而非猜测逐图/累计归属；交调用方标记未汇总，不合成 usage。
			if (usageReports.length === 10) return;
			usageReports.push(raw.usage);
			reportUsage({ usage_reports: [...usageReports] });
		} else if (!usageSeen) {
			usageSeen = true; reportUsage(raw);
		}
	}
	function dispatch(): void {
		if (++frames > 1024 + 4 * expected.count) return fail("图片流式响应事件过多。");
		if (!data.length) {
			if (event === "error") return fail("图片流式请求返回错误事件。");
			return;
		}
		if (terminated) return fail("图片流式响应在结束标记之后仍有数据。");
		const payload = data.join("\n");
		if (payload === "[DONE]") {
			if (finals.length !== expected.count) return fail("图片流式响应未完成全部图片。");
			terminated = true; return;
		}
		let raw: unknown;
		try { raw = JSON.parse(payload); } catch { return fail("图片 SSE 事件不是有效 JSON。"); }
		if (!record(raw)) return fail("图片 SSE 事件结构无效。");
		if (event === "error" || raw.type === "error" || raw.error !== undefined) {
			usage(raw); return fail("图片流式请求返回错误事件。");
		}
		if (event && raw.type !== undefined && raw.type !== event) return fail("图片 SSE 事件类型不一致。");
		const type = event || raw.type;
		if (type !== `${prefix}.partial_image` && type !== `${prefix}.completed`) return fail("图片 SSE 事件类型不受支持。");
		const final = type === `${prefix}.completed`;
		if (final) {
			// 单图的第二个完成事件不能覆盖首次报告；多图保留超额事件的 usage（最多十项）。
			if (expected.count === 1 && finals.length) return fail("图片 SSE 超额完成。");
			usage(raw); // 在坏图、显式序号及数量检查前保留上游报告。
		}
		const index = raw.image_index;
		if (index !== undefined && (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected.count)) {
			return fail("图片 SSE 序号无效。");
		}
		if (!final) {
			if (++partials > 3 * expected.count || !Number.isInteger(raw.partial_image_index) ||
				(raw.partial_image_index as number) < 0 || (raw.partial_image_index as number) > 2 ||
				finals.length === expected.count || (index !== undefined && completedIndices.has(index as number))) {
				return fail("图片 SSE 中间图事件超额或顺序无效。");
			}
		}
		const image = parseImages({ ...raw, data: [{ b64_json: raw.b64_json }] }, 1, expected.format)[0];
		if (!final) return; // 只验证并丢弃 partial；Promise 不代表实时 UI 或逐帧交付。
		// image_index 仅是可选的上游扩展；不要求每张都有，不据此重排，也不按相同字节去重。
		if (finals.length >= expected.count || (index !== undefined && completedIndices.has(index as number))) {
			return fail("图片 SSE 显式序号重复或超额完成。");
		}
		if (typeof index === "number") completedIndices.add(index);
		finals.push(image);
	}
	function acceptLine(): void {
		if (!line) {
			dispatch(); event = ""; data = []; eventBytes = 0; touched = false;
		} else {
			const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
			let value = colon < 0 ? "" : line.slice(colon + 1);
			if (value.startsWith(" ")) value = value.slice(1);
			if (field === "event") event = value;
			if (field === "data") data.push(value);
			line = "";
		}
	}
	function eventBudget(bytes: number): void {
		eventBytes += bytes;
		if (eventBytes > MAX_SSE_EVENT_BYTES) return fail("图片 SSE 单事件超过 32 MiB 上限。");
	}
	function text(value: string): void {
		let start = 0;
		// CR 立即交付整行（迟到错误前仍保留 usage）；跨块 LF 计入原事件而非新事件。
		if (skipLf && value.length) {
			skipLf = false;
			if (value[0] === "\n") {
				if (previousCrEventBytes === undefined) eventBudget(1);
				else if (previousCrEventBytes + 1 > MAX_SSE_EVENT_BYTES) return fail("图片 SSE 单事件超过 32 MiB 上限。");
				start = 1;
			}
			previousCrEventBytes = undefined;
		}
		while (start < value.length) {
			const cr = value.indexOf("\r", start), lf = value.indexOf("\n", start);
			const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
			const part = value.slice(start, end < 0 ? value.length : end);
			eventBudget(Buffer.byteLength(part, "utf8") + (end < 0 ? 0 : 1));
			touched = true; line += part;
			if (end < 0) return;
			start = end + 1;
			if (value[end] === "\r") {
				if (start === value.length) {
					previousCrEventBytes = line ? undefined : eventBytes;
					acceptLine(); skipLf = true; return;
				}
				if (value[start] === "\n") { eventBudget(1); start++; }
			}
			acceptLine();
		}
	}
	function decodeLines(bytes: Uint8Array): void {
		// 逐行交给严格 UTF-8 解码器：同一网络 chunk 的后续坏字节不能抹掉先前完成事件的 usage。
		let start = 0, cr = bytes.indexOf(13), lf = bytes.indexOf(10);
		while (start < bytes.length) {
			const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
			const next = end < 0 ? bytes.length : end + 1;
			text(decoder.decode(bytes.subarray(start, next), { stream: true })); start = next;
			// 两种分隔符的游标各自只前进，避免仅 LF 的多行事件反复扫描剩余整块。
			if (end >= 0 && end === cr) cr = bytes.indexOf(13, next);
			if (end >= 0 && end === lf) lf = bytes.indexOf(10, next);
		}
	}
	try {
		while (true) {
			const item = await abortable(signal, () => reader.read());
			if (item.done) { complete = true; break; }
			const available = budget - totalBytes;
			decodeLines(item.value.subarray(0, available));
			totalBytes += item.value.byteLength;
			if (totalBytes > budget) return fail("图片流式响应超过读取预算上限。");
		}
		text(decoder.decode());
		if (touched || line || data.length || event) return fail("图片 SSE 事件意外截断。");
		if (finals.length !== expected.count) return fail("图片流式响应未完成全部图片。");
		return finals;
	} catch (error) {
		if (signal.aborted) throw signal.reason;
		if (error instanceof ImageFailure) throw error;
		throw new ImageFailure("图片流式响应读取失败或 UTF-8 无效。");
	} finally {
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
