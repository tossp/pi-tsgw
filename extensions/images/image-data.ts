// 仅检查容器、必要头和尺寸，不解压或解码像素；不保证压缩像素流可完整解码。
// 仅此类携带插件自行构造的安全错误；原始异常和服务端消息不进入结果。
export class ImageFailure extends Error {}
export type ImageFormat = "png" | "jpeg" | "webp";
export interface InspectedImage {
	data: string;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	width: number;
	height: number;
	hasAlpha: boolean;
}
type Dimensions = Pick<InspectedImage, "width" | "height" | "hasAlpha">;
const invalid = (): never => { throw new ImageFailure("图片不是有效的 canonical base64 PNG、JPEG 或 WebP 容器。"); };
const crcTable = Array.from({ length: 256 }, (_, n) => {
	for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
	return n >>> 0;
});

function png(bytes: Buffer): Dimensions {
	if (bytes.length < 57) return invalid();
	let offset = 8, idat = false, endedIdat = false, palette = 0, transparency = false;
	let width = 0, height = 0, color = -1, depth = 0;
	while (offset + 12 <= bytes.length) {
		const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
		if (length > 0x7fffffff || end > bytes.length) return invalid();
		const type = bytes.toString("latin1", offset + 4, offset + 8);
		if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()) return invalid();
		let crc = 0xffffffff;
		for (let i = offset + 4; i < end - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 255];
		if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(end - 4)) return invalid();
		const start = offset + 8;
		if (offset === 8) {
			if (type !== "IHDR" || length !== 13) return invalid();
			width = bytes.readUInt32BE(start); height = bytes.readUInt32BE(start + 4);
			depth = bytes[start + 8]; color = bytes[start + 9];
			const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
			if (!width || !height || width > 0x7fffffff || height > 0x7fffffff || !depths[color]?.includes(depth) ||
				bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] > 1) return invalid();
		} else if (type === "IHDR") return invalid();
		if (type === "PLTE") {
			if (palette || idat || transparency || color === 0 || color === 4 || !length || length % 3 || length > 768 ||
				(color === 3 && length / 3 > 2 ** depth)) return invalid();
			palette = length / 3;
		}
		if (type === "tRNS") {
			if (transparency || idat || !((color === 0 && length === 2) || (color === 2 && length === 6) ||
				(color === 3 && length > 0 && length <= palette))) return invalid();
			transparency = true;
		}
		if (type === "IDAT") {
			if (endedIdat || (color === 3 && !palette)) return invalid();
			if (length > 0) idat = true;
		} else if (idat) endedIdat = true;
		if (type === "IEND") {
			if (length || !idat || end !== bytes.length) return invalid();
			return { width, height, hasAlpha: color === 4 || color === 6 || transparency };
		}
		if (type[0] === type[0].toUpperCase() && !["IHDR", "PLTE", "IDAT"].includes(type)) return invalid();
		offset = end;
	}
	return invalid();
}

