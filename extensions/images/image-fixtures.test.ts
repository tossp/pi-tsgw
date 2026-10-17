import { deflateSync } from "node:zlib";

export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
// 以下固定真图为本地生成的 3x2 RGB/RGBA 六色图片，无外部图片输入。
// Pillow 11.1.0（JPEG 6.2 / WebP 1.5.0）编码后重新 open + load 核验尺寸/模式，
// RGBA 同时逐字节核验 alpha，无损 WebP 还核验全部像素；运行测试不依赖 Pillow。
// JPEG quality=83/subsampling=0；WebP method=6，有损 quality=80，无损 quality=100/exact=true。
export const REAL_IMAGE_FIXTURES = [
	{ name: "JPEG_BASELINE", format: "jpeg", hasAlpha: false, bytes: 700,
		data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUEBAUEAwUFBAUGBgUGCA4JCAcHCBEMDQoOFBEVFBMRExMWGB8bFhceFxMTGyUcHiAhIyMjFRomKSYiKR8iIyL/2wBDAQYGBggHCBAJCRAiFhMWIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL/wAARCAACAAMDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDa/sjTnubzfYWjbbudRmFTgCVgB06AAAewr6PIa9WGVYblk1enB79XFNv1bbb7vU/NeNcXiKOe1406jivdeja1cItv1bbbfVtt6n//2Q==" },
	{ name: "JPEG_PROGRESSIVE", format: "jpeg", hasAlpha: false, bytes: 613,
		data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUEBAUEAwUFBAUGBgUGCA4JCAcHCBEMDQoOFBEVFBMRExMWGB8bFhceFxMTGyUcHiAhIyMjFRomKSYiKR8iIyL/2wBDAQYGBggHCBAJCRAiFhMWIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiL/wgARCAACAAMDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABP/EABUBAQEAAAAAAAAAAAAAAAAAAAUG/9oADAMBAAIQAxAAAAFqM1//xAAWEAADAAAAAAAAAAAAAAAAAAADEhP/2gAIAQEAAQUCkNv/xAAcEQABAwUAAAAAAAAAAAAAAAACAAEDBAURMbH/2gAIAQMBAT8BvUsgVxsJY1xl/8QAGxEAAgEFAAAAAAAAAAAAAAAAAQIEAAMRQrH/2gAIAQIBAT8BgOwi28HUcr//xAAaEAABBQEAAAAAAAAAAAAAAAACAAEiMkFh/9oACAEBAAY/AjgNnzq//8QAGBAAAgMAAAAAAAAAAAAAAAAAAREAMVH/2gAIAQEAAT8hcw6HXU//2gAMAwEAAgADAAAAEF//xAAYEQEBAAMAAAAAAAAAAAAAAAABIQBBcf/aAAgBAwEBPxBzAqKVZeqqu1Vuf//EABsRAQABBQEAAAAAAAAAAAAAAAERACExQVFx/9oACAECAQE/EJfCVztCvqqvW9f/xAAYEAEAAwEAAAAAAAAAAAAAAAABABExYf/aAAgBAQABPxDPc1pQEGYABwn/2Q==" },
	{ name: "WEBP_RGB_LOSSY", format: "webp", hasAlpha: false, bytes: 106,
		data: "UklGRmIAAABXRUJQVlA4IFYAAACwAwCdASoDAAIAAUAmJagCdLoB+AFGA+wCuAP4BlAH6AAt2ZouAAD5E8cUedfSwl6njU23D7JHT/5cSpNT/LQZaTQo/r5//InEoFH5OHSPbvP6ygAAAA==" },
	{ name: "WEBP_RGBA_LOSSLESS", format: "webp", hasAlpha: true, bytes: 66,
		data: "UklGRjoAAABXRUJQVlA4TC4AAAAvAkAAEAaCbBudkYz4JKN7BALEhBLZ6iQIBIgTJdqViBEIEGvSpDkTH6LbRB0P" },
	{ name: "WEBP_RGBA_LOSSY", format: "webp", hasAlpha: true, bytes: 140,
		data: "UklGRoQAAABXRUJQVlA4WAoAAAAQAAAAAgAAAQAAQUxQSAcAAAAAAECAwP//AFZQOCBWAAAAMAMAnQEqAwACAAFAJiWoAnS6AfgBRgKoAyQD9AAW7WXUQAD896Cdf4j6MLz71kf12+J3/x2OLcpnwSHXUrlM/TS/+d/80RS9Q/q0Mz80RS9Q/4KgAAA=" },
] as const;

export function pngChunk(type: string, data: Buffer): Buffer {
	const bytes = Buffer.concat([Buffer.from(type), data]);
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
	length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
	return Buffer.concat([length, bytes, checksum]);
}
// 专门验证容器的合成夹具；大尺寸头不分配对应像素，也不声称可完整像素解码。
export function pngContainer(width = 1, height = 1, color = 6, transparent = false): Buffer {
	const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
	header[8] = 8; header[9] = color;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
		...(color === 3 ? [pngChunk("PLTE", Buffer.from([0, 0, 0]))] : []),
		...(transparent ? [pngChunk("tRNS", Buffer.alloc(color === 3 ? 1 : color === 0 ? 2 : 6))] : []),
		pngChunk("IDAT", deflateSync(Buffer.alloc(5))), pngChunk("IEND", Buffer.alloc(0))]);
}
export function jpegSegment(marker: number, data: Buffer): Buffer {
	const head = Buffer.from([255, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2);
	return Buffer.concat([head, data]);
}
export function jpegContainer(width = 1, height = 1, progressive = false): Buffer {
	const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
	frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3);
	const scan = jpegSegment(0xda, Buffer.from([1, 1, 0, 0, progressive ? 0 : 63, 0]));
	const huffman = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0]),
		Buffer.from([0x10, 1]), Buffer.alloc(15), Buffer.from([0])]);
	return Buffer.concat([Buffer.from([255, 216]), jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
		jpegSegment(0xc4, huffman), jpegSegment(progressive ? 0xc2 : 0xc0, frame), scan,
		Buffer.from([0x11, 255, 0, 0x22, 255, 208, 0x33]),
		...(progressive ? [scan, Buffer.from([0x44])] : []), Buffer.from([255, 217])]);
}
export function webpChunk(type: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8); head.write(type, 0, "latin1"); head.writeUInt32LE(data.length, 4);
	return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
}
export function webpRiff(...chunks: Buffer[]): Buffer {
	const body = Buffer.concat([Buffer.from("WEBP"), ...chunks]);
	const header = Buffer.from("RIFF\0\0\0\0", "latin1"); header.writeUInt32LE(body.length, 4);
	return Buffer.concat([header, body]);
}
export function webpContainer(width = 1, height = 1, lossless = true, alpha = false, extended = false): Buffer {
	let image: Buffer;
	if (lossless) {
		const payload = Buffer.alloc(6); payload[0] = 0x2f;
		payload.writeUInt32LE(((width - 1) | ((height - 1) << 14) | (alpha ? 0x10000000 : 0)) >>> 0, 1);
		image = webpChunk("VP8L", payload);
	} else {
		const payload = Buffer.from([0x30, 0, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0, 0]);
		payload.writeUInt16LE(width, 6); payload.writeUInt16LE(height, 8);
		image = webpChunk("VP8 ", payload);
	}
	const chunks: Buffer[] = [];
	if (extended || (!lossless && alpha)) {
		const header = Buffer.alloc(10); header[0] = alpha ? 16 : 0;
		header.writeUIntLE(width - 1, 4, 3); header.writeUIntLE(height - 1, 7, 3);
		chunks.push(webpChunk("VP8X", header));
		if (!lossless && alpha) chunks.push(webpChunk("ALPH", Buffer.alloc(1 + width * height)));
	}
	return webpRiff(...chunks, image);
}
