import { deepStrictEqual, equal, strictEqual, throws } from "node:assert";
import {
	DEFAULT_ROOT,
	filterModels,
	modelsForRoot,
	normalizeRoot,
	PROVIDER_ID,
} from "./catalog.ts";

const ROOT = "https://aih.example.com";

function testCatalogConcatenation(): void {
	const models = modelsForRoot(ROOT);
	const ids = models.map(({ id }) => id);

	// 11 家供应商分片拼接，共 54 个模型（含 DeepSeek 新名称及旧 alias）。
	equal(ids.length, 54);
	// id 全局唯一。
	equal(new Set(ids).size, ids.length);

	// 供应商覆盖：每家至少一个模型。
	for (const prefix of [
		"deepseek-",
		"glm-",
		"mimo-",
		"MiniMax-",
		"kimi-",
		"longcat-",
		"qwen",
		"gpt-",
		"gemini-",
		"claude-",
	]) {
		equal(
			ids.some((id) => id.startsWith(prefix)),
			true,
			`expected a model with prefix ${prefix}`,
		);
	}

	// 拼接顺序保持目录顺序（deepseek → … → claude → grok）。
	equal(ids[0], "deepseek-flash");
	equal(ids[ids.length - 1], "grok-4.20-fast");

	// 模型 baseUrl 按协议端点派生；DeepSeek aliases 使用官方 Responses 能力。
	const deepseek = models.find(({ id }) => id === "deepseek-flash");
	strictEqual(deepseek?.baseUrl, `${ROOT}/v1`);
	strictEqual(deepseek?.api, "openai-responses");
	deepStrictEqual(deepseek?.input, ["text", "image"]);
	deepStrictEqual(deepseek?.compat, {
		supportsDeveloperRole: false,
		supportsLongCacheRetention: false,
	});
	deepStrictEqual(deepseek?.thinkingLevelMap, {
		off: "none",
		minimal: "low",
		low: "low",
		medium: "high",
		high: "high",
		xhigh: "high",
		max: "max",
	});
	const deepseekLegacy = models.find(({ id }) => id === "deepseek-v4-flash");
	strictEqual(deepseekLegacy?.api, "openai-responses");
	deepStrictEqual(deepseekLegacy?.input, deepseek?.input);
	deepStrictEqual(deepseekLegacy?.compat, deepseek?.compat);
	deepStrictEqual(deepseekLegacy?.thinkingLevelMap, deepseek?.thinkingLevelMap);
	const deepseekPro = models.find(({ id }) => id === "deepseek-v4-pro");
	strictEqual(deepseekPro?.api, "openai-responses");
	deepStrictEqual(deepseekPro?.input, ["text"]);
	deepStrictEqual(deepseekPro?.compat, deepseek?.compat);
	deepStrictEqual(deepseekPro?.thinkingLevelMap, deepseek?.thinkingLevelMap);
	const minimaxIds = models
		.filter(({ id }) => id.startsWith("MiniMax-"))
		.map(({ id }) => id);
	deepStrictEqual(minimaxIds, [
		"MiniMax-M3",
		"MiniMax-M2.7",
		"MiniMax-M2.5",
		"MiniMax-M2.1",
	]);
	const openaiIds = models
		.filter(({ id }) => id.startsWith("gpt-"))
		.map(({ id }) => id);
	deepStrictEqual(openaiIds, [
		"gpt-6-astra",
		"gpt-6.1-sol",
		"gpt-6-sol",
		"gpt-6-luna",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"gpt-5.5",
	]);
	const astra = models.find(({ id }) => id === "gpt-6-astra");
	strictEqual(astra?.api, "openai-responses");
	deepStrictEqual(astra?.input, ["text", "image"]);
	deepStrictEqual(astra?.cost, {
		input: 10,
		output: 50,
		cacheRead: 1,
		cacheWrite: 12.5,
	});
	strictEqual(astra?.contextWindow, 1050000);
	strictEqual(astra?.maxTokens, 128000);
	deepStrictEqual(astra?.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	for (const [modelId, cost] of [
		["gpt-6-sol", { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
		["gpt-6-luna", { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
	] as const) {
		const model = models.find(({ id }) => id === modelId);
		strictEqual(model?.name, modelId === "gpt-6-sol" ? "GPT 6 Sol" : "GPT 6 Luna");
		strictEqual(model?.api, "openai-responses");
		strictEqual(model?.baseUrl, `${ROOT}/v1`);
		strictEqual(model?.reasoning, true);
		deepStrictEqual(model?.input, ["text", "image"]);
		deepStrictEqual(model?.cost, cost);
		strictEqual(model?.contextWindow, 1050000);
		strictEqual(model?.maxTokens, 128000);
		deepStrictEqual(model?.thinkingLevelMap, {
			off: "none",
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	const sol61 = models.find(({ id }) => id === "gpt-6.1-sol");
	strictEqual(sol61?.name, "GPT 6.1 Sol");
	strictEqual(sol61?.api, "openai-responses");
	strictEqual(sol61?.baseUrl, `${ROOT}/v1`);
	strictEqual(sol61?.reasoning, true);
	deepStrictEqual(sol61?.input, ["text", "image"]);
	deepStrictEqual(sol61?.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
	strictEqual(sol61?.contextWindow, 1050000);
	strictEqual(sol61?.maxTokens, 128000);
	deepStrictEqual(sol61?.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	const gemini = models.find(({ id }) => id === "gemini-flash");
	strictEqual(gemini?.baseUrl, `${ROOT}/gemini`);
	const claude = models.find(({ id }) => id === "claude-fable-5");
	strictEqual(claude?.baseUrl, `${ROOT}/anthropic`);
}

function testFilterModels(): void {
	const all = modelsForRoot(ROOT);

	// 无过滤条件：原样返回（新数组，元素不变）。
	const untouched = filterModels(all);
	equal(untouched.length, all.length);
	strictEqual(untouched[0], all[0]);

	// include 是拉回规则，不是全局白名单；未命中任何规则的模型仍保留。
	const includeOnly = filterModels(all, { include: ["glm-5.2"] });
	equal(includeOnly.length, all.length);
	equal(
		includeOnly.some(({ id }) => id === "deepseek-v4-flash"),
		true,
	);
	// 黑名单精确匹配。
	const excluded = filterModels(all, { exclude: ["claude-sonnet-5"] });
	equal(
		excluded.some(({ id }) => id === "claude-sonnet-5"),
		false,
	);
	equal(excluded.length, all.length - 1);

	// 黑名单前缀通配。
	const noGemini = filterModels(all, { exclude: ["gemini-*"] });
	equal(
		noGemini.some(({ id }) => id.startsWith("gemini-")),
		false,
	);

	// 黑白名单并存：include 拉回被系列黑名单排除的精确模型。
	const both = filterModels(all, {
		include: ["glm-5.2", "claude-sonnet-5"],
		exclude: ["glm-*", "claude-*"],
	});
	equal(
		both.some(({ id }) => id === "glm-5.2"),
		true,
	);
	equal(
		both.some(({ id }) => id === "claude-sonnet-5"),
		true,
	);
	equal(
		both.some(({ id }) => id === "glm-5.1"),
		false,
	);
	equal(
		both.some(({ id }) => id === "claude-fable-5"),
		false,
	);
	// 双未命中仍保留。
	equal(
		both.some(({ id }) => id === "deepseek-v4-flash"),
		true,
	);

	// `*` 命中全部，可配合 include 表达“全局只留这些”。
	deepStrictEqual(
		filterModels(all, {
			exclude: ["*"],
			include: ["glm-5.2", "gpt-5.6-*"],
		}).map(({ id }) => id),
		["glm-5.2", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
	);
}

function testNormalizeRoot(): void {
	strictEqual(normalizeRoot(), DEFAULT_ROOT);
	strictEqual(
		normalizeRoot("https://gw.example.com/v1"),
		"https://gw.example.com",
	);
	strictEqual(
		normalizeRoot("https://gw.example.com/v1/"),
		"https://gw.example.com",
	);
	strictEqual(
		normalizeRoot("https://gw.example.com/"),
		"https://gw.example.com",
	);
	strictEqual(
		normalizeRoot("https://gw.example.com/base/v1"),
		"https://gw.example.com/base",
	);
	throws(() => normalizeRoot("ftp://gw.example.com"), /http or https/);
	throws(() => normalizeRoot("not-a-url"), /not a valid URL/);
	equal(PROVIDER_ID, "tsgw");
}

testCatalogConcatenation();
testFilterModels();
testNormalizeRoot();
console.log("catalog.test.ts: all assertions passed");
