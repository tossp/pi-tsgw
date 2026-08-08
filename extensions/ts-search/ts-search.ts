/**
 * 独立搜索工具（ts_search）：任何模型均可通过配置或内置的 GPT / Grok
 * 后端执行联网搜索。模型模块自身的内置查询注入在 models/web-search.ts。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface TsSearchOptions {
	baseUrl: string;
	apiKeyProvider?: string;
	searchModels?: readonly string[];
}

export const DEFAULT_SEARCH_MODELS = ["gpt-5.6-luna", "grok-chat-fast"] as const;
const CHAT_COMPLETIONS_PATH = "v1/chat/completions";
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 45_000;
const RETRY_DELAY_MS = 1_000;
const SEARCH_PROMPT = [
	"Answer the user's question using the latest available information from the web.",
	"Be concise.",
	"If sources are available, include only the most relevant source URLs needed to support the answer; avoid link dumping.",
	"If no live web information is available, reply exactly: NO_LIVE_WEB.",
].join(" ");
type SearchFamily = "gpt" | "grok";

export function detectSearchFamily(
	model: string,
): SearchFamily | "unsupported" {
	const lower = model.toLowerCase();
	if (lower.startsWith("gpt-")) return "gpt";
	if (lower.startsWith("grok-")) return "grok";
	return "unsupported";
}

export function resolveSearchModels(
	options: Pick<TsSearchOptions, "searchModels"> = {},
): string[] {
	if (!options.searchModels) return [...DEFAULT_SEARCH_MODELS];

	const models: string[] = [];
	const seen = new Set<string>();
	for (const value of options.searchModels as readonly unknown[]) {
		const model = typeof value === "string" ? value.trim() : "";
		if (!model || detectSearchFamily(model) === "unsupported") {
			console.warn(
				`TSGW: ignoring invalid ts_search model ${JSON.stringify(value)}; expected gpt-* or grok-*`,
			);
			continue;
		}
		if (!seen.has(model)) {
			seen.add(model);
			models.push(model);
		}
	}

	return models.length > 0 ? models : [...DEFAULT_SEARCH_MODELS];
}

export function buildSearchUrl(baseUrl: string): string {
	const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(CHAT_COMPLETIONS_PATH, normalizedBase).toString();
}

function flattenText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) {
		return value
			.map((item) => flattenText(item))
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim();
		if (typeof record.content === "string") return record.content.trim();
		if (Array.isArray(record.content)) return flattenText(record.content);
	}
	return "";
}

function firstNonEmpty(values: unknown[]): string {
	for (const value of values) {
		const text = flattenText(value);
		if (text) return text;
	}
	return "";
}

function extractAnswer(payload: Record<string, unknown>): string {
	const choices = payload.choices;
	if (Array.isArray(choices) && choices.length > 0) {
		const first = choices[0] as Record<string, unknown>;
		const message = first.message as Record<string, unknown> | undefined;
		const answer = flattenText(message?.content);
		if (answer) return answer;
		const delta = first.delta as Record<string, unknown> | undefined;
		const deltaAnswer = flattenText(delta?.content);
		if (deltaAnswer) return deltaAnswer;
	}
	return firstNonEmpty([payload.output_text, payload.answer, payload.message]);
}

function collectUrls(input: unknown, output = new Set<string>()): Set<string> {
	if (typeof input === "string") {
		const matches = input.match(/https?:\/\/[^\s)\]}>"']+/g) ?? [];
		for (const match of matches) output.add(match.replace(/[.,;]+$/, ""));
		return output;
	}
	if (Array.isArray(input)) {
		for (const item of input) collectUrls(item, output);
		return output;
	}
	if (!input || typeof input !== "object") return output;
	for (const [key, value] of Object.entries(input)) {
		if (typeof value === "string" && key.toLowerCase().includes("url")) {
			collectUrls(value, output);
			continue;
		}
		if (
			key === "citations" ||
			key === "annotations" ||
			key === "sources" ||
			key === "search_results" ||
			key === "results" ||
			key === "references"
		) {
			collectUrls(value, output);
			continue;
		}
		collectUrls(value, output);
	}
	return output;
}

export function buildSearchPayload(
	model: string,
	family: SearchFamily,
	query: string,
): Record<string, unknown> {
	const messages = [
		{ role: "system", content: SEARCH_PROMPT },
		{ role: "user", content: query },
	];
	if (family === "gpt") {
		return {
			model,
			messages,
			tools: [
				{
					type: "web_search",
					search_context_size: "medium",
					external_web_access: true,
				},
			],
		};
	}
	return { model, messages, search_parameters: { mode: "on" } };
}

export interface RouteResult {
	ok: boolean;
	model: string;
	family: SearchFamily;
	answer: string;
	urls: string[];
	requestId: string;
	error: string;
}

export interface SearchRetryOptions {
	delayMs?: number;
	requestTimeoutMs?: number;
	fetch?: typeof fetch;
}

interface SearchAttemptResult {
	result: RouteResult;
	retryable: boolean;
}

function failedAttempt(
	model: string,
	family: SearchFamily,
	error: string,
	retryable: boolean,
	requestId = "",
): SearchAttemptResult {
	return {
		result: { ...buildFailure(model, family, error), requestId },
		retryable,
	};
}

function requestSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function waitForRetry(
	delayMs: number,
	signal: AbortSignal | undefined,
): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();
	if (signal?.aborted) return Promise.reject(signal.reason);

	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function executeSearchAttempt(
	model: string,
	query: string,
	apiKey: string,
	baseUrl: string,
	signal: AbortSignal | undefined,
	fetchImpl: typeof fetch,
	requestTimeoutMs: number,
): Promise<SearchAttemptResult> {
	const family = detectSearchFamily(model);
	if (family === "unsupported")
		return failedAttempt(model, "gpt", `不支持的模型系列：${model}`, false);
	if (signal?.aborted)
		return failedAttempt(model, family, "请求已取消。", false);

	let response: Response;
	try {
		response = await fetchImpl(buildSearchUrl(baseUrl), {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildSearchPayload(model, family, query)),
			signal: requestSignal(signal, requestTimeoutMs),
		});
	} catch (error) {
		return failedAttempt(
			model,
			family,
			signal?.aborted
				? "请求已取消。"
				: `请求失败：${error instanceof Error ? error.message : String(error)}`,
			!signal?.aborted,
		);
	}

	const requestId = response.headers.get("ah-request-id") ?? "";
	let bodyText: string;
	try {
		bodyText = await response.text();
	} catch (error) {
		return failedAttempt(
			model,
			family,
			signal?.aborted
				? "请求已取消。"
				: `读取网关响应失败：${error instanceof Error ? error.message : String(error)}`,
			!signal?.aborted,
			requestId,
		);
	}
	if (!response.ok)
		return failedAttempt(
			model,
			family,
			`网关请求失败：HTTP ${response.status} ${response.statusText}\n${bodyText}`,
			response.status === 429 || response.status >= 500,
			requestId,
		);

	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			return {
				result: {
					ok: true,
					model,
					family,
					answer: extractAnswer(record) || JSON.stringify(record),
					urls: Array.from(collectUrls(record)),
					requestId,
					error: "",
				},
				retryable: false,
			};
		}
	} catch {
		// 非 JSON 响应按纯文本处理。
	}
	return {
		result: {
			ok: true,
			model,
			family,
			answer: bodyText || "网关返回空响应。",
			urls: Array.from(collectUrls(bodyText)),
			requestId,
			error: "",
		},
		retryable: false,
	};
}

export async function retrySearchRoute(
	model: string,
	query: string,
	apiKey: string,
	baseUrl: string,
	signal: AbortSignal | undefined,
	options: SearchRetryOptions = {},
): Promise<RouteResult> {
	const delayMs = options.delayMs ?? RETRY_DELAY_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	let lastResult = buildFailure(model, "gpt", "搜索请求未执行。");

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		const current = await executeSearchAttempt(
			model,
			query,
			apiKey,
			baseUrl,
			signal,
			fetchImpl,
			requestTimeoutMs,
		);
		lastResult = current.result;
		if (
			current.result.ok ||
			!current.retryable ||
			attempt === MAX_ATTEMPTS - 1
		)
			return current.result;

		try {
			await waitForRetry(delayMs * 2 ** attempt, signal);
		} catch {
			const family = detectSearchFamily(model);
			return buildFailure(
				model,
				family === "grok" ? "grok" : "gpt",
				"请求已取消。",
			);
		}
	}

	return lastResult;
}

function buildFailure(
	model: string,
	family: SearchFamily,
	error: string,
): RouteResult {
	return {
		ok: false,
		model,
		family,
		answer: "",
		urls: [],
		requestId: "",
		error,
	};
}

function renderMergedResult(results: RouteResult[]): string {
	const succeeded = results.filter((item) => item.ok);
	const failed = results.filter((item) => !item.ok);
	const status =
		succeeded.length === results.length
			? "成功"
			: succeeded.length > 0
				? "部分成功"
				: "失败";
	const lines = ["后端：tsgw", `状态：${status}`];

	if (succeeded.length === 0) {
		const summary = failed
			.map(
				(item) =>
					`${item.family}（${item.model}）：${item.error || "未知错误"}`,
			)
			.join("；");
		lines.push(`全部搜索后端失败：${summary}`);
		return lines.join("\n");
	}

	for (const item of succeeded) {
		lines.push(
			`${item.family}（${item.model}）结果：`,
			item.answer || "未返回答案。",
		);
	}

	const mergedUrls = Array.from(
		new Set(succeeded.flatMap((item) => item.urls)),
	);
	lines.push("来源链接：");
	if (mergedUrls.length) {
		for (const url of mergedUrls) lines.push(`- ${url}`);
	} else {
		lines.push("- 无");
	}
	for (const item of failed) {
		lines.push(`注：${item.family} 后端不可用，已跳过。`);
	}
	return lines.join("\n");
}

export function registerTsSearch(
	pi: ExtensionAPI,
	options: TsSearchOptions,
): void {
	const models = resolveSearchModels(options);
	const argsSchema = Type.Object({
		query: Type.String({ minLength: 1, description: "搜索查询" }),
	});

	pi.registerTool({
		name: "ts_search",
		label: "TS Search",
		description:
			"统一网络搜索：通过网关的 GPT / Grok 模型执行联网搜索并返回最新结果。任何模型都可调用。",
		parameters: argsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			if (!query) {
				return {
					content: [{ type: "text", text: "ts_search：查询内容不能为空。" }],
					details: {},
				};
			}

			const apiKeyProvider = options.apiKeyProvider ?? "tsgw";
			let apiKey = "";
			try {
				apiKey =
					(await ctx.modelRegistry.getApiKeyForProvider(apiKeyProvider)) ?? "";
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `ts_search：解析 API key 失败：${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: {},
				};
			}
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: `ts_search：未找到 ${apiKeyProvider} provider 的 API key，请运行 /login 完成配置。`,
						},
					],
					details: {},
				};
			}

			const settled = await Promise.allSettled(
				models.map((model) =>
					retrySearchRoute(model, query, apiKey, options.baseUrl, signal),
				),
			);
			const results = settled.map((item, index) => {
				if (item.status === "fulfilled") return item.value;
				const model = models[index];
				const family = detectSearchFamily(model);
				return buildFailure(
					model,
					family === "grok" ? "grok" : "gpt",
					`搜索路由异常：${String(item.reason)}`,
				);
			});

			return {
				content: [{ type: "text", text: renderMergedResult(results) }],
				details: {},
			};
		},
	});
}
