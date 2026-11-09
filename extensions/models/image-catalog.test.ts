import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { effectiveModelsForGateway, modelsForRoot } from "./catalog.ts";
import { createPiWithCatalog, TEST_ROOT, withAgentDir, FakePi } from "#tsgw/test-support.test";
import registerTsgw from "../../index.ts";
import { OPENAI_IMAGE_API as IMAGE_API, OPENAI_IMAGE_MODEL_IDS as IMAGE_MODEL_IDS, openaiImageModels as imageModelsForRoot } from "#tsgw/models/vendors/openai";

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

test("图片目录：固定登记不受过滤、网关缺席或未知别名影响，仍遵守宿主能力门", () => {
	const models = imageModelsForRoot(root);
	const filter = Object.freeze({ include: Object.freeze(["gpt-image-unknown"]), exclude: Object.freeze(["*"]) });
	for (const gateway of [undefined, new Set<string>(), new Set([IMAGE_MODEL_IDS[0], "gpt-image-unknown"])]) {
		assert.deepEqual(effectiveModelsForGateway(root, filter, gateway, true, true), models);
		assert.deepEqual(effectiveModelsForGateway(root, filter, gateway, false, true), []);
	}
});

test("图片登记：同一个 tsgw 保留聊天模型并复用宿主密钥声明", async () => {
	const pi = await createPiWithCatalog({ tsgw: { excludeModels: ["gpt-*"] } });
	assert.equal(pi.providers.length, 1);
	const provider = pi.providers[0].config as ProviderConfig;
	assert.equal(provider.apiKey, "$TSGW_API_KEY");
	assert.equal(provider.baseUrl, `${TEST_ROOT}/v1`);
	assert.deepEqual(provider.models?.filter(model => model.type === "image").map(model => model.id), [...IMAGE_MODEL_IDS]);
	assert.ok(provider.models?.some(model => model.id === "deepseek-flash"));
	assert.equal(provider.models?.some(model => model.id === "gpt-6-luna"), false);
	assert.equal(typeof provider.images?.[IMAGE_API]?.generateImages, "function");
	assert.deepEqual(pi.tools.filter(tool => (tool as { namespace?: { name: string } }).namespace?.name === "tsgw_images")
		.map(tool => (tool as { name: string }).name), ["tsgw_generate_image", "tsgw_edit_image"],
		"两个图片工具与原生图片 API 共用 provider");
});

test("图片刷新：无缓存启动固定登记，网关缺席、失败及离线均保留图片", async () => {
	await withAgentDir({ tsgw: { excludeModels: ["gpt-*"] } }, async () => {
		const pi = new FakePi();
		await registerTsgw(pi);
		const provider = pi.providers[0].config as ProviderConfig;
		assert.deepEqual(provider.models?.map(model => model.id), [...IMAGE_MODEL_IDS]);
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
				return Response.json({ data: ["deepseek-flash", "gpt-image-2.6", "gpt-image-unknown"].map(id => ({ id })) });
			};
			const result = await refresh(context);
			assert.deepEqual(result.map(model => model.id), ["deepseek-flash", ...IMAGE_MODEL_IDS]);
			assert.equal(calls, 1);
			assert.deepEqual(await refresh({ ...context, allowNetwork: false }), result);
			assert.equal(calls, 1);
			globalThis.fetch = async () => { calls++; return new Response(null, { status: 503 }); };
			await assert.rejects(refresh(context));
			assert.deepEqual(await refresh({ ...context, allowNetwork: false }), result);
		} finally { globalThis.fetch = originalFetch; }
	});
});
