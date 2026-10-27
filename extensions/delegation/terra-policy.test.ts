import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels, type ClassifierChoiceAnswer } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openaiModels } from "../models/vendors/openai.ts";
import { buildDelegationCandidates, buildDelegationContext, buildDelegationGuide, resolveDelegationChoice } from "./policy.ts";

// 真实 vendor 与宿主注册表；隔离凭据、个人配置和网络。
const runtime = await ModelRuntime.create({
	credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
	modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
});
runtime.registerProvider("tsgw", { models: openaiModels("https://models.example.test") });
const models = runtime.getModels("tsgw");

function choice(selected: string): ClassifierChoiceAnswer {
	return { type: "choice", choice: selected, probabilities: { [selected]: 0.5 }, confidence: 0.5 };
}

test("Terra：真实目录生成 medium 定向候选，分类与失败指导同源", () => {
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels);
	const terra = candidates.find(entry => entry.id === "gpt-6.1-terra");
	assert.ok(terra);
	assert.equal(terra.level, "medium");
	assert.equal(terra.model, "tsgw/gpt-6.1-terra:medium");
	for (const model of ["tsgw/gpt-6-luna:high", "tsgw/gpt-6.1-sol:high", "tsgw/gpt-6-astra:max"]) {
		assert.ok(candidates.some(entry => entry.model === model), `${model} 不应被 Terra 替换`);
	}
	const context = buildDelegationContext({ prompt: "核对截图中的界面元素" }, candidates);
	const selection = context.questions.selection;
	assert.equal(selection.type, "choice");
	if (selection.type !== "choice") return assert.fail("selection 必须是 choice");
	assert.equal(selection.criteria[terra.key], terra.instructions);
	const guide = buildDelegationGuide(candidates);
	assert.ok(guide.includes(`| ${terra.model} | 可用 |`));
	assert.equal(guide.includes(`| ${terra.model} | 不可用 |`), false);

	// 缺少 medium 时不改档补入；目录缺席时不得加入候选。
	assert.equal(buildDelegationCandidates(models, () => ["low", "high"]).some(entry => entry.id === terra.id), false);
	const absent = buildDelegationCandidates(models.filter(model => model.id !== terra.id), getSupportedThinkingLevels);
	assert.equal(absent.some(entry => entry.id === terra.id), false);
	assert.ok(buildDelegationGuide(absent).includes(`| ${terra.model} | 不可用 |`));
});

test("Terra：定向任务可选，不替代正式审阅与显式双审", () => {
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels);
	const terra = candidates.find(entry => entry.id === "gpt-6.1-terra")!;
	const astra = candidates.find(entry => entry.id === "gpt-6-astra" && entry.level === "max")!;
	assert.ok(terra && astra);
	for (const kind of ["inspect", "implement", "debug"]) {
		assert.equal(resolveDelegationChoice({ kind: choice(kind), selection: choice(terra.key) }, candidates), terra);
	}
	for (const kind of ["design_review", "dual_review"]) {
		assert.equal(resolveDelegationChoice({ kind: choice(kind), selection: choice(terra.key) }, candidates), undefined);
	}
	assert.equal(resolveDelegationChoice({ kind: choice("design_review"), selection: choice(astra.key) }, candidates), astra);
});
