import { deepStrictEqual, equal, strictEqual, throws } from "node:assert";
import {
	DEFAULT_ROOT,
	effectiveModelsForGateway,
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
import { openaiImageModels, openaiModels } from "./vendors/openai.ts";
import { typesafeClassifierModels } from "./vendors/typesafe.ts";
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
		const endpoint = model.id === "gemini-3.8-flash-high" ? "/gemini/v1beta"
			: endpoints[model.api as keyof typeof endpoints];
		equal(model.baseUrl, `${ROOT}${endpoint}`);
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
		["MiniMax-M3.1-Flash", ["text", "image"]],
	] as const) {
		const model = models.find((model) => model.id === id)!;
		const minimax = id === "MiniMax-M3.1-Flash";
		equal(model.api, minimax ? "anthropic-messages" : "openai-completions");
		equal(model.baseUrl, `${ROOT}/${minimax ? "anthropic" : "v1"}`);
		equal(model.reasoning, true);
		deepStrictEqual(model.input, input);
		if (id === "MiniMax-M3.1-Flash") {
			deepStrictEqual(model.cost, { input: 0.1475, output: 0.59, cacheRead: 0.01475, cacheWrite: 0 });
		}
		equal(model.contextWindow, 1000000);
		equal(model.maxTokens, id.startsWith("MiniMax-") ? 524288 : 131072);
		deepStrictEqual(model.compat, minimax ? { forceAdaptiveThinking: true, allowEmptySignature: true } : { supportsDeveloperRole: false });
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
	const k31 = models.find(({ id }) => id === "kimi-k3.1-pro")!;
	equal(k31.api, "openai-completions");
	equal(k31.baseUrl, `${ROOT}/v1`);
	deepStrictEqual(k31.input, ["text", "image"]);
	equal(k31.reasoning, true);
	equal(k31.contextWindow, 1048576);
	equal(k31.maxTokens, 1048576);
	deepStrictEqual(k31.cost, { input: 1.9175, output: 10.03, cacheRead: 0.19175, cacheWrite: 1.9175 });
	deepStrictEqual(k31.thinkingLevelMap, {
		off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max",
	});
	const removed = [
		"deepseek-v4-flash", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5",
		"MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M3.1-Flash-Preview", "kimi-for-coding", "kimi-k2.7-code",
		"kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "gpt-5.6-sol", "gpt-5.6-terra",
		"gpt-5.6-luna", "gpt-5.5", "gemini-3.1-pro-low", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
		"qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus", "claude-fable-5", "grok-4.20", "grok-4.20-fast",
		"grok-4.3-low", "grok-4.3-medium", "grok-4.3-high",
	];
	for (const id of removed) equal(ids.includes(id), false, `已移除的 ID：${id}`);
	// 用户 include 规则不能恢复已移除的静态 ID。
	deepStrictEqual(modelsForRoot(ROOT, { exclude: ["*"], include: removed }), []);
	const gemini = models.find(({ id }) => id === "gemini-flash");
	strictEqual(gemini?.baseUrl, `${ROOT}/gemini`);
	const qwen = models.find(({ id }) => id === "qwen3.7-plus");
	strictEqual(qwen?.api, "openai-completions");
	strictEqual(qwen?.baseUrl, `${ROOT}/v1`);
	strictEqual(qwen?.reasoning, true);
	deepStrictEqual(qwen?.input, ["text", "image"]);
	strictEqual(qwen?.maxTokens, 64000);
	for (const id of ["claude-opus-5", "claude-sonnet-5"]) {
		const claude = models.find(model => model.id === id);
		strictEqual(claude?.api, "anthropic-messages");
		strictEqual(claude?.baseUrl, `${ROOT}/anthropic`);
	}
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
	deepStrictEqual(ids({ exclude: ["alpha-*"] }), ["alpha", "beta", "a*b"], "尾部 * 忽略大小写");
	deepStrictEqual(ids({ exclude: ["ALPHA-ONE"] }), ["alpha", "alpha-two", "beta", "a*b"], "裸 ID 忽略大小写且不匹配其他后缀");
	const filter = Object.freeze({ exclude: Object.freeze(["alpha-*", "beta"]), include: Object.freeze(["alpha-one"]) });
	deepStrictEqual(ids(filter), ["alpha", "alpha-one", "Alpha-one", "a*b"], "include 拉回，双未命中保留");
	deepStrictEqual(ids({ exclude: ["*"] }), []);
	deepStrictEqual(ids({ exclude: ["*"], include: ["alpha-*", "beta"] }), ["alpha-one", "alpha-two", "Alpha-one", "beta"]);
	deepStrictEqual(ids({ exclude: ["*"], include: ["unknown", "ALPHA-*"] }), ["alpha-one", "alpha-two", "Alpha-one"], "通配 include 忽略大小写且不能新增未知 ID");
	const mixedFilter = Object.freeze({ exclude: Object.freeze(["ALPHA-*", "BETA"]), include: Object.freeze(["aLpHa-OnE"]) });
	const selected = filterModels(all, mixedFilter);
	deepStrictEqual(selected.map(model => model.id), ["alpha", "alpha-one", "Alpha-one", "a*b"], "混合大小写仍遵循 include 优先");
	selected.forEach(model => strictEqual(model, all.find(original => original.id === model.id), "保留原始 ID 和对象引用"));
	deepStrictEqual(ids({ exclude: ["A*B"] }), allIds.filter(id => id !== "a*b"), "非尾部 * 按字面量匹配且忽略大小写");
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

function testEffectiveCatalog(): void {
	const chats = modelsForRoot(ROOT);
	const images = openaiImageModels(ROOT);
	const classifiers = typesafeClassifierModels(ROOT);
	const all = [...chats, ...images, ...classifiers];
	const gateway = new Set(all.map(model => model.id));
	const before = [...gateway];
	for (const imagesEnabled of [false, true]) {
		for (const classifiersEnabled of [false, true]) {
			const expected = [...chats, ...(imagesEnabled ? images : []), ...(classifiersEnabled ? classifiers : [])];
			deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, gateway, imagesEnabled, classifiersEnabled), expected);
		}
	}
	deepStrictEqual([...gateway], before, "不修改传入网关集合");
	const filter = Object.freeze({ exclude: Object.freeze(["*"]), include: Object.freeze(["*"]) });
	deepStrictEqual(effectiveModelsForGateway(ROOT, filter, undefined, true, true), [], "没有网关目录不能回退静态目录");
	deepStrictEqual(effectiveModelsForGateway(ROOT, filter, new Set(), true, true), [], "include 不能突破空网关交集");
	const kimiId = "kimi-k3.1-pro";
	const unselectedKimiIds = ["k3.1-pro", "k3.1-pro-highspeed", "kimi-k3.1-pro-highspeed"];
	const kimiGateway = new Set([kimiId, ...unselectedKimiIds]);
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, kimiGateway, false, false).map(model => model.id),
		[kimiId], "K3.1 只登记带 Kimi 前缀的普通版，不自动登记其他渠道或高速版");
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, new Set(unselectedKimiIds), false, false),
		[], "无前缀或高速版 ID 不代替用户选定的普通版");
	deepStrictEqual(effectiveModelsForGateway(ROOT, { exclude: ["kimi-*"] }, kimiGateway, false, false),
		[], "新增 Kimi 不绕过用户过滤");
	deepStrictEqual(modelsForRoot(ROOT, { exclude: ["*"], include: unselectedKimiIds }), [],
		"include 不增加未登记的 K3.1 渠道或高速版");
	const minimaxId = "MiniMax-M3.1-Flash";
	deepStrictEqual(effectiveModelsForGateway(ROOT, { exclude: ["MINIMAX-*"], include: ["minimax-m3.1*"] },
		new Set([minimaxId, "MiniMax-M3"]), false, false).map(model => model.id),
		[minimaxId], "系列过滤忽略大小写，但不改写发送模型 ID");
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, new Set([minimaxId]), false, false).map(model => model.id),
		[minimaxId], "正式版精确 ID 可通过网关交集");
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, new Set([minimaxId.toLowerCase()]), false, false),
		[], "正式版仍区分大小写");
	deepStrictEqual(effectiveModelsForGateway(ROOT, { exclude: ["MiniMax-*"] }, new Set([minimaxId]), false, false),
		[], "登记不绕过用户排除配置");
	// 预览版已退役：网关目录重新出现也不得恢复登记，include 也不能拉回。
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined,
		new Set(["MiniMax-M3.1-Flash-Preview", minimaxId]), false, false).map(model => model.id),
		[minimaxId], "已退役的 Preview 不被网关条目恢复");
	deepStrictEqual(effectiveModelsForGateway(ROOT, { exclude: ["*"], include: ["MiniMax-M3.1-Flash-Preview"] },
		new Set(["MiniMax-M3.1-Flash-Preview", minimaxId]), false, false),
		[], "已退役的 Preview 不能被 include 恢复");
	const selected = [chats[0].id, images[0].id, classifiers[0].id];
	const prefixed = new Set(selected.map(id => `vendor/${id}`));
	prefixed.add("vendor/not-registered");
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, prefixed, true, true).map(model => model.id), selected,
		"精确登记的型号可匹配网关厂商前缀，未知型号不自动登记");
	const mixed = new Set([chats[0].id, images[0].id, classifiers[0].id]);
	deepStrictEqual(effectiveModelsForGateway(ROOT, { exclude: ["*"], include: [images[0].id] }, mixed, true, true).map(model => model.id),
		[images[0].id], "include 在交集中优先拉回，但不拉回其他型号");
	deepStrictEqual(effectiveModelsForGateway(ROOT, { exclude: ["*"], include: [images[1].id] }, mixed, true, true), [],
		"include 不能恢复网关缺席的静态型号");
	deepStrictEqual(effectiveModelsForGateway(ROOT, filter, mixed, false, false).map(model => model.id), [chats[0].id],
		"include 不能突破宿主能力门");
	deepStrictEqual(effectiveModelsForGateway(ROOT, undefined, new Set([`vendor/${classifiers[0].id.toUpperCase()}`, `${images[0].id}-extra`]), true, true), [],
		"匹配区分大小写且不接受型号后缀扩展");
	deepStrictEqual(modelsForRoot(ROOT), chats, "混合目录调用不污染聊天目录");
}

testCatalogConcatenation();
testModelCapabilities();
testFilterModels();
testNormalizeRoot();
testEffectiveCatalog();
console.log("catalog.test.ts：全部断言通过");
