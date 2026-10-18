import assert from "node:assert/strict";
import test from "node:test";
import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { ImageFailure, MAX_RESPONSE_BYTES, abortable, parseImage, parseImages, parseUsage, readJson } from "./response.ts";
import { PNG, REAL_IMAGE_FIXTURES, jpegContainer, pngContainer, webpContainer } from "./image-fixtures.test.ts";
import type { ImageFormat } from "./parameters.ts";

const signal = () => new AbortController().signal;
const selected: ImageModel<ImageApi> = { type: "image", id: "test", name: "test", provider: "test", api: "openai-images",
	baseUrl: "https://example.test", input: ["text"], output: ["image"],
	cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3, tiers: [{ inputTokensAbove: 9, input: 4, output: 16, cacheRead: 1, cacheWrite: 6 }] } };

test("parseImages 恰好 n 张 PNG/JPEG/WebP，保留原始数据及 MIME，旧 parseImage 保持单 PNG", () => {
	for (const { format, data } of [{ format: "png", data: PNG }, ...REAL_IMAGE_FIXTURES] as const) {
		const width = format === "png" ? 1 : 3, height = format === "png" ? 1 : 2;
		const raw = { data: [{ b64_json: data }, { b64_json: data }], output_format: format, size: `${width}x${height}` };
		assert.deepEqual(parseImages(raw, 2, format), Array.from({ length: 2 }, () => ({ type: "image", data, mimeType: `image/${format}` })));
		assert.equal(parseImages({ data: [{ b64_json: data, width, height, mime_type: `image/${format}` }] }, 1, format).length, 1);
	}
	assert.equal(parseImage({ data: [{ b64_json: PNG }] }), PNG);
});

test("声明格式/尺寸冲突、数量、URL、过大像素、坏 base64 均安全失败", () => {
	const raw = { data: [{ b64_json: PNG }] };
	for (const bad of [null, {}, { data: [] }, { data: [null] }, { data: [{ url: "https://example.test/a.png" }] },
		{ data: [{ b64_json: PNG }, { b64_json: PNG }] }, { ...raw, output_format: "jpeg" }, { ...raw, size: "2x2" },
		{ ...raw, width: 2 }, { data: [{ b64_json: PNG, height: 2 }] }, { data: [{ b64_json: PNG, output_format: "webp" }] },
		{ data: [{ b64_json: PNG, mime_type: "image/jpeg" }] }]) assert.throws(() => parseImages(bad, 1, "png"), ImageFailure);
	for (const count of [0, -1, 1.1, 11, NaN]) assert.throws(() => parseImages(raw, count, "png"), ImageFailure);
	assert.throws(() => parseImages(raw, 1, "gif" as ImageFormat), ImageFailure);
	assert.throws(() => parseImages({ data: [{ b64_json: "A".repeat(MAX_RESPONSE_BYTES + 4) }, { b64_json: PNG }] }, 2, "png"), /单张.*32 MiB/);
	for (const format of ["jpeg", "webp"] as const) assert.throws(() => parseImages(raw, 1, format), ImageFailure);
	for (const dimensions of [[3856, 1], [3840, 2176], [1, 3856]]) {
		for (const [format, bytes] of [["png", pngContainer(...dimensions as [number, number])],
			["jpeg", jpegContainer(...dimensions as [number, number])], ["webp", webpContainer(...dimensions as [number, number])]] as const) {
			assert.throws(() => parseImages({ data: [{ b64_json: bytes.toString("base64") }] }, 1, format), /3840/);
		}
	}
	assert.equal(parseImages({ data: [{ b64_json: pngContainer(3840, 2160).toString("base64") }] }, 1, "png").length, 1);
});

test("readJson 默认 32 MiB，可指定预算，严格 UTF-8，超限取消且释放锁", async () => {
	assert.equal(MAX_RESPONSE_BYTES, 32 * 1024 * 1024);
	assert.deepEqual(await readJson(new Response('{"文本":"好"}'), signal()), { 文本: "好" });
	assert.equal(await readJson(new Response("0   "), signal(), 4), 0);
	for (const response of [new Response("0    "), new Response("0", { headers: { "content-length": "5" } })]) {
		await assert.rejects(readJson(response, signal(), 4), ImageFailure);
	}
	await assert.rejects(readJson(new Response("0", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }), signal()), /32 MiB/);
	for (const response of [new Response(new Uint8Array([255])), new Response("{"), new Response(null)]) {
		await assert.rejects(readJson(response, signal()), ImageFailure);
	}
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
	await assert.rejects(readJson(new Response(body), signal(), 4), ImageFailure);
	assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test("abortable 与 JSON 读取取消不等待不合作底层，迟到拒绝被观察", async () => {
	const c = new AbortController(), reason = new Error("测试取消");
	const pending = abortable(c.signal, () => new Promise((_, reject) => setTimeout(() => reject(new Error("迟到拒绝")), 10)));
	c.abort(reason); await assert.rejects(pending, error => error === reason);
	await assert.rejects(abortable(c.signal, () => { throw new Error("不应调用"); }), error => error === reason);
	const stalled = new AbortController(); let cancelled = false;
	const body = new ReadableStream<Uint8Array>({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; return new Promise(() => {}); } });
	const read = readJson(new Response(body), stalled.signal);
	stalled.abort(reason); await assert.rejects(read, error => error === reason);
	assert.equal(cancelled, true); assert.equal(body.locked, false);
});

test("parseUsage 保持缓存包含写入、tier 阈值、无效数字不伪造 usage 的原语义", () => {
	const raw = { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 1 } } };
	const usage = parseUsage(raw, selected)!;
	assert.equal(usage.input, 6); assert.equal(usage.output, 2); assert.equal(usage.cacheRead, 3); assert.equal(usage.cacheWrite, 1);
	assert.equal(usage.totalTokens, 12); assert.equal(usage.cost.input, 4 / 1e6 * 6);
	assert.equal(parseUsage({ usage: { input_tokens: 9, output_tokens: 0 } }, selected)!.cost.input, 2 / 1e6 * 9);
	for (const bad of [{ input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 },
		{ input_tokens: 1, output_tokens: 2, total_tokens: 2 }, { input_tokens: 1, output_tokens: Infinity },
		{ input_tokens: 1, output_tokens: 2, input_tokens_details: { cached_tokens: 2 } },
		{ input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 } },
		{ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }]) assert.equal(parseUsage({ usage: bad }, selected), undefined);
	assert.equal(parseUsage({}, selected), undefined);
});
