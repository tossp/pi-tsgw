import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { normalizeImageParameters, type ImageOperation } from "#tsgw/models/adapter/images/parameters";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2.5-sunburst";
export const DEFAULT_IMAGE_TIMEOUT_MS = 600_000;
export const MAX_IMAGE_TIMEOUT_MS = 2_147_483_647;
const IMAGE_MODELS = ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"] as const;
const optional = <T extends import("typebox").TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));

export const imageSourceSchema = Type.Union([
	Type.Object({ path: Type.String({ minLength: 1, description: "Pi 主机本地普通文件；相对路径以会话 cwd 为基准。直接读取原始字节并外传，不经过内置 read 的审批或缩放。" }) }, { additionalProperties: false }),
	Type.Object({ image_url: Type.String({ minLength: 1, description: "无用户名密码的 HTTP(S) URL，或 PNG/JPEG/WebP 的 base64 data URI。本工具不下载远程 URL。" }) }, { additionalProperties: false }),
	Type.Object({ file_id: Type.String({ minLength: 1, description: "上游已有图片的文件 ID。" }) }, { additionalProperties: false }),
], { description: "恰好一个来源：path、image_url 或 file_id；不可混用。" });

// Type.Enum 仅输出 enum；Moonshot 拒绝联合分支中缺 type 的枚举，使用宿主显式 string 表达。
const common = {
	prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "图片生成或编辑要求，最多32000字符。" }),
	model: Type.Optional(StringEnum(IMAGE_MODELS, { description: "默认 gpt-image-2.5-sunburst，适合成稿；AI 草稿任务可选 gpt-image-2.5-flare，常配 quality=low。" })),
	quality: optional(StringEnum(["auto", "low", "medium", "high", "xhigh", "max"], { description: "质量，默认 auto；选择 Flare 不会自动改为 low。" })),
	size: optional(Type.String({ description: "默认 auto；也可宽x高，均为16倍数、边≤3840、宽高比≤3、像素655360..8294400。" })),
	background: optional(StringEnum(["auto", "opaque", "transparent"], { description: "背景，默认 auto。透明背景需 PNG/WebP。" })),
	output_format: optional(StringEnum(["png", "jpeg", "webp"], { description: "输出格式，默认 png；原始字节不转码。" })),
	output_compression: optional(Type.Integer({ minimum: 0, maximum: 100, description: "仅用于 JPEG/WebP 的压缩质量；省略采用上游默认100。" })),
	n: optional(Type.Integer({ minimum: 1, maximum: 10, description: "返回图片数量；默认1，最多10。" })),
	moderation: optional(StringEnum(["auto", "low"], { description: "审核强度，默认 auto。" })),
	stream: optional(Type.Boolean({ description: "默认 false；支持解析流式响应，不承诺界面渐进预览。" })),
	partial_images: optional(Type.Integer({ minimum: 0, maximum: 3, description: "仅 stream=true 时使用；默认0。最终仅返回完成图。" })),
	safety_identifier: optional(Type.String({ maxLength: 128, description: "可选安全标识，最长128字符。" })),
	user: optional(Type.String({ description: "已废弃的上游 user 参数，仅为兼容保留。" })),
	timeout_ms: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_IMAGE_TIMEOUT_MS, description: "调用超时毫秒数；默认600000，可显式缩短或延长，最多2147483647。取消不保证上游停止处理或计费。" })),
};

export const generateImageSchema = Type.Object(common, { additionalProperties: false });
export const editImageSchema = Type.Object({ ...common,
	images: Type.Array(imageSourceSchema, { minItems: 1, maxItems: 16, description: "1..16张参考图。每个本地/内联图片小于50 MB，合计最多100 MB；mask另算张数，但计入字节预算。" }),
	mask: optional(imageSourceSchema),
}, { additionalProperties: false });

export const imageToolResultSchema = Type.Object({
	operation: Type.Enum(["generate", "edit"]), model: Type.String(),
	phase: Type.Enum(["validate", "input", "request", "output", "save", "complete"]),
	requestStatus: Type.Enum(["not-started", "unknown", "failed", "succeeded"]),
	files: Type.Array(Type.Object({ path: Type.String(), mimeType: Type.String(), width: Type.Integer(), height: Type.Integer() })),
	usage_note: Type.Optional(Type.String()),
	usage_reports: Type.Optional(Type.Array(Type.Object({ input: Type.Number(), output: Type.Number(),
		cacheRead: Type.Number(), cacheWrite: Type.Number(), totalTokens: Type.Number() }))),
	error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
});

const API_KEYS = ["quality", "size", "background", "output_format", "output_compression", "n", "moderation",
	"stream", "partial_images", "safety_identifier", "user"];

/** 运行时再验证白名单；程序化调用也不能静默丢弃未知参数。 */
export function prepareImageToolParameters(operation: ImageOperation, value: unknown) {
	if (!plainObject(value)) throw new Error("invalid-parameters");
	const allowed = new Set(["prompt", "model", "timeout_ms", ...API_KEYS, ...(operation === "edit" ? ["images", "mask"] : [])]);
	if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowed.has(key))) throw new Error("unknown-parameters");
	if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 32_000) throw new Error("invalid-prompt");
	const model = value.model === undefined ? DEFAULT_IMAGE_MODEL : value.model;
	if (typeof model !== "string" || !IMAGE_MODELS.includes(model as typeof IMAGE_MODELS[number])) throw new Error("invalid-model");
	const timeoutMs = value.timeout_ms === undefined ? DEFAULT_IMAGE_TIMEOUT_MS : value.timeout_ms;
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_IMAGE_TIMEOUT_MS)
		throw new Error("invalid-timeout");
	const parameters: Record<string, unknown> = {};
	for (const key of API_KEYS) if (Object.hasOwn(value, key)) parameters[key] = value[key];
	return { prompt: value.prompt, model, timeoutMs, parameters: normalizeImageParameters(parameters),
		images: value.images, mask: value.mask };
}

export function plainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
