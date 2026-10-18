import type { AssistantImages, ImagesContext, Usage } from "@earendil-works/pi-ai";
import { inspectImage } from "./image-data.ts";
import { ImageFailure } from "./response.ts";

export type ImageFormat = "png" | "jpeg" | "webp";
export type ImageOperation = "generate" | "edit";
export interface ImageReference { image_url?: string; file_id?: string }

/** 十进制字节：单张严格小于上限，参考图与蒙版合计不超过总上限。 */
export const MAX_IMAGE_INPUT_BYTES = 50_000_000;
export const MAX_IMAGE_INPUT_TOTAL_BYTES = 100_000_000;

/** context.tsgw 是插件扩展，不是 Pi 原生第三参数；API 的 null 按省略处理。 */
export interface TsgwImageParameters {
	operation?: ImageOperation | null;
	images?: ImageReference[] | null;
	mask?: ImageReference | null;
	quality?: "auto" | "low" | "medium" | "high" | "xhigh" | "max" | null;
	/** auto 或宽x高：16 的倍数、边长不超过 3840、比例不超过 3、像素 655360..8294400。 */
	size?: string | null;
	background?: "auto" | "opaque" | "transparent" | null;
	output_format?: ImageFormat | null;
	output_compression?: number | null;
	n?: number | null;
	moderation?: "auto" | "low" | null;
	stream?: boolean | null;
	partial_images?: number | null;
	safety_identifier?: string | null;
	user?: string | null;
}
export interface TsgwImagesContext extends ImagesContext { tsgw?: TsgwImageParameters }
/** 多图 SSE 的逐事件用量作用域不明：保留报告，不伪造请求总量。 */
export type ImageUsageReport = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
export interface TsgwImagesResult extends AssistantImages {
	tsgwUsage?: { status: "unaggregated"; reports: ImageUsageReport[] };
}
export type NormalizedImageParameters = TsgwImageParameters & {
	quality: NonNullable<TsgwImageParameters["quality"]>; size: string;
	background: NonNullable<TsgwImageParameters["background"]>; output_format: ImageFormat;
	n: number; moderation: "auto" | "low"; stream: boolean; partial_images: number;
};

export const IMAGE_PARAMETER_KEYS = ["operation", "images", "mask", "quality", "size", "background", "output_format",
	"output_compression", "n", "moderation", "stream", "partial_images", "safety_identifier", "user"] as const;
const QUALITIES = new Set(["low", "medium", "high", "xhigh", "max", "auto"]);
const BACKGROUNDS = new Set(["auto", "opaque", "transparent"]);
const FORMATS = new Set(["png", "jpeg", "webp"]);
const invalid = () => new ImageFailure("图片 tsgw 参数无效：请检查参数名、类型、取值范围及格式/流式组合。");

export function plainImageObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
export function validSize(value: unknown): boolean {
	if (value === "auto") return true;
	if (typeof value !== "string" || /^[1-9]\d{0,3}x[1-9]\d{0,3}$/.exec(value)?.[0] !== value) return false;
	const [width, height] = value.split("x").map(Number);
	return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840 &&
		Math.max(width, height) / Math.min(width, height) <= 3 &&
		width * height >= 655_360 && width * height <= 8_294_400;
}
const integer = (value: unknown, min: number, max: number): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** 仅用于已校验的引用：按 canonical base64 长度与 padding 计算 decoded 字节，不再次分配图片 Buffer。 */
export function imageReferenceInputBytes(reference: ImageReference): number {
	const url = reference.image_url;
	if (!url?.startsWith("data:")) return 0;
	return (url.length - url.indexOf(",") - 1) / 4 * 3 - (url.endsWith("==") ? 2 : url.endsWith("=") ? 1 : 0);
}

