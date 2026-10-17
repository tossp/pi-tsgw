import type { ImageApi, ImageContent, ImageModel, Usage } from "@earendil-works/pi-ai";
import { ImageFailure, inspectImage, type ImageFormat, type InspectedImage } from "./image-data.ts";

export { ImageFailure } from "./image-data.ts";
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

// race 会观察迟到的拒绝；即使自定义 fetch 或钩子不响应 signal，也及时结束等待。
export async function abortable<T>(signal: AbortSignal, action: () => T | PromiseLike<T>): Promise<T> {
	signal.throwIfAborted();
	let listener: () => void = () => {};
	const cancelled = new Promise<never>((_, reject) => {
		listener = () => reject(signal.reason);
		signal.addEventListener("abort", listener, { once: true });
	});
	try {
		return await Promise.race([Promise.resolve().then(() => {
			signal.throwIfAborted();
			return action();
		}), cancelled]);
	} finally {
		signal.removeEventListener("abort", listener);
	}
}

export async function readJson(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<unknown> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new ImageFailure("图片响应预算无效。");
	const length = response.headers.get("content-length");
	if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
		throw new ImageFailure(`图片响应超过 ${maxBytes / 1024 / 1024} MiB 读取预算上限。`);
	}
	if (!response.body) throw new ImageFailure("图片响应为空。");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let size = 0;
	let complete = false;
	try {
		while (true) {
			const item = await abortable(signal, () => reader.read());
			if (item.done) { complete = true; break; }
			size += item.value.byteLength;
			if (size > maxBytes) throw new ImageFailure(`图片响应超过 ${maxBytes / 1024 / 1024} MiB 读取预算上限。`);
			chunks.push(Buffer.from(item.value));
		}
		try {
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
		} catch {
			throw new ImageFailure("图片响应不是有效 JSON。");
		}
	} finally {
		// 不等待可能永不完成的自定义底层 cancel，同时观察其拒绝。
		if (!complete) void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function declaredMetadata(raw: Record<string, unknown>, image: InspectedImage, format: ImageFormat): void {
	if (raw.output_format !== undefined && raw.output_format !== format) throw new ImageFailure("图片声明格式与字节不一致。");
	if (raw.size !== undefined && raw.size !== "auto" && raw.size !== `${image.width}x${image.height}`) {
		throw new ImageFailure("图片声明尺寸与字节不一致。");
	}
	if ((raw.width !== undefined && raw.width !== image.width) || (raw.height !== undefined && raw.height !== image.height) ||
		(raw.mime_type !== undefined && raw.mime_type !== image.mimeType)) throw new ImageFailure("图片声明元数据与字节不一致。");
}

export function parseImages(raw: unknown, count: number, format: ImageFormat): ImageContent[] {
	if (!Number.isInteger(count) || count < 1 || count > 10 || !["png", "jpeg", "webp"].includes(format) ||
		!record(raw) || !Array.isArray(raw.data) || raw.data.length !== count) {
		throw new ImageFailure("图片响应数量必须与请求一致，且只包含有效的 base64 图片。");
	}
	return raw.data.map(item => {
		if (!record(item)) throw new ImageFailure("图片响应缺少 base64 图片。");
		if (typeof item.b64_json === "string" && item.b64_json.length > MAX_RESPONSE_BYTES) {
			throw new ImageFailure("单张图片的 base64 响应超过 32 MiB 上限。");
		}
		const image = inspectImage(item.b64_json, format);
		if (image.width > 3840 || image.height > 3840 || image.width * image.height > 8_294_400) {
			throw new ImageFailure("图片单边不得超过 3840、总像素不得超过 8294400。");
		}
		declaredMetadata(raw, image, format); declaredMetadata(item, image, format);
		return { type: "image", data: image.data, mimeType: image.mimeType };
	});
}

// 兼容旧的单 PNG 调用方；绝不下载响应中的远程 URL。
export function parseImage(raw: unknown): string {
	return parseImages(raw, 1, "png")[0].data;
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseUsage(raw: unknown, model: ImageModel<ImageApi>): Usage | undefined {
	if (!record(raw) || !record(raw.usage)) return;
	const usage = raw.usage;
	if (!count(usage.input_tokens) || !count(usage.output_tokens)) return;
	const total = usage.input_tokens + usage.output_tokens;
	if (!count(total) || (usage.total_tokens !== undefined && usage.total_tokens !== total)) return;
	const details = usage.input_tokens_details;
	if (details !== undefined && !record(details)) return;
	const cached = record(details) ? details.cached_tokens : undefined;
	const write = record(details) ? details.cache_write_tokens : undefined;
	if ((cached !== undefined && !count(cached)) || (write !== undefined && !count(write))) return;
	const cacheWrite = write === undefined ? 0 : write as number;
	// 与 Pi 的缓存计数约定一致：cached_tokens 包含 cache_write_tokens。
	const allCached = cached === undefined ? cacheWrite : cached as number;
	if (cacheWrite > allCached || allCached > usage.input_tokens) return;
	const cacheRead = allCached - cacheWrite;
	const input = usage.input_tokens - allCached, output = usage.output_tokens;
	let rates = model.cost;
	let threshold = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (usage.input_tokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
			rates = tier; threshold = tier.inputTokensAbove;
		}
	}
	const cost = {
		input: rates.input / 1e6 * input, output: rates.output / 1e6 * output,
		cacheRead: rates.cacheRead / 1e6 * cacheRead, cacheWrite: rates.cacheWrite / 1e6 * cacheWrite, total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	if (Object.values(cost).some(value => !Number.isFinite(value) || value < 0)) return;
	return { input, output, cacheRead, cacheWrite, totalTokens: total, cost };
}
