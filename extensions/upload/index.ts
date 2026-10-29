import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { UploadError } from "./errors.ts";
import { CONTENT_TYPE_PATTERN, RESUME_PATTERN, object, UPLOAD_TOOL, URL_TOOL } from "./protocol.ts";
import { uploadLocalFile, type UploadDependencies } from "./uploader.ts";

const linkSchema = Type.Object({ key: Type.String(), url: Type.String(), expiresAt: Type.String(), expiresIn: Type.Integer() });

/** 不注册 MCP，也不访问凭据或配置：使用调用方当前可用的工具。 */
export function registerUploadTool(pi: ExtensionAPI, dependencies: Pick<UploadDependencies, "put" | "remoteTimeoutMs"> = {}): void {
	pi.registerTool({
		name: "upload_local_file",
		label: "上传本地文件",
		description: "通过已连接的 ts_oht MCP，将明确授权的本地文件从 Pi 主机上传到私有 S3。" +
			"返回持有者即可使用的临时下载 URL（inline 展示 HTML 可能执行）。存储内容约 7 天后清理。" +
			"不会自动重试。失败或结果未知时，请保留 key 和 resume 恢复凭条；仅在明确要求恢复时使用返回的凭条，" +
			"切勿盲目发起全新上传。恢复前，请停止其他客户端对同一文件的上传。不要记录预签名 URL。",
		parameters: Type.Object({
			path: Type.String({ minLength: 1, description: "插件运行环境中的路径；相对路径以会话 cwd 为基准。仅支持普通文件。" }),
			contentType: Type.Optional(Type.String({ minLength: 3, maxLength: 127, pattern: CONTENT_TYPE_PATTERN.source, description: "不带 charset 的 MIME 类型；默认根据扩展名推断，无法推断时使用 application/octet-stream。" })),
			expiresIn: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800, description: "下载 URL 的有效期，单位为秒；默认 86400。不会延长存储保留时间。" })),
			disposition: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("attachment")], { description: "默认 inline；attachment 用于下载。" })),
			resume: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, pattern: RESUME_PATTERN.source, description: "原样使用上次失败调用返回的恢复凭条。" })),
		}),
		outputSchema: Type.Object({
			uploaded: Type.Union([Type.Boolean(), Type.Null()]),
			uploadStatus: Type.Union([Type.Literal("not-started"), Type.Literal("incomplete"), Type.Literal("unknown"), Type.Literal("uploaded")]),
			phase: Type.Union([Type.Literal("local"), Type.Literal("prepare"), Type.Literal("upload"), Type.Literal("complete"), Type.Literal("link")]),
			linkStatus: Type.Union([Type.Literal("not-ready"), Type.Literal("ready"), Type.Literal("failed")]),
			key: Type.Optional(Type.String()), uid: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
			expiresAt: Type.Optional(Type.String()), expiresIn: Type.Optional(Type.Integer()),
			disposition: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("attachment")])),
			fallback: Type.Optional(linkSchema), resume: Type.Optional(Type.String()),
			error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
		}),
		reachesTools: () => [UPLOAD_TOOL, URL_TOOL],
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, onUpdate, ctx) {
			const result = await uploadLocalFile(params, ctx.cwd, signal ?? ctx.signal ?? new AbortController().signal, {
				...dependencies,
				async call(name, args, operationSignal) {
					if (typeof ctx.executeTool !== "function" || !Array.isArray(ctx.tools))
						throw new UploadError("unsupported-host", "上传工具需要宿主支持 ctx.executeTool。");
					if (![UPLOAD_TOOL, URL_TOOL].includes(name) || !ctx.tools.some(tool => tool.name === name))
						throw new UploadError("mcp-unavailable", "所需的 ts_oht 工具尚未连接或不可调用。请在主机中启用它；本工具未创建连接。");
					const outcome = await ctx.executeTool(name, args, { signal: operationSignal });
					// Pi 将原始 MCP CallToolResult 包装在 result.structuredContent 中。
					// 结构化结果缺失时，绝不能从文本中恢复它以绕过主机脱敏。
					if (outcome.result.structuredContent === undefined)
						throw new UploadError("mcp-unavailable", "主机阻止了调用，或未提供结构化 MCP 结果。");
					const raw = object(outcome.result.structuredContent);
					return outcome.isError ? { ...raw, isError: true } : raw;
				},
				onProgress(progress) {
					onUpdate?.({ content: [{ type: "text", text: `上传：${({ local: "本地检查", prepare: "准备", upload: "上传", complete: "完成确认", link: "获取链接" })[progress.phase]}（${progress.completedParts}/${progress.totalParts} 个分片）` }], details: progress });
				},
			});
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result,
				structuredContent: { ...result }, ...(result.error ? { isError: true } : {}) };
		},
	});
}
