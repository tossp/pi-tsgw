import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { anthropicModels } from "./vendors/anthropic.ts";
import { deepseekModels } from "./vendors/deepseek.ts";
import { geminiModels } from "./vendors/gemini.ts";
import { glmModels } from "./vendors/glm.ts";
import { kimiModels } from "./vendors/kimi.ts";
import { longcatModels } from "./vendors/longcat.ts";
import { mimoModels } from "./vendors/mimo.ts";
import { minimaxModels } from "./vendors/minimax.ts";
import { openaiModels } from "./vendors/openai.ts";
import { qwenModels } from "./vendors/qwen.ts";

export const PROVIDER_ID = "tsgw";

/**
 * Neutral placeholder root. Point the extension at your gateway through
 * settings.json (`"tsgw": { "baseUrl": ... }`); this default only applies
 * when nothing is configured.
 */
export const DEFAULT_ROOT = "https://aih.example.com";

/** Normalize a gateway root, including the common accidental `/v1` suffix. */
export function normalizeRoot(value = DEFAULT_ROOT): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`TSGW baseUrl is not a valid URL: ${value}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error("TSGW baseUrl must use http or https");
	}
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/, "");
	if (url.pathname === "/v1") url.pathname = "";
	else if (url.pathname.endsWith("/v1"))
		url.pathname = url.pathname.slice(0, -3);
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url.toString().replace(/\/$/, "");
}

/** 模型黑白名单。`include` 只保留匹配的模型；`exclude` 始终生效（黑名单优先）。 */
export interface ModelFilter {
	include?: readonly string[];
	exclude?: readonly string[];
}

/** 前缀通配匹配：`gpt-5.6-*` 命中该系列全部；不带 `*` 时精确匹配。 */
function matches(pattern: string, id: string): boolean {
	if (pattern.endsWith("*")) return id.startsWith(pattern.slice(0, -1));
	return pattern === id;
}

function compilePatterns(patterns: readonly string[]): (id: string) => boolean {
	return (id) => patterns.some((pattern) => matches(pattern, id));
}

/** 按黑白名单过滤模型目录；无过滤条件时原样返回。 */
export function filterModels(
	models: readonly ProviderModelConfig[],
	filter?: ModelFilter,
): ProviderModelConfig[] {
	if (!filter) return [...models];
	const include = filter.include?.length
		? compilePatterns(filter.include)
		: undefined;
	const exclude = filter.exclude?.length
		? compilePatterns(filter.exclude)
		: undefined;
	return models.filter(
		(model) =>
			(!include || include(model.id)) && (!exclude || !exclude(model.id)),
	);
}

/**
 * The authoritative TSGW catalog: vendor slices concatenated in a fixed
 * order, then filtered by the configured blacklist/whitelist.
 *
 * 新增模型 → 改对应 vendors 文件；新增供应商 → 这里加一行 import + spread。
 */
export function modelsForRoot(
	root: string,
	filter?: ModelFilter,
): ProviderModelConfig[] {
	const models = [
		...deepseekModels(root),
		...glmModels(root),
		...mimoModels(root),
		...minimaxModels(root),
		...kimiModels(root),
		...longcatModels(root),
		...qwenModels(root),
		...openaiModels(root),
		...geminiModels(root),
		...anthropicModels(root),
	];
	return filterModels(models, filter);
}
