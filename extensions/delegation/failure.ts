/** 创建前选型的安全失败类别；不保留上游原始错误或敏感响应。 */
export type DelegationFailureKind =
	| "timeout" | "cancelled" | "authentication" | "rate_limit" | "http" | "network"
	| "invalid_response" | "unsupported" | "unknown" | "invalid_input" | "unavailable"
	| "invalid_result" | "model_unavailable" | "selection_failed";

export interface SelectionFailure {
	failureKind: DelegationFailureKind;
	reason: string;
	statusCode?: number;
}

/** SDK 错误仅提取 HTTP 状态码；不回显可能含凭据、请求或上游正文的 message。 */
export function chatFailure(message: string | undefined): SelectionFailure {
	// Responses 使用宿主格式“tsgw API error (状态码):”，Anthropic 保留 SDK 数字前缀。
	const match = /^(?:(?:HTTP\s+)?([45]\d{2})\b|tsgw API error \(([45]\d{2})\):)/i.exec(message ?? "");
	const status = match?.[1] ?? match?.[2];
	if (status) {
		const statusCode = Number(status);
		const failureKind = statusCode === 401 || statusCode === 403 ? "authentication" : statusCode === 429 ? "rate_limit" : "http";
		return { failureKind, reason: `聊天选型请求失败（HTTP ${statusCode}）。`, statusCode };
	}
	if (/^(?:request timed out\.?|request timeout\.?)$/i.test(message ?? ""))
		return { failureKind: "timeout", reason: "聊天选型请求超时。" };
	if (/^connection error\.?$/i.test(message ?? ""))
		return { failureKind: "network", reason: "聊天选型连接失败。" };
	return { failureKind: "unknown", reason: "聊天选型请求失败（原因未明）。" };
}
