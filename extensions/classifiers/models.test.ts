import assert from "node:assert/strict";
import { test } from "node:test";
import { typesafeClassifierModels } from "../models/vendors/typesafe.ts";
import {
	CLASSIFIER_API,
	CLASSIFIER_MODEL_IDS,
	classifierModelsForRoot,
	supportsClassifierModels,
} from "./models.ts";

const root = "https://classifiers.example.test/gateway";

test("分类能力入口直接复用 TypeSafe 厂商目录", () => {
	assert.equal(classifierModelsForRoot, typesafeClassifierModels);
});

test("分类目录：逐 ID 登记文本能力、64k 窗口和参考价格", () => {
	assert.deepEqual([...CLASSIFIER_MODEL_IDS], ["jev-latest", "jev-preview"]);
	const models = classifierModelsForRoot(root);
	assert.deepEqual(models.map((model) => model.id), [...CLASSIFIER_MODEL_IDS]);
	for (const model of models) {
		assert.equal(model.type, "classifier");
		assert.equal(model.api, CLASSIFIER_API);
		assert.equal(model.baseUrl, `${root}/v1`);
		assert.deepEqual(model.input, ["text"]);
		assert.equal(model.contextWindow, 64_000);
		assert.deepEqual(model.cost, { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 });
		assert.equal("output" in model, false, "分类模型不声明图片输出");
		assert.equal("maxTokens" in model, false, "分类模型不套用聊天最大输出字段");
		assert.equal("reasoning" in model, false, "分类模型不声明思考能力");
	}
});

test("分类目录：每次构造独立，价格对象不共享；根地址尾部斜杠不重复", () => {
	const first = classifierModelsForRoot(root);
	const second = classifierModelsForRoot(`${root}/`);
	first[0].cost.input = 99;
	first[0].input.push("image");
	assert.equal(second[0].cost.input, 0.042, "不同调用不共享可变价格对象");
	assert.deepEqual(second[0].input, ["text"], "不同调用不共享可变输入能力");
	assert.equal(second[0].baseUrl, `${root}/v1`);
	assert.equal(second[1].baseUrl, `${root}/v1`);
});

test("分类目录：可整体冻结，不依赖聊天或图片目录", () => {
	const models = Object.freeze(classifierModelsForRoot(root).map((model) => Object.freeze(model)));
	assert.deepEqual(models.map((model) => model.id), [...CLASSIFIER_MODEL_IDS]);
	for (const model of models) {
		assert.equal(model.type, "classifier");
		assert.equal(model.input.includes("image"), false);
	}
});

test("分类宿主基线：仅 1.2.0 及以上稳定版本启用", () => {
	for (const version of ["0.82.0", "1.0.0", "1.1.9", "1.2.0-beta", "1.2.0-rc.1", "unknown", "1.2", ""]) {
		assert.equal(supportsClassifierModels(version), false, version);
	}
	for (const version of ["1.2.0", "1.3.0", "2.0.0", "1.2.0+test"]) {
		assert.equal(supportsClassifierModels(version), true, version);
	}
});
