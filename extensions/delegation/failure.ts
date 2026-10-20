/** 创建前选型的安全失败类别；不保留上游原始错误或敏感响应。 */
export type DelegationFailureKind =
	| "timeout" | "cancelled" | "authentication" | "rate_limit" | "http" | "network"
	| "invalid_response" | "unsupported" | "unknown" | "invalid_input" | "unavailable"
	| "invalid_result" | "model_unavailable";

interface ClassifierFailure {
	failureKind: DelegationFailureKind;
	reason: string;
}

/** 只识别 adapter 的安全类别，不把任意 errorMessage 当作可信展示文本。 */
export function classifierFailure(message: string | undefined, aborted = false): ClassifierFailure {
	if (aborted) return { failureKind: "cancelled", reason: "分类请求已取消。" };
	if (message === "分类请求超时。") return { failureKind: "timeout", reason: message };
	const status = /^分类请求(?:认证失败|被上游限流|失败)（HTTP ([45]\d{2})）。$/.exec(message ?? "")?.[1];
	if (status) {
		if (status === "401" || status === "403")
			return { failureKind: "authentication", reason: `分类请求认证失败（HTTP ${status}）。` };
		if (status === "429") return { failureKind: "rate_limit", reason: "分类请求被上游限流（HTTP 429）。" };
		return { failureKind: "http", reason: `分类请求失败（HTTP ${status}）。` };
	}
	switch (message) {
		case "分类请求缺少有效认证信息。":
			return { failureKind: "authentication", reason: message };
		case "分类网络请求失败。":
			return { failureKind: "network", reason: message };
		case "分类服务返回了无效响应。":
			return { failureKind: "invalid_response", reason: message };
		case "不支持的分类模型或协议。":
		case "当前分类模型不支持图片输入。":
		case "当前宿主未提供可用的 System One 分类实现，请升级 Pi 后重试。":
			return { failureKind: "unsupported", reason: "当前分类模型、协议或宿主分类实现不支持本次请求。" };
		default:
			return { failureKind: "unknown", reason: "分类请求失败（原因未明）。" };
	}
}

export function failureGuidance(kind: DelegationFailureKind | undefined): string {
	if (kind === "cancelled") return "本次未创建子代理；请尊重取消状态，不自动重新派遣。";
	return "自动分类选型暂时无法使用。本次未创建子代理。请由发起调用的主代理按照以下指导选择当前可用模型，" +
		"显式指定 Agent.model 后重新派遣代理；遵守用户指定和固定审阅要求，不重试分类器或自动更换分类模型。";
}
