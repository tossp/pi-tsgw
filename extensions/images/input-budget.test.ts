import assert from "node:assert/strict";
import test from "node:test";
import * as parameters from "./parameters.ts";
import { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUT_TOTAL_BYTES, imageReferenceInputBytes, normalizeImageReference } from "./parameters.ts";
import { createImageRequest, serializeImageRequest } from "./request.ts";
import type { ImageReference, TsgwImagesContext } from "./parameters.ts";
import { REAL_IMAGE_FIXTURES } from "./image-fixtures.test.ts";

const ID = "gpt-image-2.5-sunburst";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const context = (images: ImageReference[], mask?: ImageReference): TsgwImagesContext => ({
	input: [{ type: "text", text: "参考图编辑" }], tsgw: { operation: "edit", images, ...(mask ? { mask } : {}) },
});
function frozen<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
	return value;
}

/** 真实 JPEG 的首个 APP0 之后插入合法 COM 段，保留必要表和压缩像素。 */
function jpegData(bytes: number): string {
	const original = Buffer.from(REAL_IMAGE_FIXTURES[0].data, "base64");
	assert.ok(bytes >= original.length + 4);
	const prefixLength = 4 + original.readUInt16BE(4);
	const tail = original.subarray(prefixLength);
	const buffer = Buffer.alloc(bytes); original.copy(buffer, 0, 0, prefixLength);
	let offset = prefixLength;
	while (offset < bytes - tail.length) {
		const remaining = bytes - tail.length - offset;
		let chunk = Math.min(65_537, remaining);
		if (remaining > chunk && remaining - chunk < 4) chunk -= 4 - (remaining - chunk);
		assert.ok(chunk >= 4);
		buffer.writeUInt16BE(0xfffe, offset); buffer.writeUInt16BE(chunk - 2, offset + 2); offset += chunk;
	}
	tail.copy(buffer, offset);
	return buffer.toString("base64");
}
const reference = (data: string): ImageReference => Object.freeze({ image_url: `data:image/jpeg;base64,${data}` });

test("共享预算使用十进制字节，未发布草稿别名不再导出；padding 与远程引用计数准确", () => {
	assert.equal(MAX_IMAGE_INPUT_BYTES, 50_000_000); assert.equal(MAX_IMAGE_INPUT_TOTAL_BYTES, 100_000_000);
	assert.equal(Object.hasOwn(parameters, "imageParameters"), false);
	for (const bytes of [999, 1000, 1001]) {
		const ref = normalizeImageReference(reference(jpegData(bytes)));
		assert.equal(imageReferenceInputBytes(ref), bytes);
	}
	assert.equal(imageReferenceInputBytes(normalizeImageReference({ image_url: `data:image/png;base64,${PNG}` })), Buffer.byteLength(PNG, "base64"));
	for (const ref of [{ file_id: "id" }, { image_url: "https://images.example/reference.png" }]) {
		assert.equal(imageReferenceInputBytes(normalizeImageReference(ref)), 0);
	}
});

test("单图严格小于 50000000：上限减一接受，上限/加一拒绝；原生图片同样验证", () => {
	const below = reference(jpegData(MAX_IMAGE_INPUT_BYTES - 1));
	assert.equal(imageReferenceInputBytes(normalizeImageReference(below)), MAX_IMAGE_INPUT_BYTES - 1);
	for (const bytes of [MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUT_BYTES + 1]) {
		const data = jpegData(bytes), ref = reference(data);
		assert.throws(() => normalizeImageReference(ref), /必须小于 50000000 字节/);
		const input = frozen([{ type: "text" as const, text: "参考图编辑" }, { type: "image" as const, mimeType: "image/jpeg", data }]);
		assert.throws(() => createImageRequest({ input }, ID), /必须小于 50000000 字节/);
		assert.equal(input[1].data, data);
	}
});

test("参考图与原生图总预算按 decoded 字节：100000000 可用，加一失败，mask 也计入", () => {
	const data = jpegData(MAX_IMAGE_INPUT_TOTAL_BYTES / 16), ref = reference(data);
	const refs = frozen(Array.from({ length: 16 }, () => ref));
	const source = frozen(context(refs));
	const request = createImageRequest(source, ID);
	assert.equal(request.operation, "edit"); assert.equal((request.payload.images as ImageReference[]).length, 16);
	assert.notEqual(request.payload.images, refs); assert.equal(source.tsgw!.images, refs);
	const native = frozen([...source.input, ...Array.from({ length: 16 }, () => ({ type: "image" as const, mimeType: "image/jpeg", data }))]);
	assert.equal(createImageRequest({ input: native }, ID).operation, "edit");
	const more = reference(jpegData(MAX_IMAGE_INPUT_TOTAL_BYTES / 16 + 1));
	const overflow = frozen([more, ...refs.slice(1)]);
	assert.throws(() => createImageRequest(context(overflow), ID), /不得超过 100000000 字节/);
	const nativeOverflow = frozen([source.input[0], { type: "image" as const, mimeType: "image/jpeg", data: more.image_url!.split(",", 2)[1] }, ...native.slice(2)]);
	assert.throws(() => createImageRequest({ input: nativeOverflow }, ID), /不得超过 100000000 字节/);
	assert.throws(() => createImageRequest(context(refs, { image_url: `data:image/png;base64,${PNG}` }), ID), /不得超过 100000000 字节/);
	// 远程引用本身没有本地 decoded 字节，不下载或按 URL 字符串长度猜测图片大小。
	assert.equal(createImageRequest(context(refs, { file_id: "remote-mask" }), ID).operation, "edit");
});

test("最终序列化后的 hook/toJSON 不能扩大单图或总预算；不改变冻结 payload", () => {
	const small = createImageRequest(context([{ file_id: "first" }]), ID).payload;
	const data = jpegData(MAX_IMAGE_INPUT_BYTES), tooLarge = reference(data);
	const single = frozen({ ...small, images: [tooLarge], custom: { keep: true } });
	assert.throws(() => serializeImageRequest(single, ID, "edit"), /必须小于 50000000 字节/);
	assert.equal(single.images[0], tooLarge); assert.equal(single.custom.keep, true);
	const ref = reference(jpegData(MAX_IMAGE_INPUT_TOTAL_BYTES / 16));
	const changed = frozen({ ...small, toJSON: () => ({ ...small, images: Array(16).fill(ref), mask: { image_url: `data:image/png;base64,${PNG}` } }) });
	assert.throws(() => serializeImageRequest(changed, ID, "edit"), /不得超过 100000000 字节/);
	assert.equal(Reflect.get(changed, "images"), small.images);
});

test("未知参数和引用字段不流入请求，白名单重建保持 copy-on-write", () => {
	const ref = frozen({ file_id: "first", unexpected: "must-not-leak" });
	assert.throws(() => createImageRequest(context([ref]), ID), /图片引用无效/);
	assert.throws(() => serializeImageRequest({ model: ID, prompt: "编辑", images: [ref] }, ID, "edit"), /图片引用无效/);
	const source = frozen({ ...context([{ file_id: "first" }]), unrelated_context_field: "must-not-leak" });
	const request = createImageRequest(source, ID);
	assert.equal(Object.hasOwn(request.payload, "unrelated_context_field"), false);
	assert.equal(source.unrelated_context_field, "must-not-leak");
});