function jpeg(bytes: Buffer): Dimensions {
	let offset = 2, width = 0, height = 0, scan = false, entropy = false, frame = 0;
	let components: number[] = [], quantization: number[] = [];
	const quant = new Set<number>(), huffman = new Set<number>();
	while (offset < bytes.length) {
		if (bytes[offset++] !== 0xff) return invalid();
		while (bytes[offset] === 0xff) offset++;
		if (offset >= bytes.length) return invalid();
		const marker = bytes[offset++];
		if (marker === 0xd9) {
			if (!width || !scan || !entropy || offset !== bytes.length) return invalid();
			return { width, height, hasAlpha: false };
		}
		if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return invalid();
		if (marker === 0x01) continue;
		if (offset + 2 > bytes.length) return invalid();
		const length = bytes.readUInt16BE(offset), end = offset + length;
		if (length < 2 || end > bytes.length) return invalid();
		const start = offset + 2;
		if (marker === 0xdb) {
			let at = start;
			while (at < end) {
				const table = bytes[at++], precision = table >> 4;
				if (precision > 1 || (table & 15) > 3) return invalid();
				quant.add(table & 15); at += 64 * (precision + 1);
			}
			if (at !== end || at === start) return invalid();
		}
		if (marker === 0xc4) {
			let at = start;
			while (at < end) {
				const table = bytes[at++];
				if ((table >> 4) > 1 || (table & 15) > 3 || at + 16 > end) return invalid();
				let symbols = 0, available = 1;
				for (let i = 0; i < 16; i++) {
					const count = bytes[at++]; symbols += count; available = available * 2 - count;
					if (available < 0) return invalid();
				}
				if (!symbols || symbols > 256) return invalid();
				at += symbols; huffman.add(table);
			}
			if (at !== end || at === start) return invalid();
		}
		if (marker === 0xdd && length !== 4) return invalid();
		if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
			// 接受常见的 Huffman 顺序/渐进 JPEG；其他编码不冒充已验证。
			if (width || length < 11 || ![0xc0, 0xc1, 0xc2].includes(marker)) return invalid();
			frame = marker;
			const precision = bytes[start], count = bytes[start + 5];
			height = bytes.readUInt16BE(start + 1); width = bytes.readUInt16BE(start + 3);
			if (!width || !height || ![8, 12].includes(precision) || !count || count > 4 || length !== 8 + 3 * count ||
				(marker === 0xc0 && precision !== 8)) return invalid();
			components = []; quantization = [];
			for (let i = 0; i < count; i++) {
				const at = start + 6 + 3 * i, id = bytes[at], sampling = bytes[at + 1];
				if (components.includes(id) || !(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) ||
					(sampling & 15) > 4 || bytes[at + 2] > 3) return invalid();
				components.push(id); quantization.push(bytes[at + 2]);
			}
		}
		if (marker === 0xda) {
			const count = bytes[start];
			if (!width || !count || count > components.length || length !== 6 + 2 * count || quantization.some(id => !quant.has(id))) return invalid();
			const spectral = start + 1 + 2 * count, ss = bytes[spectral], se = bytes[spectral + 1], approx = bytes[spectral + 2];
			if (frame !== 0xc2 ? (ss !== 0 || se !== 63 || approx !== 0) :
				(ss > se || se > 63 || (ss === 0 && se !== 0) || (ss > 0 && count !== 1) ||
					(approx >> 4) > 13 || (approx & 15) > 13)) return invalid();
			const selected = new Set<number>();
			for (let i = 0; i < count; i++) {
				const id = bytes[start + 1 + i * 2], tables = bytes[start + 2 + i * 2];
				if (!components.includes(id) || selected.has(id) || (tables >> 4) > 3 || (tables & 15) > 3 ||
					(ss === 0 && !(approx >> 4) && !huffman.has(tables >> 4)) || (se > 0 && !huffman.has(0x10 | (tables & 15)))) return invalid();
				selected.add(id);
			}
			scan = true; entropy = false; offset = end;
			// 扫描压缩数据中的转义/重启标记；不读取 Huffman 系数。
			while (offset < bytes.length) {
				if (bytes[offset] !== 0xff) { entropy = true; offset++; continue; }
				let next = offset + 1;
				while (bytes[next] === 0xff) next++;
				if (next >= bytes.length) return invalid();
				if (bytes[next] === 0 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) {
					if (bytes[next] === 0) entropy = true;
					offset = next + 1; continue;
				}
				break;
			}
			if (!entropy) return invalid();
		} else offset = end;
	}
	return invalid();
}

