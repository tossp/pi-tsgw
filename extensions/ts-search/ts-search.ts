/**
 * 独立搜索工具（ts_search）：供所有模型直接调用的统一搜索入口。
 *
 * 与模型模块的内置查询注入（models/web-search.ts）分离：
 * - 内置查询注入：GPT/Grok 模型请求时自动附加搜索能力（原生 web_search / search_parameters）
 * - 本工具：任何模型（DeepSeek、GLM、Qwen…）主动调用，内部通过网关的
 *   GPT / Grok 模型执行联网搜索并返回结果
 *
 * 默认并行请求 GPT + Grok 两个后端；`model` 参数为枚举可选项（由目录中
 * 所有 gpt-* / grok-* 模型生成），模型从列表中选择，避免猜测模型名。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface TsSearchOptions {
	baseUrl: string;
	/** 可选的搜索后端模型（gpt-* / grok-*），供工具参数枚举。 */
	searchModels: readonly string[];
	/** 凭据 provider（默认 tsgw，走 Pi 凭据机制）。 */
	apiKeyProvider?: string;
}

const DEFAULT_GPT_MODEL = "gpt-5.4";
const DEFAULT_GROK_MODEL = "grok-4.20-fast";
const CHAT_COMPLETIONS_PATH = "v1/chat/completions";

const SEARCH_PROMPT = [
	"Answer the user's question using the latest available information from the web.",
	"Be concise.",
	"If sources are available, include only the most relevant source URLs needed to support the answer; avoid link dumping.",
	"If no live web information is available, reply exactly: NO_LIVE_WEB.",
].join(" ");

export function detectSearchFamily(
	model: string,
): "gpt" | "grok" | "unsupported" {
	const lower = model.toLowerCase();
	if (lower.startsWith("gpt-")) return "gpt";
	if (lower.startsWith("grok-")) return "grok";
	return "unsupported";
}

export function filterSearchModels(models: readonly string[]): string[] {
	return Array.from(
		new Set(
			models.filter(
				(model) => detectSearchFamily(model) !== "unsupported",
			),
		),
	);
}

