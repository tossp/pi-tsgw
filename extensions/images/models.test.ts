import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { filterModels, modelsForRoot } from "../models/catalog.ts";
import { createPiWithCatalog, TEST_ROOT, withAgentDir, FakePi } from "../test-support.test.ts";
import registerTsgw from "../../index.ts";
import { IMAGE_API, IMAGE_MODEL_IDS, imageModelsForRoot, supportsImageModels } from "./models.ts";

const root = "https://images.example.test/prefix";

test("图片目录：仅两个精确 ID，能力、地址与未知价格显式声明", () => {
	const models = imageModelsForRoot(root);
	assert.deepEqual(models.map(model => model.id), [...IMAGE_MODEL_IDS]);
	for (const model of models) {
		assert.equal(model.type, "image");
		assert.equal(model.api, IMAGE_API);
		assert.equal(model.baseUrl, `${root}/v1`);
		assert.deepEqual(model.input, ["text", "image"]);
		assert.deepEqual(model.output, ["image"]);
		assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal("reasoning" in model, false);
		assert.equal("contextWindow" in model, false);
		assert.equal("maxTokens" in model, false);
	}
	models[0].cost.input = 99;
	assert.equal(models[1].cost.input, 0, "同一目录的不同模型不共享可变价格对象");
	assert.equal(imageModelsForRoot(root)[0].cost.input, 0, "每次构造独立目录，不共享可变价格对象");
	assert.equal(modelsForRoot(root).some(model => model.id.startsWith("gpt-image-")), false,
		"原聊天目录不混入图片，聊天策略和模型选择不受影响");
});

test("图片目录：沿用 include 优先与尾部前缀规则，不修改冻结输入", () => {
	const models = Object.freeze(imageModelsForRoot(root).map(model => Object.freeze(model)));
	const filters = Object.freeze({ include: Object.freeze(["gpt-image-2.5*"]), exclude: Object.freeze(["gpt-*"]) });
	assert.deepEqual(filterModels(models, filters), models);
	assert.deepEqual(filterModels(models, { exclude: ["gpt-*"] }), []);
	assert.deepEqual(filterModels(models, { include: [IMAGE_MODEL_IDS[1]], exclude: ["gpt-*"] }).map(model => model.id), [IMAGE_MODEL_IDS[1]]);
	assert.equal(filterModels(models, { include: ["gpt-image-2.5"], exclude: ["gpt-*"] }).length, 0,
		"裸别名不是已登记模型，精确 include 不隐式扩展");
});

test("图片宿主基线：Pi 1.2 起启用，不抬高聊天模型最低兼容版本", () => {
	for (const version of ["0.82.0", "1.0.0", "1.1.9", "1.2.0-beta", "unknown", "1.2", ""]) {
		assert.equal(supportsImageModels(version), false, version);
	}
	for (const version of ["1.2.0", "1.3.0", "2.0.0", "1.2.0+test"]) {
		assert.equal(supportsImageModels(version), true, version);
	}
});

test("图片登记：同一个 tsgw 保留聊天模型并复用宿主密钥声明", async () => {
	const pi = await createPiWithCatalog({ tsgw: { includeModels: ["gpt-image-2.5*"], excludeModels: ["gpt-*"] } });
	assert.equal(pi.providers.length, 1);
	const provider = pi.providers[0].config as ProviderConfig;
	assert.equal(provider.apiKey, "$TSGW_API_KEY");
	assert.equal(provider.baseUrl, `${TEST_ROOT}/v1`);
	assert.deepEqual(provider.models?.filter(model => model.type === "image").map(model => model.id), [...IMAGE_MODEL_IDS]);
	assert.ok(provider.models?.some(model => model.id === "deepseek-flash"));
	assert.equal(provider.models?.some(model => model.id === "gpt-6-luna"), false);
	assert.equal(typeof provider.images?.[IMAGE_API]?.generateImages, "function");
	assert.deepEqual(pi.tools.map(tool => (tool as { name: string }).name),
		["upload_local_file", "tsgw_generate_image", "tsgw_edit_image", "tsgw_refresh_models", "tsgw_search"],
		"两个图片工具与原生图片 API 共用 provider");
});

test("图片刷新：include 不突破网关交集，失败与离线保留混合目录", async () => {
	await withAgentDir({ tsgw: { includeModels: ["gpt-image-2.5*"], excludeModels: ["gpt-*"] } }, async () => {
		const pi = new FakePi();
		await registerTsgw(pi);
		const provider = pi.providers[0].config as ProviderConfig;
		const refresh = provider.refreshModels as (context: {
			credential: { type: "api_key"; key: string }; allowNetwork: boolean; force: boolean; signal: AbortSignal;
		}) => Promise<NonNullable<ProviderConfig["models"]>>;
		const context = { credential: { type: "api_key" as const, key: "image-catalog-dummy" },
			allowNetwork: true, force: true, signal: new AbortController().signal };
		const originalFetch = globalThis.fetch;
		let calls = 0;
		try {
			globalThis.fetch = async () => {
				calls++;
				return Response.json({ data: ["deepseek-flash", IMAGE_MODEL_IDS[1], "gpt-image-2.5", "gpt-image-2"].map(id => ({ id })) });
			};
			const result = await refresh(context);
			assert.deepEqual(result.map(model => model.id), ["deepseek-flash", IMAGE_MODEL_IDS[1]]);
			assert.equal(calls, 1);
			assert.deepEqual(await refresh({ ...context, allowNetwork: false }), result);
			assert.equal(calls, 1);
			globalThis.fetch = async () => { calls++; return new Response(null, { status: 503 }); };
			await assert.rejects(refresh(context));
			assert.deepEqual(await refresh({ ...context, allowNetwork: false }), result);
		} finally { globalThis.fetch = originalFetch; }
	});
});
