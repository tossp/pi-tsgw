import type { AssistantImages, ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeImageParameters, type ImageOperation, type TsgwImagesContext, type TsgwImagesResult, type ImageUsageReport } from "./parameters.ts";
import { DEFAULT_IMAGE_MODEL, editImageSchema, generateImageSchema, imageToolResultSchema, prepareImageToolParameters } from "./tool-schema.ts";
import { ImageToolFileError, resolveImageSources, saveImageOutput, validateImageOutput, type ImageFileResult } from "./tool-files.ts";

export interface ImageToolDetails {
	operation: ImageOperation;
	model: string;
	phase: "validate" | "input" | "request" | "output" | "save" | "complete";
	/** unknown 包含 adapter error/aborted：只确认调用未成功，不能确认上游未处理/计费。 */
	requestStatus: "not-started" | "unknown" | "failed" | "succeeded";
	files: ImageFileResult[];
	usage_note?: string;
	usage_reports?: ImageUsageReport[];
	error?: { code: string; message: string };
}

/** direct 工具复用宿主目录/过滤、认证与图片适配器；不解析凭据、不自行发 HTTP。 */
export function registerImageTools(pi: ExtensionAPI): void {
	for (const operation of ["generate", "edit"] as const) {
		pi.registerTool({
			name: operation === "generate" ? "tsgw_generate_image" : "tsgw_edit_image",
			label: operation === "generate" ? "TSGW 生成图片" : "TSGW 编辑图片",
			description: (operation === "generate" ? "根据 prompt 生成图片，只需填写 prompt。" : "根据 prompt 和 images 编辑图片，可选 mask；蒙版对应第一张参考图。") +
				"默认 Sunburst 用于成稿；AI 草稿任务可选 Flare（通常配 quality=low），不必为普通任务指定型号。" +
				"默认 quality/size/background/moderation=auto、output_format=png、n=1、stream=false、partial_images=0、超时600000毫秒。" +
				(operation === "edit" ? "本地图片以 Pi 进程操作系统权限直接只读原始字节并外传，不经过内置 read 审批，不是沙箱；仅普通文件，每个小于50 MB、含蒙版合计最多100 MB。不下载远程 URL；远程蒙版的格式与尺寸交上游验证。" : "") +
				"返回实际图片块与唯一临时文件路径，不需 codemode 或 image()。请求可能计费；不自动重试或换模型，失败、取消或超时都不保证停止上游处理或未计费。",
			parameters: operation === "generate" ? generateImageSchema : editImageSchema,
			outputSchema: imageToolResultSchema,
			exposure: "direct",
			defaultActive: true,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
			async execute(_id, params, signal, _onUpdate, ctx) {
				const details: ImageToolDetails = { operation, model: DEFAULT_IMAGE_MODEL, phase: "validate", requestStatus: "not-started", files: [] };
				let usage: AssistantImages["usage"];
				let images: ImageContent[] = [];
				const caller = signal && ctx.signal && signal !== ctx.signal ? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal ?? new AbortController().signal;
				try {
					const prepared = prepareImageToolParameters(operation, params);
					details.model = prepared.model;
					caller.throwIfAborted();
					const registry = ctx.modelRegistry;
					if (typeof registry.getModelOfType !== "function" || typeof registry.generateImages !== "function")
						throw new ImageToolFileError("unsupported-host", "图片工具需要支持 modelRegistry.getModelOfType/generateImages 的 Pi 1.2 或更新宿主。");
					const model = registry.getModelOfType("image", "tsgw", prepared.model);
					if (!model || model.provider !== "tsgw" || model.id !== prepared.model)
						throw new ImageToolFileError("model-unavailable", "所选图片模型未在当前宿主目录中启用；不会绕过目录过滤或自动切换型号。");
					details.phase = "input";
					const references = operation === "edit" ? await resolveImageSources(prepared.images, prepared.mask, ctx.cwd, caller) : {};
					const context: TsgwImagesContext = { input: [{ type: "text", text: prepared.prompt }],
						tsgw: normalizeImageParameters({ ...prepared.parameters, operation, ...references }) };
					caller.throwIfAborted();
					details.phase = "request";
					details.requestStatus = "unknown";
					// 参数走显式 context.tsgw；timeout 是 options，不冒称 Pi 原生图片参数。
					const response: TsgwImagesResult = await registry.generateImages(model, context, { timeoutMs: prepared.timeoutMs, signal: caller });
					usage = response.usage;
					if (response.tsgwUsage?.status === "unaggregated") {
						usage = undefined;
						details.usage_note = "多图流式用量归属未明确，逐事件报告未相加，也未计入会话总量；不是免费。";
						details.usage_reports = response.tsgwUsage.reports.map(report => ({ ...report }));
					}
					if (response.stopReason !== "stop") {
						details.requestStatus = "unknown";
						throw new ImageToolFileError(response.stopReason === "aborted" ? "aborted" : "request-failed",
							response.stopReason === "aborted" ? "图片调用已取消或超时；无法保证上游停止处理或未计费，请勿自动重试。" : "图片调用未成功；无法确认上游是否处理或计费，请勿自动重试。请检查宿主模型认证与网关；未切换模型。");
					}
					details.requestStatus = "succeeded";
					details.phase = "output";
					images = validateImageOutput(response.output, context.tsgw!.n!, context.tsgw!.output_format!);
					details.phase = "save";
					details.files = await saveImageOutput(images);
					details.phase = "complete";
				} catch (error) {
					if (error instanceof ImageToolFileError) {
						details.error = { code: error.code, message: error.message };
						if (error.files.length) details.files = error.files;
					} else {
						// 不转发供应商异常、输入 URL、base64 或文件系统原始异常。
						details.error = caller.aborted
							? { code: "aborted", message: details.requestStatus === "not-started" ? "图片工具已取消，尚未调用上游。" : "图片调用已取消；上游结果未知，不保证停止处理或计费，请勿自动重试。" }
							: details.phase === "validate" || details.phase === "input"
								? { code: "invalid-parameters", message: "图片工具参数无效；请检查字段白名单、数值范围、图片来源与参数组合。未调用上游。" }
								: { code: "request-unknown", message: "图片调用异常，无法确认上游结果或是否计费；未自动重试，请检查宿主与网关。" };
					}
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(details) }, ...images],
					details, structuredContent: { ...details, files: details.files.map(file => ({ ...file })),
						...(details.usage_reports ? { usage_reports: details.usage_reports.map(report => ({ ...report })) } : {}) }, ...(usage ? { usage } : {}),
					...(details.error ? { isError: true } : {}),
				};
			},
		});
	}
}
