import type {
	ClassifierApi,
	ClassifierModel,
	ClassifierResult,
	ProviderClassifier,
} from "@earendil-works/pi-ai";
import { CLASSIFIER_API, CLASSIFIER_MODEL_IDS } from "./models.ts";

type Classify = ProviderClassifier["classify"];

const CANCELLED = "分类请求已取消。";
const UNSUPPORTED_MODEL = "不支持的分类模型或协议。";
const MISSING_IMPLEMENTATION = "当前宿主未提供可用的 System One 分类实现，请升级 Pi 后重试。";
const GENERIC_ERROR = "分类请求失败，请检查认证、网络及请求参数。";

let loaded: Promise<Classify | undefined> | undefined;

/**
 * 仅在真正分类时加载宿主的内置 provider。旧宿主没有 providers/all 或分类实现时
 * 只返回安全错误，不在模块加载阶段触碰新 API。
 */
function nativeClassify(): Promise<Classify | undefined> {
	loaded ??= (async () => {
		try {
			const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
			const provider = builtinProviders().find((entry) => entry.id === "typesafe");
			return provider?.classify?.bind(provider);
		} catch {
			return undefined;
		}
	})();
	return loaded;
}

function supported(model: ClassifierModel<ClassifierApi>): boolean {
	return model.type === "classifier" && model.api === CLASSIFIER_API &&
		CLASSIFIER_MODEL_IDS.some((id) => id === model.id);
}

function errorResult(
	model: ClassifierModel<ClassifierApi>,
	errorMessage: string,
	aborted = false,
): ClassifierResult {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

/**
 * 原生分类 adapter 的错误会附带上游响应正文；这里只保留可安全展示的中文类别、
 * HTTP 状态和必要的可操作提示，不把正文、URL 或凭据带出到结果。
 */
function safeErrorMessage(message: string | undefined, aborted: boolean): string {
	if (aborted) return CANCELLED;
	const text = message ?? "";
	if (/timeout|timed?\s*out|超时/i.test(text)) return "分类请求超时。";
	const status = /(?:\(|returned\s+|status(?:Code|\s+code)?\s*[:=]?\s*)([45]\d{2})(?:\)|\b)/i
		.exec(text)?.[1];
	if (status) {
		if (status === "401" || status === "403") return `分类请求认证失败（HTTP ${status}）。`;
		if (status === "429") return `分类请求被上游限流（HTTP ${status}）。`;
		return `分类请求失败（HTTP ${status}）。`;
	}
	if (/no api key|api key|unauthor|forbidden|auth/i.test(text))
		return "分类请求缺少有效认证信息。";
	if (/does not support image|image input/i.test(text))
		return "当前分类模型不支持图片输入。";
	if (/unsupported classifier api|no classifier implementation/i.test(text))
		return MISSING_IMPLEMENTATION;
	if (/unexpected response|invalid|did not return|malformed|parse|schema/i.test(text))
		return "分类服务返回了无效响应。";
	if (/fetch failed|network|econn|enotfound|eai_again|connection|socket|terminated/i.test(text))
		return "分类网络请求失败。";
	return GENERIC_ERROR;
}

/**
 * 复用宿主内置 TypeSafe System One classify；不解析 HTTP、不复制分类协议。
 * 模型、context、认证、signal、timeout、请求/响应钩子全部透传，始终禁用
 * 自动重试且不自动切换模型，避免失败请求产生额外费用。
 */
export const classify: ProviderClassifier["classify"] = async (model, context, options) => {
	if (options?.signal?.aborted) return errorResult(model, CANCELLED, true);
	if (!supported(model)) return errorResult(model, UNSUPPORTED_MODEL);

	let implementation: Classify | undefined;
	try {
		implementation = await nativeClassify();
	} catch {
		implementation = undefined;
	}
	if (!implementation) return errorResult(model, MISSING_IMPLEMENTATION);

	try {
		const result = await implementation(model, context, { ...options, maxRetries: 0 });
		if (result.stopReason !== "error" && result.stopReason !== "aborted") return result;
		const aborted = result.stopReason === "aborted" || options?.signal?.aborted === true;
		return { ...result, stopReason: aborted ? "aborted" : "error", errorMessage: safeErrorMessage(result.errorMessage, aborted) };
	} catch (error) {
		if (options?.signal?.aborted) return errorResult(model, CANCELLED, true);
		const message = error instanceof Error ? error.message : "";
		return errorResult(model, safeErrorMessage(message, false));
	}
};
