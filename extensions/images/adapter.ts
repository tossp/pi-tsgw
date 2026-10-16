import type { AssistantImages, ProviderHeaders, ProviderImages } from "@earendil-works/pi-ai";
import { IMAGE_API, IMAGE_MODEL_IDS } from "./models.ts";
import { abortable, ImageFailure, parseImage, parseUsage, readJson, record } from "./response.ts";

const DEFAULT_TIMEOUT_MS = 300_000;
const UNCERTAIN = "未自动重试；此结果不代表上游未计费。";
const QUALITIES = new Set(["low", "medium", "high", "xhigh", "max", "auto"]);

function validPrompt(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 32_000;
}

function validSize(value: unknown): boolean {
	if (value === "auto") return true;
	if (typeof value !== "string" || /^[1-9]\d{0,3}x[1-9]\d{0,3}$/.exec(value)?.[0] !== value) return false;
	const [width, height] = value.split("x").map(Number);
	return width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= 3840 &&
		Math.max(width, height) / Math.min(width, height) <= 3 &&
		width * height >= 655_360 && width * height <= 8_294_400;
}

function payloadBody(payload: unknown, id: string): string {
	// 校验实际发送的 JSON，避免钩子对象的 getter/toJSON 绕过固定请求边界。
	const body = JSON.stringify(payload);
	const value: unknown = body === undefined ? undefined : JSON.parse(body);
	if (!record(value) || value.model !== id || value.n !== 1 || value.output_format !== "png" ||
		!validPrompt(value.prompt) || typeof value.quality !== "string" || !QUALITIES.has(value.quality) || !validSize(value.size)) {
		throw new ImageFailure("图片请求参数无效：仅允许当前模型、单张 PNG、非空且不超过 32000 字符的提示词及受限质量和尺寸。");
	}
	return body;
}

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
	const result: AssistantImages = {
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
		if (!Array.isArray(context.input) || context.input.length === 0 ||
			context.input.some(block => !block || block.type !== "text" || !validPrompt(block.text))) {
			throw new ImageFailure("图片生成仅接受非空文本块，不接受图片或空输入。");
		}
		const prompt = context.input.map(block => block.type === "text" ? block.text : "").join("\n");
		if (!validPrompt(prompt)) throw new ImageFailure("图片提示词合并后不得超过 32000 字符。");
		const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		if (!Number.isFinite(timeout) || timeout < 0) throw new ImageFailure("图片请求超时时间无效。");
		const duration = Math.min(timeout, DEFAULT_TIMEOUT_MS);
		deadline = Date.now() + duration;
		timer = setTimeout(() => {
			if (!controller.signal.aborted) { timedOut = true; controller.abort(); }
		}, duration);
		check();
		const url = `${model.baseUrl.replace(/\/+$/, "")}/images/generations`;
		const headers = mergeHeaders(options.apiKey, model.headers, options.headers);
		const payload = { model: result.model, prompt, n: 1, quality: "auto", size: "auto", output_format: "png" };
		const replacement = options.onPayload ? await abortable(controller.signal, () => options.onPayload!(payload, model)) : undefined;
		check();
		const body = payloadBody(replacement === undefined ? payload : replacement, result.model);
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
		const raw = await readJson(response, controller.signal);
		check();
		// 上游可能已完成计费；图片校验失败也保留已报告且有效的用量。
		const usage = parseUsage(raw, model);
		if (usage) result.usage = usage;
		const data = parseImage(raw);
		check();
		result.output = [{ type: "image", data, mimeType: "image/png" }];
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