function vp8(bytes: Buffer): Dimensions {
	if (bytes.length < 11 || (bytes[0] & 1) || ((bytes[0] >>> 1) & 7) > 3 || !(bytes[0] & 16) ||
		!bytes.subarray(3, 6).equals(Buffer.from([0x9d, 1, 0x2a]))) return invalid();
	const partition = bytes.readUIntLE(0, 3) >>> 5;
	const width = bytes.readUInt16LE(6) & 0x3fff, height = bytes.readUInt16LE(8) & 0x3fff;
	if (!width || !height || (bytes.readUInt16LE(6) & 0xc000) || (bytes.readUInt16LE(8) & 0xc000) ||
		!partition || partition > bytes.length - 10) return invalid();
	return { width, height, hasAlpha: false };
}
function vp8l(bytes: Buffer): Dimensions {
	if (bytes.length < 6 || bytes[0] !== 0x2f) return invalid();
	const bits = bytes.readUInt32LE(1);
	if (bits >>> 29) return invalid();
	return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, hasAlpha: !!(bits & 0x10000000) };
}
function webp(bytes: Buffer): Dimensions {
	if (bytes.length < 20 || bytes.readUInt32LE(4) !== bytes.length - 8) return invalid();
	let offset = 12, image: Dimensions | undefined, canvas: Dimensions | undefined;
	let flags = 0, alpha = false;
	const seen = new Set<string>();
	while (offset + 8 <= bytes.length) {
		const type = bytes.toString("latin1", offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
		const start = offset + 8, end = start + length, padded = end + (length & 1);
		if (padded > bytes.length || ((length & 1) && bytes[end] !== 0)) return invalid();
		const data = bytes.subarray(start, end);
		if (["VP8X", "VP8 ", "VP8L", "ALPH", "ICCP", "EXIF", "XMP "].includes(type)) {
			if (seen.has(type)) return invalid();
			seen.add(type);
		}
		if (type === "VP8X") {
			if (offset !== 12 || length !== 10 || data[0] & 0xc3 || data[1] || data[2] || data[3]) return invalid();
			flags = data[0];
			// 不支持动画容器，避免只验证画布却展示未检查的动画帧。
			if (flags & 2) return invalid();
			canvas = { width: data.readUIntLE(4, 3) + 1, height: data.readUIntLE(7, 3) + 1, hasAlpha: !!(flags & 16) };
			if (canvas.width * canvas.height > 0xffffffff) return invalid();
		} else if (type === "ANIM" || type === "ANMF") return invalid();
		else if (type === "ALPH") {
			if (!canvas || !(flags & 16) || image || length < 2 || data[0] & 0xc0 || (data[0] & 3) > 1 ||
				((data[0] >>> 4) & 3) > 1) return invalid();
			if (!(data[0] & 3) && length !== 1 + canvas.width * canvas.height) return invalid();
			alpha = true;
		} else if (type === "VP8 " || type === "VP8L") {
			if (image || (type === "VP8L" && alpha)) return invalid();
			image = type === "VP8 " ? vp8(data) : vp8l(data);
			if (canvas && (image.width !== canvas.width || image.height !== canvas.height)) return invalid();
		} else if (!canvas) return invalid();
		offset = padded;
	}
	if (offset !== bytes.length || !image || (canvas && canvas.hasAlpha !== (alpha || image.hasAlpha)) ||
		(alpha && !seen.has("VP8 "))) return invalid();
	for (const [type, bit] of [["ICCP", 32], ["EXIF", 8], ["XMP ", 4]] as const) {
		if (seen.has(type) !== !!(flags & bit)) return invalid();
	}
	return { ...image, hasAlpha: alpha || image.hasAlpha };
}

export function inspectImage(data: unknown, expectedFormat?: ImageFormat): InspectedImage {
	if (typeof data !== "string" || !data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return invalid();
	const bytes = Buffer.from(data, "base64");
	if (bytes.toString("base64") !== data) return invalid();
	let format: ImageFormat, dimensions: Dimensions;
	if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
		format = "png"; dimensions = png(bytes);
	} else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		format = "jpeg"; dimensions = jpeg(bytes);
	} else if (bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
		format = "webp"; dimensions = webp(bytes);
	} else return invalid();
	if (expectedFormat !== undefined && expectedFormat !== format) throw new ImageFailure("图片响应格式与请求不一致。");
	return { data, mimeType: `image/${format}`, ...dimensions };
}
