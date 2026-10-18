import assert from "node:assert/strict";
import test from "node:test";
import { ImageFailure, inspectImage } from "./image-data.ts";
import { PNG, REAL_IMAGE_FIXTURES, jpegContainer, pngChunk, pngContainer, webpChunk, webpContainer, webpRiff } from "./image-fixtures.test.ts";

const b64 = (bytes: Buffer) => bytes.toString("base64");
const inspect = (bytes: Buffer) => inspectImage(b64(bytes));
const reject = (bytes: Buffer) => assert.throws(() => inspect(bytes), ImageFailure);
function changed(bytes: Buffer, offset: number, value: number): Buffer {
	const copy = Buffer.from(bytes); copy[offset] = value; return copy;
}

test("三格式元数据保持原始 base64；PNG CRC 与透明通道、tRNS 均验证", () => {
	assert.deepEqual(inspectImage(PNG), { data: PNG, mimeType: "image/png", width: 1, height: 1, hasAlpha: true });
	for (const color of [0, 2, 3, 4, 6]) {
		for (const transparency of [false, true]) {
			if (transparency && [4, 6].includes(color)) continue;
			const bytes = pngContainer(11, 9, color, transparency), result = inspect(bytes);
			assert.equal(result.width, 11); assert.equal(result.height, 9);
			assert.equal(result.hasAlpha, transparency || color === 4 || color === 6);
			reject(changed(bytes, bytes.length - 1, bytes.at(-1)! ^ 1));
		}
	}
	for (const bytes of [pngContainer(), jpegContainer(), jpegContainer(2, 3, true), webpContainer(), webpContainer(2, 3, false)]) {
		assert.equal(inspect(bytes).data, b64(bytes));
	}
});

test("Pillow 编码并实际解码核验的 RGB 基线/渐进 JPEG、RGB 有损及 RGBA 无损/有损 WebP", () => {
	for (const fixture of REAL_IMAGE_FIXTURES) {
		assert.equal(Buffer.from(fixture.data, "base64").length, fixture.bytes, fixture.name);
		assert.deepEqual(inspectImage(fixture.data, fixture.format), {
			data: fixture.data, mimeType: `image/${fixture.format}`, width: 3, height: 2, hasAlpha: fixture.hasAlpha,
		}, fixture.name);
		const bytes = Buffer.from(fixture.data, "base64");
		reject(bytes.subarray(0, -1)); reject(Buffer.concat([bytes, Buffer.from([0])]));
	}
});

test("canonical base64 与格式一致性；不接受 URL、data URI、空值或容器尾部垃圾", () => {
	for (const value of [null, {}, 1, "", "not base64!", PNG + "\n", PNG.replace(/=$/, ""), PNG.replace(/I=$/, "J="),
		`data:image/png;base64,${PNG}`, "https://example.test/image.png"]) assert.throws(() => inspectImage(value), ImageFailure);
	for (const bytes of [pngContainer(), jpegContainer(), webpContainer()]) {
		for (let end = 0; end < bytes.length; end++) reject(bytes.subarray(0, end));
		reject(Buffer.concat([bytes, Buffer.from([0])]));
	}
	assert.throws(() => inspectImage(PNG, "jpeg"), /格式/);
	assert.throws(() => inspectImage(b64(jpegContainer()), "webp"), /格式/);
});

test("PNG 块长度、必要头、CRC、重复 IHDR、索引色调色板和尺寸边界", () => {
	const bytes = pngContainer(), signature = bytes.subarray(0, 8), header = bytes.subarray(8, 33);
	for (const value of [changed(bytes, 8, 255), changed(bytes, 12, 0), changed(bytes, 16, 0xff),
		pngContainer(0, 1), pngContainer(1, 0), pngContainer(0x80000000, 1),
		Buffer.concat([signature, header, header, bytes.subarray(33)]),
		Buffer.concat([signature, header, pngChunk("IEND", Buffer.alloc(0))]),
		Buffer.concat([signature, header, pngChunk("ABCD", Buffer.from([1])), bytes.subarray(33)]),
		Buffer.concat([signature, header, pngChunk("tRNS", Buffer.alloc(6)), bytes.subarray(33)])]) reject(value);
	const indexed = pngContainer(1, 1, 3);
	reject(Buffer.concat([indexed.subarray(0, 33), indexed.subarray(48)]));
	const meta = inspect(pngContainer(10000, 9000));
	assert.equal(meta.width, 10000); assert.equal(meta.height, 9000); // 输入元数据不施加输出限制。
});

test("JPEG 顺序/渐进扫描、APP、转义和 restart；缺段、零尺寸、坏长度/必要表不通过", () => {
	for (const progressive of [false, true]) {
		const bytes = jpegContainer(321, 123, progressive), result = inspect(bytes);
		assert.equal(result.mimeType, "image/jpeg"); assert.equal(result.width, 321); assert.equal(result.height, 123);
		assert.equal(result.hasAlpha, false);
		for (const bad of [changed(bytes, 0, 0), changed(bytes, 4, 255), jpegContainer(0, 1), jpegContainer(1, 0),
			Buffer.concat([bytes.subarray(0, 2), bytes.subarray(71)]), // 删除量化表。
			Buffer.concat([bytes.subarray(0, 71), bytes.subarray(111)]), // 删除 Huffman 表。
			Buffer.from([255, 216, 255, 217])]) reject(bad);
	}
	assert.equal(inspect(jpegContainer(65535, 65535)).height, 65535);
});

test("WebP VP8/VP8L/VP8X 容器尺寸与 alpha；不解码像素、不把动画画布当静态图", () => {
	for (const lossless of [false, true]) for (const alpha of [false, true]) for (const extended of [false, true]) {
		const result = inspect(webpContainer(3, 2, lossless, alpha, extended));
		assert.equal(result.mimeType, "image/webp"); assert.equal(result.width, 3); assert.equal(result.height, 2);
		assert.equal(result.hasAlpha, alpha);
	}
	const lossless = webpContainer(), lossy = webpContainer(1, 1, false), extended = webpContainer(2, 3, true, true, true);
	for (const bad of [changed(lossless, 4, 0), changed(lossless, 16, 255), changed(lossless, 20, 0),
		changed(lossless, 24, 0xe0), changed(lossy, 20, 0x31), changed(lossy, 23, 0), changed(lossy, lossy.length - 1, 1),
		changed(extended, 20, 18), changed(extended, 21, 1), changed(extended, 24, 0), changed(extended, 20, 0),
		webpRiff(webpChunk("VP8X", Buffer.alloc(10))),
		webpRiff(webpChunk("ANIM", Buffer.alloc(6)), lossless.subarray(12)),
		webpRiff(lossless.subarray(12), lossless.subarray(12)),
		webpRiff(webpChunk("ALPH", Buffer.from([0, 0])), lossy.subarray(12))]) reject(bad);
	assert.equal(inspect(webpContainer(16000, 12000)).width, 16000);
});
