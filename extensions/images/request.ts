import type { ImagesContext } from "@earendil-works/pi-ai";
import { inspectImage } from "./image-data.ts";
import { IMAGE_PARAMETER_KEYS, MAX_IMAGE_INPUT_TOTAL_BYTES, imageReferenceInputBytes,
	normalizeImageParameters, normalizeImageReference, plainImageObject,
	type ImageFormat, type ImageOperation, type ImageReference, type NormalizedImageParameters } from "./parameters.ts";
import { ImageFailure } from "./response.ts";

export interface ImageRequest {
	operation: ImageOperation;
	payload: Record<string, unknown>;
}
export interface ImageResponseExpectation { count: number; format: ImageFormat; stream: boolean; operation: ImageOperation }
export interface SerializedImageRequest { body: string; expected: ImageResponseExpectation }

export function validPrompt(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 32_000;
}
function dataImage(ref: ImageReference) {
	const match = /^data:image\/(png|jpeg|webp);base64,(.*)$/.exec(ref.image_url ?? "");
	return match ? inspectImage(match[2], match[1] as ImageFormat) : undefined;
}
function validateOperation(parameters: NormalizedImageParameters, operation: ImageOperation): void {
	const images = parameters.images, mask = parameters.mask;
	if (operation === "generate") {
		if (images || mask) throw new ImageFailure("图片生成不接受参考图或蒙版；请使用图片编辑。");
		return;
	}
	if (!images?.length) throw new ImageFailure("图片编辑需要 1..16 张参考图。");
	// 输入预算独立于输出预算；远程引用仅交上游，不在插件内下载。
	const refs = mask ? [...images, mask] : images;
	if (refs.reduce((sum, ref) => sum + imageReferenceInputBytes(ref), 0) > MAX_IMAGE_INPUT_TOTAL_BYTES) {
		throw new ImageFailure("图片参考图与蒙版的总输入不得超过 100000000 字节。");
	}
	if (mask) {
		const first = dataImage(images[0]), maskData = dataImage(mask);
		if (maskData && !maskData.hasAlpha) throw new ImageFailure("图片编辑蒙版需要 alpha 通道。");
		if (first && maskData && (first.width !== maskData.width || first.height !== maskData.height || first.mimeType !== maskData.mimeType)) {
			throw new ImageFailure("图片编辑蒙版必须与第一张参考图尺寸和格式一致。");
		}
	}
}
function apiParameters(parameters: NormalizedImageParameters): Record<string, unknown> {
	const { operation: _operation, partial_images, ...api } = parameters;
	return parameters.stream ? { ...api, partial_images } : api;
}

/** 只构造自己的新对象，不更改冻结的模型、context、参数或原始图片。 */
export function createImageRequest(context: ImagesContext, modelId: string): ImageRequest {
	if (!plainImageObject(context) || !Array.isArray(context.input) || !context.input.length) {
		throw new ImageFailure("图片请求需要非空输入与文本提示词。");
	}
	const parameters = normalizeImageParameters(Object.hasOwn(context, "tsgw") ? context.tsgw : undefined);
	const texts: string[] = [], nativeImages: ImageReference[] = [];
	for (const block of context.input) {
		if (!plainImageObject(block)) throw new ImageFailure("图片请求输入块无效。");
		if (block.type === "text" && validPrompt(block.text)) texts.push(block.text);
		else if (block.type === "image") {
			if (typeof block.data !== "string" || !["image/png", "image/jpeg", "image/webp"].includes(block.mimeType)) {
				throw new ImageFailure("参考图需要有效的 PNG、JPEG 或 WebP 图片块。");
			}
			// 引用校验先检查输入预算，再核对声明 MIME 与容器，避免先解码无界输入。
			nativeImages.push(normalizeImageReference({ image_url: `data:${block.mimeType};base64,${block.data}` }));
		} else throw new ImageFailure("图片请求仅接受非空文本和有效图片块。");
	}
	const prompt = texts.join("\n");
	if (!validPrompt(prompt)) throw new ImageFailure("图片提示词须非空且合并后不得超过 32000 字符。");
	if (nativeImages.length) {
		if (parameters.images) throw new ImageFailure("原生图片块与 tsgw.images 不得同时提供。");
		if (nativeImages.length > 16) throw new ImageFailure("图片编辑最多接受 16 张参考图。");
		parameters.images = nativeImages;
	}
	const operation = parameters.operation ?? (parameters.images ? "edit" : "generate");
	validateOperation(parameters, operation);
	return { operation, payload: { model: modelId, prompt, ...apiParameters(parameters) } };
}

/** 先序列化，再验证实际发送值，避免 getter/toJSON 改写模型或端点边界。 */
export function serializeImageRequest(payload: unknown, modelId: string, operation: ImageOperation): SerializedImageRequest {
	let body: string;
	let value: unknown;
	try {
		const encoded = JSON.stringify(payload);
		if (encoded === undefined) throw new Error();
		body = encoded;
		value = JSON.parse(body);
	} catch { throw new ImageFailure("图片请求无法序列化为有效 JSON。"); }
	if (!plainImageObject(value) || value.model !== modelId || !validPrompt(value.prompt)) {
		throw new ImageFailure("图片请求必须保留当前模型及非空且不超过 32000 字符的提示词。");
	}
	// 未知 hook 字段原样保留；但不能借旧协议字段切换操作、返回 URL 或伪造不支持的能力。
	for (const key of ["operation", "image", "response_format", "style", "standard", "hd", "input_fidelity"]) {
		if (Object.hasOwn(value, key)) throw new ImageFailure("图片请求包含不支持或混淆端点的字段。");
	}
	if (operation === "generate" && (Object.hasOwn(value, "images") || Object.hasOwn(value, "mask"))) {
		throw new ImageFailure("图片生成端点不接受参考图或蒙版。");
	}
	const selected: Record<string, unknown> = {};
	for (const key of IMAGE_PARAMETER_KEYS) if (Object.hasOwn(value, key)) selected[key] = value[key];
	const parameters = normalizeImageParameters(selected);
	validateOperation(parameters, operation);
	return { body, expected: { count: parameters.n, format: parameters.output_format, stream: parameters.stream, operation } };
}
