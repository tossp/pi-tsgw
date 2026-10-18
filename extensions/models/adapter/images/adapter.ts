import type { ProviderHeaders, ProviderImages } from "@earendil-works/pi-ai";
import { OPENAI_IMAGE_API as IMAGE_API, OPENAI_IMAGE_MODEL_IDS as IMAGE_MODEL_IDS } from "#tsgw/models/vendors/openai";
import { abortable, ImageFailure, parseUsage, record } from "./response.ts";
import type { TsgwImagesResult } from "./parameters.ts";
import { createImageRequest, serializeImageRequest } from "./request.ts";
import { readImageResponse } from "./stream-response.ts";

const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const UNCERTAIN = "未自动重试；此结果不代表上游未计费。";
function mergeHeaders(apiKey: string | undefined, ...sources: (ProviderHeaders | undefined)[]): Headers {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (apiKey?.trim()) headers.set("Authorization", `Bearer ${apiKey}`);
	let authSuppressed = false;
	for (const source of sources) {
		for (const [name, value] of Object.entries(source ?? {})) {
			if (name.toLowerCase() === "authorization") authSuppressed = value === null;
			if (value === null) headers.delete(name);
			else headers.set(name, value);
		}
	}
	// 显式 null 是调用者抑制默认认证的授权；缺省凭据则不发送匿名请求。
	if (!headers.get("authorization") && !authSuppressed) throw new ImageFailure("图片请求缺少认证信息。");
	return headers;
}

export const generateImages: ProviderImages["generateImages"] = async (model, context, options = {}) => {
	const result: TsgwImagesResult = {
		api: IMAGE_API, provider: "tsgw", model: model.id, output: [], stopReason: "error", timestamp: Date.now(),
	};
	const controller = new AbortController();
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let received: Response | undefined;
	let deadline = Infinity;
	const cancel = () => controller.abort();
	const check = () => {
		if (!controller.signal.aborted && Date.now() >= deadline) { timedOut = true; controller.abort(); }
		controller.signal.throwIfAborted();
	};
	try {
		options.signal?.addEventListener("abort", cancel, { once: true });
		if (options.signal?.aborted) cancel();
		check();
		if (model.type !== "image" || model.provider !== "tsgw" || model.api !== IMAGE_API ||
			!IMAGE_MODEL_IDS.some(id => id === model.id)) throw new ImageFailure("不支持此图片模型或协议。");
		const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_TIMEOUT_MS) throw new ImageFailure("图片请求超时时间无效。");
		const duration = timeout;
		deadline = Date.now() + duration;
		timer = setTimeout(() => {
			if (!controller.signal.aborted) { timedOut = true; controller.abort(); }
		}, duration);
		check();
		const { operation, payload } = createImageRequest(context, result.model);
		check();
		const url = `${model.baseUrl.replace(/\/+$/, "")}/images/${operation === "edit" ? "edits" : "generations"}`;
		const headers = mergeHeaders(options.apiKey, model.headers, options.headers);
		const replacement = options.onPayload ? await abortable(controller.signal, () => options.onPayload!(payload, model)) : undefined;
		check();
		const { body, expected } = serializeImageRequest(replacement === undefined ? payload : replacement, result.model, operation);
		check();
		const response = await abortable(controller.signal, async () => {
			const response = await (options.fetch ?? globalThis.fetch)(url, {
				method: "POST", headers, body, signal: controller.signal, redirect: "error",
			});
			received = response;
			// 自定义 fetch 可能忽略 signal；迟到响应不再保留未消费的流。
			if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
			return response;
		});
		check();
		if (options.onResponse) {
			await abortable(controller.signal, () => options.onResponse!({
				status: response.status, headers: Object.fromEntries(response.headers.entries()),
			}, model));
		}
		check();
		if (response.status !== 200) {
			const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `（HTTP ${response.status}）` : "";
			throw new ImageFailure(`图片请求失败${status}。`);
		}
		const output = await readImageResponse(response, controller.signal, expected, raw => {
			// 上游可能已完成计费；坏图、断流或取消也保留已报告且有效的用量。
			if (record(raw) && Array.isArray(raw.usage_reports)) {
				delete result.usage;
				const reports = raw.usage_reports.slice(0, 10).flatMap(report => {
					const usage = parseUsage({ usage: report }, model);
					if (!usage) return [];
					const { input, output, cacheRead, cacheWrite, totalTokens } = usage;
					return [{ input, output, cacheRead, cacheWrite, totalTokens }];
				});
				result.tsgwUsage = { status: "unaggregated", reports };
			} else {
				const usage = parseUsage(raw, model);
				if (usage && !result.tsgwUsage) result.usage = usage;
			}
		});
		check();
		result.output = output;
		result.stopReason = "stop";
		return result;
	} catch (error) {
		if (!controller.signal.aborted && Date.now() >= deadline) { timedOut = true; controller.abort(); }
		if (controller.signal.aborted) {
			result.stopReason = timedOut ? "error" : "aborted";
			result.errorMessage = `${timedOut ? "图片请求超时。" : "图片请求已取消。"}${UNCERTAIN}`;
		} else {
			result.errorMessage = `${error instanceof ImageFailure ? error.message : "图片请求失败，请检查认证、网络及请求钩子。"}${UNCERTAIN}`;
		}
		return result;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
		controller.abort();
		// 也覆盖 fetch 已完成但 race 被取消抢先结束、尚未赋值给局部 response 的情况。
		if (received?.body && !received.body.locked) void received.body.cancel().catch(() => {});
	}
};
