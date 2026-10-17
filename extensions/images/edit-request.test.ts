import assert from "node:assert/strict";
import test from "node:test";
import type { ImageApi, ImageModel } from "@earendil-works/pi-ai";
import { generateImages } from "./adapter.ts";
import { IMAGE_API, IMAGE_MODEL_IDS } from "./models.ts";
import { createImageRequest, serializeImageRequest } from "./request.ts";
import type { ImageFormat, TsgwImagesContext } from "./parameters.ts";
import { ImageFailure } from "./response.ts";
import { REAL_IMAGE_FIXTURES } from "./image-fixtures.test.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const DATA = `data:image/png;base64,${PNG}`;
const ID = IMAGE_MODEL_IDS[1];
const selected: ImageModel<ImageApi> = { type: "image", id: ID, name: ID, provider: "tsgw", api: IMAGE_API,
	baseUrl: "https://gateway.example/v1/", input: ["text", "image"], output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const prompt = () => [{ type: "text" as const, text: "编辑参考图" }];
const ctx = (tsgw: TsgwImagesContext["tsgw"] = {}): TsgwImagesContext => ({ input: prompt(), tsgw });
function frozen<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
	return value;
}
function mockFetch(raw: unknown = { data: [{ b64_json: PNG }] }) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init: init! }); return new Response(JSON.stringify(raw));
	};
	return { calls, fetch };
}
// 成功路径使用已由独立编码器/解码器核验的图片，避免只有伪造必要头。
function container(format: ImageFormat): string {
	if (format === "png") return PNG;
	const fixture = REAL_IMAGE_FIXTURES.find(item => item.format === format);
	assert.ok(fixture);
	return fixture.data;
}

test("默认生成 payload 明确默认值，非流式不发送 partial_images、未设置压缩和身份字段", () => {
	const request = createImageRequest(frozen(ctx()), ID);
	assert.equal(request.operation, "generate");
	assert.deepEqual(request.payload, { model: ID, prompt: "编辑参考图", quality: "auto", size: "auto", background: "auto",
		output_format: "png", n: 1, moderation: "auto", stream: false });
	assert.deepEqual(serializeImageRequest(request.payload, ID, request.operation).expected,
		{ count: 1, format: "png", stream: false, operation: "generate" });
});

test("编辑 JSON 支持 URL/file_id/data 引用与第一张蒙版；冻结输入不变", () => {
	const context = frozen(ctx({ operation: "edit", images: [{ image_url: DATA }, { file_id: "file-second" },
		{ image_url: "https://images.example/reference.png" }], mask: { image_url: DATA }, quality: "high", size: "1024x1024",
		background: "transparent", output_format: "webp", output_compression: 72, n: 3, moderation: "low", stream: true,
		partial_images: 2, safety_identifier: "safe-id", user: "old-user" }));
	const snapshot = JSON.stringify(context), request = createImageRequest(context, ID);
	assert.equal(request.operation, "edit"); assert.equal(JSON.stringify(context), snapshot);
	assert.deepEqual(request.payload, { model: ID, prompt: "编辑参考图", images: context.tsgw!.images, mask: context.tsgw!.mask,
		quality: "high", size: "1024x1024", background: "transparent", output_format: "webp", output_compression: 72,
		n: 3, moderation: "low", stream: true, partial_images: 2, safety_identifier: "safe-id", user: "old-user" });
	const serialized = serializeImageRequest(request.payload, ID, "edit");
	assert.deepEqual(serialized.expected, { count: 3, format: "webp", stream: true, operation: "edit" });
	assert.deepEqual(JSON.parse(serialized.body), request.payload);
});

test("原生图片块自动编辑并转原始 data URI，参考图数量 1..16；不受 metadata 控制", async () => {
	for (const format of ["png", "jpeg", "webp"] as const) {
		const data = container(format), input = frozen([...prompt(), { type: "image" as const, data, mimeType: `image/${format}` }]);
		const request = createImageRequest({ input }, ID);
		assert.equal(request.operation, "edit"); assert.deepEqual(request.payload.images, [{ image_url: `data:image/${format};base64,${data}` }]);
	}
	const h = mockFetch();
	const context = frozen(ctx({ images: Array.from({ length: 16 }, (_, n) => ({ file_id: `file-${n}` })) }));
	assert.equal((await generateImages(selected, context, { apiKey: "fake-key", fetch: h.fetch, metadata: { operation: "generate", n: 10 } })).stopReason, "stop");
	assert.equal(h.calls.length, 1); assert.equal(h.calls[0].url, "https://gateway.example/v1/images/edits");
	assert.equal(JSON.parse(String(h.calls[0].init.body)).images.length, 16);
	assert.equal(JSON.parse(String(h.calls[0].init.body)).n, 1);
});