/** 不下载 URL；data URI 保留原始图片字节，且核对声明 MIME 与容器。 */
export function normalizeImageReference(value: unknown): ImageReference {
	const fail = () => new ImageFailure("图片引用无效：须提供唯一的非空 file_id 或无用户名密码的 HTTP(S)/图片 data URI。");
	if (!plainImageObject(value) || Reflect.ownKeys(value).length !== 1 || Reflect.ownKeys(value).some(key => key !== "image_url" && key !== "file_id")) throw fail();
	const url = Object.hasOwn(value, "image_url") ? value.image_url : undefined;
	const file = Object.hasOwn(value, "file_id") ? value.file_id : undefined;
	if (url !== undefined && file !== undefined) throw fail();
	if (file !== undefined) {
		if (typeof file !== "string" || !file.trim() || file !== file.trim() || /[\u0000-\u001f\u007f]/.test(file)) throw fail();
		return { file_id: file };
	}
	if (typeof url !== "string" || !url || url !== url.trim() || /[\u0000-\u0020\u007f]/.test(url)) throw fail();
	if (url.startsWith("data:")) {
		const overBudget = () => new ImageFailure("单张参考图或蒙版必须小于 50000000 字节。");
		if (url.length > Math.ceil(MAX_IMAGE_INPUT_BYTES / 3) * 4 + 128) throw overBudget();
		const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
		if (!match) throw fail();
		// 与工具单文件预算一致；输入图不施加输出尺寸上限。
		if (imageReferenceInputBytes({ image_url: url }) >= MAX_IMAGE_INPUT_BYTES) throw overBudget();
		inspectImage(match[2], match[1] as ImageFormat);
		return { image_url: url };
	}
	let parsed: URL;
	try { parsed = new URL(url); } catch { throw fail(); }
	if (!/^https?:\/\//i.test(url) || /^https?:\/\/[^/?#]*@/i.test(url) || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw fail();
	return { image_url: parsed.href };
}

export function normalizeImageParameters(value: unknown): NormalizedImageParameters {
	if (value == null) value = {};
	if (!plainImageObject(value) || Reflect.ownKeys(value).some(key => !IMAGE_PARAMETER_KEYS.some(allowed => key === allowed))) throw invalid();
	const source = value;
	const get = (key: string, fallback?: unknown) => (Object.hasOwn(source, key) ? source[key] : undefined) ?? fallback;
	const quality = get("quality", "auto"), size = get("size", "auto"), background = get("background", "auto");
	const output_format = get("output_format", "png"), n = get("n", 1), moderation = get("moderation", "auto");
	const stream = get("stream", false), partial_images = get("partial_images", 0);
	if (typeof quality !== "string" || !QUALITIES.has(quality) || !validSize(size) ||
		typeof background !== "string" || !BACKGROUNDS.has(background) || typeof output_format !== "string" || !FORMATS.has(output_format) ||
		!integer(n, 1, 10) || (moderation !== "auto" && moderation !== "low") || typeof stream !== "boolean" ||
		!integer(partial_images, 0, 3) || (!stream && partial_images !== 0)) throw invalid();
	const result = { quality, size, background, output_format, n, moderation, stream, partial_images } as NormalizedImageParameters;
	const compression = get("output_compression");
	if (compression !== undefined) {
		if (!integer(compression, 0, 100) || output_format === "png") throw invalid();
		result.output_compression = compression;
	}
	if (background === "transparent" && output_format === "jpeg") throw invalid();
	for (const key of ["safety_identifier", "user"] as const) {
		const text = get(key);
		if (text === undefined) continue;
		if (typeof text !== "string" || (key === "safety_identifier" && text.length > 128)) throw invalid();
		result[key] = text;
	}
	const operation = get("operation"), images = get("images"), mask = get("mask");
	if (operation !== undefined) {
		if (operation !== "generate" && operation !== "edit") throw invalid();
		result.operation = operation;
	}
	if (images !== undefined) {
		if (!Array.isArray(images) || images.length < 1 || images.length > 16) throw invalid();
		result.images = Array.from(images, normalizeImageReference);
	}
	if (mask !== undefined) result.mask = normalizeImageReference(mask);
	return result;
}