function buildModelEnum(
	models: readonly string[],
): ReturnType<typeof Type.Literal>[] {
	return filterSearchModels(models).map((model) => Type.Literal(model));
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
	const record = input as Record<string, unknown>;
	for (const [key, value] of Object.entries(record)) {
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
	family: "gpt" | "grok",
	query: string,
): Record<string, unknown> {
	const messages = [
		{ role: "system", content: SEARCH_PROMPT },
		{ role: "user", content: query },
	];
	if (family === "gpt") {
		return { model, messages, tools: [{ type: "web_search" }] };
	}
	return { model, messages, search_parameters: { mode: "on" } };
}

export function resolveSearchModels(model?: string): string[] {
	if (!model) return [DEFAULT_GPT_MODEL, DEFAULT_GROK_MODEL];
	if (detectSearchFamily(model) === "unsupported") {
		throw new Error(
			`unsupported model "${model}"; only gpt-* or grok-* models are allowed`,
		);
	}
	return [model];
}

interface RouteResult {
	ok: boolean;
	model: string;
	family: "gpt" | "grok";
	answer: string;
	urls: string[];
	requestId: string;
	error: string;
}

async function executeSearchRoute(
	model: string,
	query: string,
	apiKey: string,
	baseUrl: string,
	signal: AbortSignal | undefined,
): Promise<RouteResult> {
	const family = detectSearchFamily(model);
	if (family === "unsupported") {
		return {
			ok: false,
			model,
			family: "gpt",
			answer: "",
			urls: [],
			requestId: "",
			error: `unsupported model family: ${model}`,
		};
	}

	const endpoint = buildSearchUrl(baseUrl);
	const payload = buildSearchPayload(model, family, query);

	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(payload),
			signal,
		});
	} catch (error) {
		return {
			ok: false,
			model,
			family,
			answer: "",
			urls: [],
			requestId: "",
			error: `request failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const requestId = response.headers.get("ah-request-id") ?? "";
	const bodyText = await response.text();
	if (!response.ok) {
		return {
			ok: false,
			model,
			family,
			answer: "",
			urls: [],
			requestId,
			error: `HTTP ${response.status} ${response.statusText}\n${bodyText}`,
		};
	}

	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (parsed && typeof parsed === "object") {
			const record = parsed as Record<string, unknown>;
			return {
				ok: true,
				model,
				family,
				answer: extractAnswer(record) || JSON.stringify(record),
				urls: Array.from(collectUrls(record)),
				requestId,
				error: "",
			};
		}
	} catch {
		// 非 JSON 响应按纯文本处理。
	}
	return {
		ok: true,
		model,
		family,
		answer: bodyText || "empty response body",
		urls: Array.from(collectUrls(bodyText)),
		requestId,
		error: "",
	};
}

function renderMergedResult(results: RouteResult[]): string {
	const gpt = results.find((item) => item.family === "gpt");
	const grok = results.find((item) => item.family === "grok");
	const mergedUrls = Array.from(new Set(results.flatMap((item) => item.urls)));
	const succeeded = results.filter((item) => item.ok).length;
	const allFailed = succeeded === 0;
	const lines = [
		"backend: tsgw",
		`result: ${allFailed ? "failed" : succeeded === results.length ? "success" : "partial-success"}`,
		"searched models:",
		`- gpt: ${gpt?.model ?? "n/a"}`,
		`- grok: ${grok?.model ?? "n/a"}`,
		"gpt answer:",
		gpt?.ok
			? gpt.answer || "No answer returned."
			: `[failed] ${gpt?.error ?? "unknown"}`,
		"grok answer:",
		grok?.ok
			? grok.answer || "No answer returned."
			: `[failed] ${grok?.error ?? "unknown"}`,
		"merged source URLs:",
	];
	if (mergedUrls.length) {
		for (const url of mergedUrls) lines.push(`- ${url}`);
	} else {
		lines.push("- none");
	}
	if (allFailed) lines.push("failure summary: all search routes failed.");
	return lines.join("\n");
}

function buildFailure(model: string, error: string): RouteResult {
	const family = detectSearchFamily(model);
	return {
		ok: false,
		model,
		family: family === "grok" ? "grok" : "gpt",
		answer: "",
		urls: [],
		requestId: "",
		error,
	};
}

/**
 * 注册 ts_search 工具。默认并行请求 GPT + Grok；`model` 参数（枚举）可指定
 * 单后端。枚举由 searchModels（目录中 gpt-* / grok-* 模型）生成，模型从
 * 列表中选，避免猜测模型名。
 */
export function registerTsSearch(
	pi: ExtensionAPI,
	options: TsSearchOptions,
): void {
	const modelEnum = buildModelEnum(options.searchModels);
	const argsSchema = Type.Object({
		query: Type.String({ minLength: 1, description: "搜索查询" }),
		model: Type.Optional(
			Type.Union(
				modelEnum.length ? modelEnum : [Type.Literal(DEFAULT_GPT_MODEL)],
			),
		),
	});

	pi.registerTool({
		name: "ts_search",
		label: "TS Search",
		description:
			"统一网络搜索：通过网关的 GPT / Grok 模型执行联网搜索并返回最新结果。任何模型都可调用。",
		parameters: argsSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const query = params.query.trim();
			const requested = params.model ?? "";

			if (!query) {
				return {
					content: [{ type: "text", text: "ts_search: query is empty." }],
					details: {},
				};
			}
			let models: string[];
			try {
				models = resolveSearchModels(requested || undefined);
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `ts_search: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					details: {},
				};
			}

			// 解析凭据：优先指定的 provider，默认 tsgw。
			let apiKey = "";
			try {
				apiKey =
					(await ctx.modelRegistry.getApiKeyForProvider(
						options.apiKeyProvider ?? "tsgw",
					)) ?? "";
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `ts_search: failed to resolve API key: ${error instanceof Error ? error.message : String(error)}`,
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
							text: "ts_search: no API key resolved for provider tsgw. Run /login to configure it.",
						},
					],
					details: {},
				};
			}

			// 路由：默认 GPT + Grok 并行；指定 model 时只走对应 family。
			const settled = await Promise.allSettled(
				models.map((model) =>
					executeSearchRoute(model, query, apiKey, options.baseUrl, signal),
				),
			);
			const results = settled.map((item, index) => {
				if (item.status === "fulfilled") return item.value;
				return buildFailure(models[index], String(item.reason));
			});

			return {
				content: [{ type: "text", text: renderMergedResult(results) }],
				details: {},
			};
		},
	});
}