test("生成/编辑输入组合、双重参考图、假 MIME、空文本和参考图上限在出网前失败", async () => {
	const native = { type: "image" as const, data: PNG, mimeType: "image/png" };
	const contexts: TsgwImagesContext[] = [ctx({ operation: "edit" }), ctx({ mask: { image_url: DATA } }),
		ctx({ operation: "generate", images: [{ file_id: "file-id" }] }), ctx({ operation: "generate", mask: { file_id: "mask" } }),
		{ input: [...prompt(), native], tsgw: { operation: "generate" } },
		{ input: [...prompt(), native], tsgw: { images: [{ file_id: "file-id" }] } },
		{ input: [...prompt(), { ...native, mimeType: "image/jpeg" }] },
		{ input: [...prompt(), { ...native, data: "bad-base64" }] }, { input: [native] },
		{ input: [...prompt(), { type: "text", text: "" }] },
		{ input: [...prompt(), ...Array(17).fill(native)] },
		ctx({ images: [{ image_url: DATA }], mask: { image_url: `data:image/jpeg;base64,${container("jpeg")}` } })];
	for (const context of contexts) {
		const h = mockFetch(), result = await generateImages(selected, frozen(context), { apiKey: "fake-key", fetch: h.fetch });
		assert.equal(result.stopReason, "error"); assert.equal(h.calls.length, 0); assert.deepEqual(result.output, []);
	}
});

test("本地可检查的蒙版须匹配第一张图尺寸/格式并有 alpha；远程引用不下载验证", () => {
	const modified = (width: number, color: number) => {
		const bytes = Buffer.from(PNG, "base64"); bytes.writeUInt32BE(width, 16); bytes[25] = color;
		let crc = 0xffffffff;
		for (const byte of bytes.subarray(12, 29)) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		bytes.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
		return `data:image/png;base64,${bytes.toString("base64")}`;
	};
	for (const mask of [modified(2, 4), modified(1, 0)]) {
		assert.throws(() => createImageRequest(ctx({ images: [{ image_url: DATA }], mask: { image_url: mask } }), ID), ImageFailure);
	}
	assert.equal(createImageRequest(ctx({ images: [{ file_id: "first" }], mask: { file_id: "mask" } }), ID).operation, "edit");
	assert.equal(createImageRequest(ctx({ images: [{ image_url: DATA }], mask: { image_url: "https://images.example/mask.png" } }), ID).operation, "edit");
});

test("最终序列化不信任 toJSON/getter；当前模型和端点固定，非目标 hook 字段保留", () => {
	const generation = createImageRequest(ctx(), ID), edit = createImageRequest(ctx({ images: [{ file_id: "first" }] }), ID);
	for (const [operation, payload] of [["generate", generation.payload], ["edit", edit.payload]] as const) {
		for (const extra of [{ model: IMAGE_MODEL_IDS[0] }, { operation: "edit" }, { image: "raw" }, { response_format: "url" },
			{ style: "vivid" }, { input_fidelity: "high" }, { stream: true, partial_images: 4 }, { n: 0 }, { output_format: "gif" },
			{ output_format: "jpeg", background: "transparent" }, { output_compression: 30 }]) {
			assert.throws(() => serializeImageRequest({ ...payload, ...extra }, ID, operation), ImageFailure);
		}
		assert.throws(() => serializeImageRequest({ ...payload, toJSON: () => ({ ...payload, model: "other-model" }) }, ID, operation), ImageFailure);
		const changed = { ...payload, n: 2, output_format: "webp", custom_hook_data: { keep: true } };
		const serialized = serializeImageRequest(frozen(changed), ID, operation);
		assert.deepEqual(JSON.parse(serialized.body), changed);
		assert.deepEqual(serialized.expected, { count: 2, format: "webp", stream: false, operation });
	}
	for (const extra of [{ images: [{ file_id: "id" }] }, { images: null }, { mask: { file_id: "mask" } }]) {
		assert.throws(() => serializeImageRequest({ ...generation.payload, ...extra }, ID, "generate"), ImageFailure);
	}
	for (const images of [undefined, null, [], Array(17).fill({ file_id: "id" })]) {
		assert.throws(() => serializeImageRequest({ ...edit.payload, images }, ID, "edit"), ImageFailure);
	}
	const getter = { ...generation.payload, get n() { return 2; } };
	const serialized = serializeImageRequest(getter, ID, "generate");
	assert.equal(serialized.expected.count, JSON.parse(serialized.body).n);
});

