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

	// 经确认的精简目录：删除 23 个旧 ID，新增 K3 256K，共 36 个。
	equal(ids.length, 36);
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
			`应存在前缀为 ${prefix} 的模型`,
		);
	}

	// 拼接顺序保持目录顺序（deepseek → … → claude → grok）。
	equal(ids[0], "deepseek-flash");
	equal(ids[ids.length - 1], "grok-4.20-fast");

	// 模型 baseUrl 按协议端点派生；DeepSeek 使用官方 Responses 能力。
	const deepseek = models.find(({ id }) => id === "deepseek-flash");
	strictEqual(deepseek?.baseUrl, `${ROOT}/v1`);
	strictEqual(deepseek?.api, "openai-responses");
	deepStrictEqual(deepseek?.input, ["text", "image"]);
	// 国内高峰价按固定 0.1475 USD/CNY 折算；单测固定元数据，不核验实时计费。
	deepStrictEqual(deepseek?.cost, { input: 0.295, output: 1.18, cacheRead: 0.0059, cacheWrite: 0 });
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
	deepStrictEqual(models.filter(({ id }) => id.startsWith("deepseek-")).map(({ id }) => id), ["deepseek-flash", "deepseek-v4-pro"]);
	const deepseekPro = models.find(({ id }) => id === "deepseek-v4-pro");
	strictEqual(deepseekPro?.api, "openai-responses");
	deepStrictEqual(deepseekPro?.input, ["text"]);
	deepStrictEqual(deepseekPro?.cost, { input: 1.3275, output: 3.9825, cacheRead: 0.04425, cacheWrite: 0 });
	deepStrictEqual(deepseekPro?.compat, deepseek?.compat);
	deepStrictEqual(deepseekPro?.thinkingLevelMap, deepseek?.thinkingLevelMap);
	deepStrictEqual(
		models.filter(({ id }) => id.startsWith("mimo-")).map(({ id }) => id),
		["mimo-v2.6-pro", "mimo-v2.6-flash"],
	);
	const minimaxIds = models
		.filter(({ id }) => id.startsWith("MiniMax-"))
		.map(({ id }) => id);
	deepStrictEqual(minimaxIds, [
		"MiniMax-M3.1-Flash-Preview",
		"MiniMax-M3",
	]);
	deepStrictEqual(models.filter(({ id }) => id.startsWith("glm-")).map(({ id }) => id), [
		"glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "glm-5.2", "glm-4.5-air",
	]);
	const glm53Map = { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };
	for (const [id, name, input, cost] of [
		["glm-5.3", "GLM 5.3", ["text"], { input: 1.18, output: 4.13, cacheRead: 0.295, cacheWrite: 0 }],
		["glm-5.3-flash", "GLM 5.3 Flash", ["text", "image"], { input: 0.118, output: 0.413, cacheRead: 0.033925, cacheWrite: 0 }],
		["glm-5.3-flashx", "GLM 5.3 FlashX", ["text", "image"], { input: 0.295, output: 1.0325, cacheRead: 0.084075, cacheWrite: 0 }],
		["MiniMax-M3.1-Flash-Preview", "MiniMax-M3.1-Flash-Preview", ["text", "image"], { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
	] as const) {
		const model = models.find((model) => model.id === id)!;
		equal(model.name, name);
		equal(model.api, "openai-completions");
		equal(model.baseUrl, `${ROOT}/v1`);
		equal(model.reasoning, true);
		deepStrictEqual(model.input, input);
		deepStrictEqual(model.cost, cost);
		equal(model.contextWindow, 1000000);
		equal(model.maxTokens, id.startsWith("MiniMax-") ? 524288 : 131072);
		deepStrictEqual(model.compat, { supportsDeveloperRole: false });
		deepStrictEqual(model.thinkingLevelMap, id.startsWith("MiniMax-")
			? { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } : glm53Map);
	}
	const openaiIds = models
		.filter(({ id }) => id.startsWith("gpt-"))
		.map(({ id }) => id);
	deepStrictEqual(openaiIds, [
		"gpt-6-astra",
		"gpt-6.1-sol",
		"gpt-6-sol",
		"gpt-6-luna",
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
	deepStrictEqual(models.filter(({ id }) => id.startsWith("kimi-")).map(({ id }) => id), ["kimi-k3", "kimi-k3-256k"]);
	const k3 = models.find(({ id }) => id === "kimi-k3")!;
	const k3Short = models.find(({ id }) => id === "kimi-k3-256k")!;
	deepStrictEqual(k3Short, { ...k3, id: "kimi-k3-256k", name: "Kimi K3 (256K)", contextWindow: 262144 });
	equal(k3Short.maxTokens, 131072);
	deepStrictEqual(models.filter(({ id }) => id.startsWith("gemini-")).map(({ id }) => id), [
		"gemini-flash", "gemini-pro", "gemini-3.5-flash", "gemini-3.5-flash-low", "gemini-3.5-flash-extra-low",
	]);
	const removed = [
		"deepseek-v4-flash", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5",
		"MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "kimi-for-coding", "kimi-k2.7-code",
		"kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "gpt-5.6-sol", "gpt-5.6-terra",
		"gpt-5.6-luna", "gpt-5.5", "gemini-3.1-pro-low", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
	];
	for (const id of removed) equal(ids.includes(id), false, `已移除的 ID：${id}`);
	// 用户 include 规则不能恢复已移除的静态 ID。
	deepStrictEqual(modelsForRoot(ROOT, { exclude: ["*"], include: removed }), []);
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
		includeOnly.some(({ id }) => id === "deepseek-flash"),
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
		both.some(({ id }) => id === "glm-5.3"),
		false,
	);
	equal(
		both.some(({ id }) => id === "claude-fable-5"),
		false,
	);
	// 双未命中仍保留。
	equal(
		both.some(({ id }) => id === "deepseek-flash"),
		true,
	);

	// `*` 命中全部，可配合 include 表达“全局只留这些”。
	deepStrictEqual(
		filterModels(all, {
			exclude: ["*"],
			include: ["glm-5.2", "gpt-6-*"],
		}).map(({ id }) => id),
		["glm-5.2", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
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
	throws(() => normalizeRoot("ftp://gw.example.com"));
	throws(() => normalizeRoot("not-a-url"));
	equal(PROVIDER_ID, "tsgw");
}

testCatalogConcatenation();
testFilterModels();
testNormalizeRoot();
console.log("catalog.test.ts：全部断言通过");
