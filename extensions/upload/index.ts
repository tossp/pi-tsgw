import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { UploadError } from "./errors.ts";
import { object, UPLOAD_TOOL, URL_TOOL } from "./protocol.ts";
import { uploadLocalFile, type UploadDependencies } from "./uploader.ts";

const linkSchema = Type.Object({ key: Type.String(), url: Type.String(), expiresAt: Type.String(), expiresIn: Type.Integer() });

/** No MCP registration or credential/configuration access: use the caller's live tools. */
export function registerUploadTool(pi: ExtensionAPI, dependencies: Pick<UploadDependencies, "put" | "remoteTimeoutMs"> = {}): void {
	pi.registerTool({
		name: "upload_local_file",
		label: "Upload local file",
		description: "Upload an explicitly authorized local file from the Pi host to private S3 via the connected ts_oht MCP. " +
			"Reads OS-accessible files; not a browser upload or sandbox. Up to 32 MiB uses one PUT; larger files use streaming multipart with 3 workers. " +
			"Returns a temporary bearer download URL (default 24h inline; HTML may execute). Storage is cleaned after about 7 days. " +
			"No automatic retries. On failure/unknown outcome preserve key and resume receipt; only resume explicitly with the returned receipt, " +
			"never start a fresh upload blindly. Stop other clients uploading this same file before resuming. Do not log presigned URLs.",
		parameters: Type.Object({
			path: Type.String({ minLength: 1, description: "Path in the plugin environment; relative to the session cwd. Only regular files." }),
			contentType: Type.Optional(Type.String({ description: "MIME type without charset; inferred from extension or application/octet-stream." })),
			expiresIn: Type.Optional(Type.Integer({ minimum: 1, maximum: 604800, description: "Download URL lifetime in seconds; default 86400. Does not extend storage retention." })),
			disposition: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("attachment")])),
			resume: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description: "Unmodified recovery receipt from a previous failed call; checks the old object before resuming. No credentials." })),
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
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async execute(_id, params, signal, onUpdate, ctx) {
			const result = await uploadLocalFile(params, ctx.cwd, signal ?? ctx.signal ?? new AbortController().signal, {
				...dependencies,
				async call(name, args, operationSignal) {
					if (typeof ctx.executeTool !== "function" || !Array.isArray(ctx.tools))
						throw new UploadError("unsupported-host", "This upload tool needs a Pi host with ctx.executeTool (tested with 1.1.0).");
					if (![UPLOAD_TOOL, URL_TOOL].includes(name) || !ctx.tools.some(tool => tool.name === name))
						throw new UploadError("mcp-unavailable", "The required ts_oht tool is not connected or callable. Enable it in the host; no connection was created.");
					const outcome = await ctx.executeTool(name, args, { signal: operationSignal });
					// Pi wraps the raw MCP CallToolResult in result.structuredContent.
					// Never bypass host redaction by recovering an absent structured result from text.
					if (outcome.result.structuredContent === undefined)
						throw new UploadError("mcp-unavailable", "The host blocked the call or withheld its structured MCP result.");
					const raw = object(outcome.result.structuredContent);
					return outcome.isError ? { ...raw, isError: true } : raw;
				},
				onProgress(progress) {
					onUpdate?.({ content: [{ type: "text", text: `Upload: ${progress.phase} (${progress.completedParts}/${progress.totalParts} parts)` }], details: progress });
				},
			});
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result,
				structuredContent: { ...result }, ...(result.error ? { isError: true } : {}) };
		},
	});
}