test("多张与三种输出格式按最终 hook 值解析，不固定单张 PNG；坏图仍保留 usage", async () => {
	for (const format of ["png", "jpeg", "webp"] as const) {
		for (const operation of ["generate", "edit"] as const) {
			const data = container(format), h = mockFetch({ data: [{ b64_json: data }, { b64_json: data }], output_format: format });
			const context = ctx(operation === "edit" ? { operation, images: [{ file_id: "first" }] } : { operation });
			const result = await generateImages(frozen(selected), frozen(context), { apiKey: "fake-key", fetch: h.fetch,
				onPayload: payload => frozen({ ...payload as object, n: 2, output_format: format, ...(format === "png" ? {} : { output_compression: 0 }) }) });
			assert.equal(result.stopReason, "stop", format); assert.equal(result.output.length, 2);
			assert.deepEqual(result.output, Array(2).fill({ type: "image", mimeType: `image/${format}`, data }));
			assert.equal(h.calls.length, 1); assert.ok(h.calls[0].url.endsWith(operation === "edit" ? "/images/edits" : "/images/generations"));
		}
	}
	for (const data of [[{ b64_json: PNG }], [{ b64_json: PNG }, { b64_json: "broken" }]]) {
		const h = mockFetch({ data, usage: { input_tokens: 3, output_tokens: 5 } });
		const result = await generateImages(selected, ctx({ n: 2, images: [{ file_id: "first" }] }), { apiKey: "fake-key", fetch: h.fetch });
		assert.equal(result.stopReason, "error"); assert.deepEqual(result.output, []); assert.equal(result.usage?.totalTokens, 8);
		assert.equal(h.calls.length, 1);
	}
});

test("编辑流式请求跟随最终 stream 值；SSE 只交付 completed 并保留有效 usage", async () => {
	const calls: RequestInit[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		calls.push(init!);
		return new Response(`event: image_edit.partial_image\ndata: ${JSON.stringify({ type: "image_edit.partial_image", partial_image_index: 0, b64_json: PNG })}\n\n` +
			`event: image_edit.completed\ndata: ${JSON.stringify({ type: "image_edit.completed", b64_json: PNG, usage: { input_tokens: 2, output_tokens: 4 } })}\n\n`,
			{ headers: { "Content-Type": "text/event-stream" } });
	};
	const result = await generateImages(selected, frozen(ctx({ images: [{ image_url: DATA }] })), {
		apiKey: "fake-key", fetch, onPayload: payload => {
			assert.equal((payload as Record<string, unknown>).stream, false);
			return frozen({ ...payload as object, stream: true, partial_images: 1 });
		},
	});
	assert.equal(result.stopReason, "stop"); assert.equal(result.output.length, 1); assert.equal(result.usage?.totalTokens, 6);
	assert.equal(calls.length, 1); assert.equal(JSON.parse(String(calls[0].body)).partial_images, 1);
});

test("编辑请求的 hook 不能转生成端点，不下载图片 URL，不在错误中泄漏引用", async () => {
	const secretUrl = "https://images.example/private.png?token=secret-value";
	for (const onPayload of [() => { throw new Error(secretUrl); },
		(payload: unknown) => ({ ...payload as object, images: undefined }),
		(payload: unknown) => ({ ...payload as object, image: secretUrl }),
		(payload: unknown) => ({ ...payload as object, toJSON: () => ({ ...payload as object, images: [] }) })]) {
		const h = mockFetch();
		const result = await generateImages(selected, ctx({ images: [{ image_url: secretUrl }] }), { apiKey: "fake-key", fetch: h.fetch, onPayload });
		assert.equal(result.stopReason, "error"); assert.equal(h.calls.length, 0);
		assert.doesNotMatch(result.errorMessage!, /images\.example|secret-value|private\.png/);
	}
	const caller = new AbortController(); caller.abort(); const h = mockFetch();
	const result = await generateImages(selected, ctx({ images: [{ image_url: secretUrl }] }), { signal: caller.signal, apiKey: "fake-key", fetch: h.fetch });
	assert.equal(result.stopReason, "aborted"); assert.equal(h.calls.length, 0);
});
