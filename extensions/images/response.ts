import type { ImageApi, ImageModel, Usage } from "@earendil-works/pi-ai";

export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

// 仅此类携带插件自行构造的安全错误；原始异常和服务端消息不进入结果。
export class ImageFailure extends Error {}

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

export async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
	const length = response.headers.get("content-length");
	if (length && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) {
		throw new ImageFailure("图片响应超过 32 MiB 上限。");
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
			if (size > MAX_RESPONSE_BYTES) throw new ImageFailure("图片响应超过 32 MiB 上限。");
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

const crcTable = Array.from({ length: 256 }, (_, n) => {
	for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
	return n >>> 0;
});

function validPng(data: string): boolean {
	if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return false;
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data || bytes.length < 57 ||
		!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
	let offset = 8;
	let idat = false;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset);
		const end = offset + 12 + length;
		if (end > bytes.length) return false;
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		if (!/^[A-Za-z]{4}$/.test(type)) return false;
		let crc = 0xffffffff;
		for (let i = offset + 4; i < end - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
		if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) return false;
		if (offset === 8) {
			if (type !== "IHDR" || length !== 13) return false;
			const width = bytes.readUInt32BE(offset + 8), height = bytes.readUInt32BE(offset + 12);
			const depth = bytes[offset + 16], color = bytes[offset + 17];
			const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
			// 返回值也受模型最大边长/像素约束，避免小压缩包触发宿主巨量像素解码。
			if (!width || !height || width > 3840 || height > 3840 || width * height > 8_294_400 || !depths[color]?.includes(depth) ||
				bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) return false;
		} else if (type === "IHDR") return false;
		if (type === "IDAT" && length > 0) idat = true;
		if (type === "IEND") return length === 0 && idat && end === bytes.length;
		offset = end;
	}
	return false;
}

export function parseImage(raw: unknown): string {
	if (!record(raw) || !Array.isArray(raw.data) || raw.data.length !== 1 || !record(raw.data[0]) ||
		typeof raw.data[0].b64_json !== "string" || !validPng(raw.data[0].b64_json)) {
		throw new ImageFailure("图片响应必须包含且仅包含一张有效的 base64 PNG 图片，单边不超过 3840、总像素不超过 8294400。");
	}
	// 只检查 PNG 容器、IHDR、各块 CRC 和 IEND，不解压或解码像素；绝不下载远程 URL。
	return raw.data[0].b64_json;
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
