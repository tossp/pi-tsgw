import { deepStrictEqual, equal, strictEqual, throws } from "node:assert";
import {
	DEFAULT_ROOT,
	filterModels,
	modelsForRoot,
	normalizeRoot,
	PROVIDER_ID,
} from "./catalog.ts";

import { anthropicModels } from "./vendors/anthropic.ts";
import { deepseekModels } from "./vendors/deepseek.ts";
import { geminiModels } from "./vendors/gemini.ts";
import { glmModels } from "./vendors/glm.ts";
import { grokModels } from "./vendors/grok.ts";
import { kimiModels } from "./vendors/kimi.ts";
import { longcatModels } from "./vendors/longcat.ts";
import { mimoModels } from "./vendors/mimo.ts";
import { minimaxModels } from "./vendors/minimax.ts";
import { openaiModels } from "./vendors/openai.ts";
import { qwenModels } from "./vendors/qwen.ts";

const ROOT = "https://aih.example.com";

function testCatalogConcatenation(): void {
	const models = modelsForRoot(ROOT);
	const ids = models.map(({ id }) => id);

	const vendors = [deepseekModels, glmModels, mimoModels, minimaxModels, kimiModels,
		longcatModels, qwenModels, openaiModels, geminiModels, anthropicModels, grokModels];
	deepStrictEqual(models, vendors.flatMap(build => build(ROOT)));
	equal(new Set(ids).size, ids.length, "vendor 拼接后的 ID 全局唯一");
	const endpoints = {
		"openai-completions": "/v1", "openai-responses": "/v1",
		"google-generative-ai": "/gemini", "anthropic-messages": "/anthropic",
	};
	for (const model of models) {
		equal(Object.hasOwn(endpoints, model.api!), true, `未知协议：${model.api}`);
		equal(model.baseUrl, `${ROOT}${endpoints[model.api as keyof typeof endpoints]}`);
	}
}

function testModelCapabilities(): void {
	const models = modelsForRoot(ROOT);
	const ids = models.map(({ id }) => id);

	// 模型 baseUrl 按协议端点派生；DeepSeek 使用官方 Responses 能力。
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
	const deepseekPro = models.find(({ id }) => id === "deepseek-v4-pro");
	strictEqual(deepseekPro?.api, "openai-responses");
	deepStrictEqual(deepseekPro?.input, ["text"]);
	deepStrictEqual(deepseekPro?.compat, deepseek?.compat);
	deepStrictEqual(deepseekPro?.thinkingLevelMap, deepseek?.thinkingLevelMap);
	const glm53Map = { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" };
	for (const [id, input] of [
		["glm-5.3", ["text"]],
		["glm-5.3-flash", ["text", "image"]],
		["glm-5.3-flashx", ["text", "image"]],
		["MiniMax-M3.1-Flash-Preview", ["text", "image"]],
	] as const) {
		const model = models.find((model) => model.id === id)!;
		equal(model.api, "openai-completions");
		equal(model.baseUrl, `${ROOT}/v1`);
		equal(model.reasoning, true);
		deepStrictEqual(model.input, input);
		if (id === "MiniMax-M3.1-Flash-Preview") {
			deepStrictEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "未公布价格使用未知零值");
		}
		equal(model.contextWindow, 1000000);
		equal(model.maxTokens, id.startsWith("MiniMax-") ? 524288 : 131072);
		deepStrictEqual(model.compat, { supportsDeveloperRole: false });
		deepStrictEqual(model.thinkingLevelMap, id.startsWith("MiniMax-")
			? { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } : glm53Map);
	}
	const astra = models.find(({ id }) => id === "gpt-6-astra");
	strictEqual(astra?.api, "openai-responses");
	deepStrictEqual(astra?.input, ["text", "image"]);
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
	for (const modelId of ["gpt-6-sol", "gpt-6-luna"]) {
		const model = models.find(({ id }) => id === modelId);
		strictEqual(model?.api, "openai-responses");
		strictEqual(model?.baseUrl, `${ROOT}/v1`);
		strictEqual(model?.reasoning, true);
		deepStrictEqual(model?.input, ["text", "image"]);
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
	strictEqual(sol61?.api, "openai-responses");
	strictEqual(sol61?.baseUrl, `${ROOT}/v1`);
	strictEqual(sol61?.reasoning, true);
	deepStrictEqual(sol61?.input, ["text", "image"]);
	strictEqual(sol61?.contextWindow, 500000);
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
	const k3 = models.find(({ id }) => id === "kimi-k3")!;
	const k3Short = models.find(({ id }) => id === "kimi-k3-256k")!;
	const { id: _id, name: _name, ...k3Capabilities } = k3;
	const { id: _shortId, name: _shortName, ...shortCapabilities } = k3Short;
	deepStrictEqual(shortCapabilities, { ...k3Capabilities, contextWindow: 262144 });
	equal(k3Short.maxTokens, 131072);
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
	const all = Object.freeze(["alpha", "alpha-one", "alpha-two", "Alpha-one", "beta", "a*b"]
		.map(id => Object.freeze({ id })));
	const untouched = filterModels(all);
	deepStrictEqual(untouched, all);
	equal(untouched === all, false, "返回新数组");
	untouched.forEach((model, index) => strictEqual(model, all[index]));
	const ids = (filter: Parameters<typeof filterModels>[1]) => filterModels(all, filter).map(model => model.id);
	const allIds = all.map(model => model.id);
	deepStrictEqual(ids({}), allIds);
	deepStrictEqual(ids({ include: [], exclude: [] }), allIds);
	deepStrictEqual(ids({ include: ["alpha-one"] }), allIds, "include 不是白名单");
	deepStrictEqual(ids({ exclude: ["alpha"] }), allIds.filter(id => id !== "alpha"), "裸 ID 精确匹配");
	deepStrictEqual(ids({ exclude: ["alpha-*"] }), ["alpha", "Alpha-one", "beta", "a*b"], "尾部 * 且区分大小写");
	const filter = Object.freeze({ exclude: Object.freeze(["alpha-*", "beta"]), include: Object.freeze(["alpha-one"]) });
	deepStrictEqual(ids(filter), ["alpha", "alpha-one", "Alpha-one", "a*b"], "include 拉回，双未命中保留");
	deepStrictEqual(ids({ exclude: ["*"] }), []);
	deepStrictEqual(ids({ exclude: ["*"], include: ["alpha-*", "beta"] }), ["alpha-one", "alpha-two", "beta"]);
	deepStrictEqual(ids({ exclude: ["*"], include: ["unknown", "ALPHA-*"] }), [], "未知 ID 和大小写不匹配不能新增");
	deepStrictEqual(ids({ exclude: ["a*b"] }), allIds.filter(id => id !== "a*b"), "非尾部 * 按字面量匹配");
	deepStrictEqual(filterModels([], { include: ["unknown"] }), []);
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
testModelCapabilities();
testFilterModels();
testNormalizeRoot();
console.log("catalog.test.ts：全部断言通过");
