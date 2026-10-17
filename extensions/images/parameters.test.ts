import assert from "node:assert/strict";
import test from "node:test";
import { ImageFailure } from "./response.ts";
import { normalizeImageParameters, normalizeImageReference, validSize } from "./parameters.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const DATA = `data:image/png;base64,${PNG}`;
const defaults = { quality: "auto", size: "auto", background: "auto", output_format: "png", n: 1,
	moderation: "auto", stream: false, partial_images: 0 };
function frozen<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
	return value;
}
const invalid = (value: unknown) => assert.throws(() => normalizeImageParameters(value), ImageFailure);

test("参数默认值完整；省略、undefined、API null 等价，冻结输入不改变", () => {
	for (const input of [undefined, null, {}, Object.create(null), frozen({ quality: null, size: undefined,
		background: null, output_format: null, n: null, moderation: null, stream: null, partial_images: null,
		output_compression: null, safety_identifier: null, user: null, images: null, mask: null, operation: null })]) {
		assert.deepEqual(normalizeImageParameters(input), defaults);
	}
	const input = frozen({ operation: "edit", images: [{ image_url: DATA }, { file_id: "file-123" }], mask: { image_url: DATA },
		quality: "max", size: "1024x1024", background: "transparent", output_format: "webp", output_compression: 0,
		n: 10, moderation: "low", stream: true, partial_images: 3, safety_identifier: "a".repeat(128), user: "old-user" });
	const before = JSON.stringify(input), result = normalizeImageParameters(input);
	assert.deepEqual(result, input); assert.equal(JSON.stringify(input), before);
	assert.notEqual(result.images, input.images); assert.notEqual(result.images![0], input.images[0]);
	assert.notEqual(result.mask, input.mask);
});

test("quality、background、format、n、compression、moderation 与 stream 的完整合法值", () => {
	for (const quality of ["auto", "low", "medium", "high", "xhigh", "max"]) assert.equal(normalizeImageParameters({ quality }).quality, quality);
	for (const background of ["auto", "opaque", "transparent"]) assert.equal(normalizeImageParameters({ background }).background, background);
	for (const output_format of ["png", "jpeg", "webp"]) assert.equal(normalizeImageParameters({ output_format }).output_format, output_format);
	for (let n = 1; n <= 10; n++) assert.equal(normalizeImageParameters({ n }).n, n);
	for (const output_format of ["jpeg", "webp"]) for (const output_compression of [0, 1, 50, 100]) {
		assert.equal(normalizeImageParameters({ output_format, output_compression }).output_compression, output_compression);
	}
	for (let partial_images = 0; partial_images <= 3; partial_images++) assert.equal(normalizeImageParameters({ stream: true, partial_images }).partial_images, partial_images);
	assert.equal(normalizeImageParameters({ user: "", safety_identifier: "" }).user, "");
});

test("size 边界：16 倍数、像素/比例/边长均独立检查", () => {
	for (const size of ["auto", "640x1024", "1024x640", "3840x2160", "2160x3840", "768x2304"]) {
		assert.equal(validSize(size), true, size); assert.equal(normalizeImageParameters({ size }).size, size);
	}
	for (const size of [null, 1024, "auto ", "1024X1024", "1024x1024\n", "01024x1024", "0x1024", "1025x1024",
		"640x1008", "640x1936", "3856x2048", "3840x2176", "3840x3840", "1e3x1024"]) {
		assert.equal(validSize(size), false, String(size)); if (size !== null) invalid({ size });
	}
});

test("未知、旧版、非普通对象、符号字段不静默丢弃", () => {
	for (const value of [[], "auto", 1, false, new Date(), Object.create({ quality: "high" }),
		{ [Symbol("quality")]: "high" }, { quality: "auto", unknown: true }, { response_format: "b64_json" },
		{ style: "vivid" }, { input_fidelity: "high" }, { standard: true }, { hd: true }, { toJSON() { return {}; } }]) invalid(value);
	let reads = 0;
	const source = Object.freeze(Object.defineProperty({}, "n", { enumerable: true, get() { reads++; return 2; } }));
	assert.equal(normalizeImageParameters(source).n, 2); assert.equal(reads, 1);
});

test("类型、枚举、整数范围和参数组合可靠拒绝", () => {
	for (const value of [{ quality: "hd" }, { quality: 1 }, { background: "none" }, { output_format: "jpg" }, { moderation: "off" },
		{ n: 0 }, { n: 11 }, { n: 1.5 }, { n: "1" }, { n: NaN }, { n: Infinity },
		{ output_compression: 50 }, { output_format: "jpeg", output_compression: -1 }, { output_format: "webp", output_compression: 101 },
		{ output_format: "jpeg", output_compression: 1.5 }, { output_format: "jpeg", output_compression: "50" },
		{ output_format: "jpeg", background: "transparent" }, { stream: 1 }, { stream: "true" },
		{ partial_images: 1 }, { stream: true, partial_images: 4 }, { stream: true, partial_images: -1 },
		{ stream: true, partial_images: 1.1 }, { safety_identifier: "x".repeat(129) }, { user: 1 },
		{ operation: "variation" }, { images: [] }, { images: Array(17).fill({ file_id: "x" }) }, { images: new Array(2) },
		{ images: {} }, { mask: [] }]) invalid(value);
});

test("图片引用唯一字段；仅 HTTP(S)/canonical 图片 data URI 或非空 file_id", () => {
	for (const source of [frozen({ image_url: DATA }), frozen({ file_id: "file-123" }), frozen({ image_url: "https://example.com/a?q=1" })]) {
		assert.deepEqual(normalizeImageReference(source), source);
	}
	assert.deepEqual(normalizeImageReference({ image_url: "HTTPS://EXAMPLE.COM" }), { image_url: "https://example.com/" });
	const invalidReferences = [null, [], {}, { path: "/tmp/a.png" }, { image_url: DATA, file_id: "id" },
		{ image_url: DATA, file_id: undefined }, { image_url: DATA, extra: 1 }, { file_id: "" }, { file_id: " " },
		{ file_id: 1 }, { file_id: "id\n" }, { image_url: "" }, { image_url: " https://example.com/a" },
		{ image_url: "https://user:pass@example.com/a" }, { image_url: "http://user@example.com" }, { image_url: "http://@example.com" },
		{ image_url: "file:///tmp/a.png" }, { image_url: "ftp://example.com/a" }, { image_url: "//example.com/a" },
		{ image_url: "https://example.com/\na" }, { image_url: "data:text/plain;base64,YQ==" },
		{ image_url: DATA + "\n" }, { image_url: DATA.replace("png", "jpeg") }, { image_url: DATA.replace(/=$/, "") },
		{ image_url: "data:image/png;base64,bm90LXBpY3R1cmU=" }, Object.create({ file_id: "id" })];
	for (const value of invalidReferences) assert.throws(() => normalizeImageReference(value), ImageFailure);
});
