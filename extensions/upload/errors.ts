/** 只有这些消息可以进入工具结果；绝不暴露原始网络或 MCP 错误。 */
export class UploadError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "UploadError";
	}
}

export function invalidResponse(): never {
	throw new UploadError("invalid-response", "上传服务返回了无效的上传计划；未继续尝试上传。");
}

export function checkAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new UploadError("cancelled", "上传已取消。不要自动重复上传。");
}
