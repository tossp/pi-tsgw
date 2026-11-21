import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	Model,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	buildDelegationCandidates,
	buildDelegationContext,
	buildDelegationGuide,
	resolveDelegationKeys,
	type DelegationCandidate,
} from "./policy.ts";
import type { CandidateKnowledge } from "./knowledge.ts";

const ALL_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}

function chatModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		provider: "tsgw",
		api: "openai-completions",
		baseUrl: "https://models.example.test/v1",
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		contextWindow: 128_000,
		maxTokens: 32_000,
		...overrides,
	};
}

function candidate(
	key: string,
	id: string,
	level: ModelThinkingLevel,
	instructions = `候选 ${key}`,
): DelegationCandidate {
	return {
		key,
		model: `tsgw/${id}:${level}`,
		provider: "tsgw",
		id,
		level,
		instructions,
	};
}

const KNOWLEDGE: readonly CandidateKnowledge[] = [
	{ id: "alpha", level: "low", suitability: "样本 A", effort: "低档", note: "样本说明 A" },
	{ id: "alpha", level: "high", suitability: "样本 A", effort: "高档", note: "样本说明 A" },
	{ id: "beta", level: "max", suitability: "样本 B", effort: "深档", note: "样本说明 B" },
];
const REVIEW_TARGET = { id: "review-model", level: "medium" } as const;

test("有效候选：目录、会话型号与显式档位取交集，过滤后生成连续 key", () => {
	const model = chatModel("alpha");
	const models = frozen([chatModel("beta"), model, chatModel("unlisted")]);
	const scope = Object.freeze([{ model, thinkingLevel: "high" as const }]);
	const candidates = buildDelegationCandidates(KNOWLEDGE, models, () => ALL_LEVELS, scope);
	assert.deepEqual(candidates.map(entry => [entry.key, entry.model]), [["option_0", "tsgw/alpha:high"]]);
	assert.deepEqual(buildDelegationCandidates(KNOWLEDGE, [], () => ALL_LEVELS, scope), [], "scope 不能补回目录缺席项");
	assert.deepEqual(buildDelegationCandidates(KNOWLEDGE, models, () => ["low"], scope), [], "不支持的档位不能改档加入");
	assert.deepEqual(buildDelegationCandidates(KNOWLEDGE, models, () => ALL_LEVELS,
		[{ model: chatModel("alpha", { provider: "other" }) }]), [], "会话型号匹配必须包含 provider");
	const allLevels = buildDelegationCandidates(KNOWLEDGE, models, () => ALL_LEVELS, [{ model }]);
	assert.deepEqual(allLevels.map(entry => entry.model), ["tsgw/alpha:low", "tsgw/alpha:high"]);
	assert.deepEqual(buildDelegationCandidates(KNOWLEDGE, models, () => ALL_LEVELS)
		.map(entry => [entry.key, entry.model]), [
		["option_0", "tsgw/alpha:low"], ["option_1", "tsgw/alpha:high"], ["option_2", "tsgw/beta:max"],
	]);
});

test("候选过滤：排除其他供应商、非文本聊天和未登记组合", () => {
	const rejected = frozen([
		chatModel("alpha", { provider: "other" }),
		chatModel("alpha", { input: ["image"] }),
		{ ...chatModel("alpha"), type: "classifier" } as unknown as Model<Api>,
		chatModel("unlisted"),
	]);
	assert.deepEqual(buildDelegationCandidates(KNOWLEDGE, rejected, () => ALL_LEVELS), []);
	assert.deepEqual(buildDelegationCandidates(KNOWLEDGE, [chatModel("alpha")], () => []), []);
});

test("接管指导：只呈现传入候选及其说明，不回查推荐表", () => {
	const sample = candidate("option_0", "sample-model", "low", "仅此处提供的独立说明标记");
	const guide = buildDelegationGuide([sample]);
	assert.ok(guide.includes(sample.model));
	assert.ok(guide.includes(sample.instructions));
	const empty = buildDelegationGuide([]);
	const unverified = buildDelegationGuide(undefined);
	assert.notEqual(empty, unverified, "无可选项和核验未完成应分别说明");
	for (const output of [empty, unverified]) {
		assert.ok(output.length > 0);
		assert.equal(output.includes(sample.model), false);
		assert.equal(output.includes("|"), false);
	}
});

test("型号参考表只列本次候选，同一型号的分数和费用只出现一次", () => {
	const models = [chatModel("alpha"), chatModel("beta")];
	const references = frozen({
		alpha: { prices: ["1.10", "2.20"], scores: [60, 61, 62, 63] },
		beta: { prices: ["3.30", "4.40"] },
	} as const);
	const candidates = buildDelegationCandidates(KNOWLEDGE, models, () => ALL_LEVELS, [{ model: models[0]! }], references);
	const question = buildDelegationContext({ prompt: "任务正文" }, candidates).questions.selection;
	assert.equal(question.type, "choice");
	if (question.type !== "choice") return assert.fail("selection 必须是 choice");
	const guide = buildDelegationGuide(candidates);
	for (const material of [question.instructions, guide]) {
		assert.equal(material.match(/\| alpha \|/g)?.length, 1);
		assert.match(material, /\| alpha \| 1\.10 \| 2\.20 \| 60\.0 \| 61\.0 \| 62\.0 \| 63\.0 \| — \|/);
		assert.ok(!material.includes("beta"));
	}
	assert.match(question.criteria.option_0, /alpha.*low/);
	assert.match(question.criteria.option_1, /alpha.*high/);
	assert.doesNotMatch(JSON.stringify(question.criteria), /1\.10|60\.0/);
	assert.match(guide, /tsgw\/alpha:low/);
	assert.match(guide, /tsgw\/alpha:high/);
});

test("上下文：state 只含任务与元数据，kind/selection 结构固定且候选作为 options", () => {
	const candidates = frozen([
		candidate("option_0", "review-model", "max", "候选 A 的说明"),
		candidate("option_1", "worker-model", "max", "候选 B 的说明"),
	]);
	const input = frozen({
		prompt: "任务正文",
		description: "任务描述",
		subagent_type: "general-purpose",
		input_files: ["src/a.ts", "src/b.ts"],
		run_in_background: true,
	});
	const snapshot = JSON.stringify(input);

	const context = buildDelegationContext(input, candidates);
	assert.equal(JSON.stringify(input), snapshot, "不得改写冻结输入");
	assert.deepEqual(Object.keys(context.state), ["task"]);
	const task = context.state.task as Record<string, unknown>;
	assert.deepEqual(task, {
		prompt: "任务正文",
		description: "任务描述",
		subagent_type: "general-purpose",
		input_files: ["src/a.ts", "src/b.ts"],
		run_in_background: true,
	});
	assert.notEqual(task.input_files, input.input_files, "输入文件列表应复制而非共享引用");

	assert.deepEqual(Object.keys(context.questions), ["kind", "selection"]);
	const kind = context.questions.kind;
	assert.equal(kind.type, "choice");
	if (kind.type !== "choice") return assert.fail("kind 必须是 choice");
	assert.deepEqual(
		Object.keys(kind.criteria).sort(),
		["debug", "design_review", "dual_review", "implement", "inspect"],
	);
	assert.ok(kind.instructions.length > 0);

	const selection = context.questions.selection;
	assert.equal(selection.type, "choice");
	if (selection.type !== "choice") return assert.fail("selection 必须是 choice");
	assert.deepEqual(Object.keys(selection.criteria), ["option_0", "option_1", "unresolved"]);
	for (const entry of candidates) {
		assert.equal(selection.criteria[entry.key], entry.instructions);
	}
	assert.ok(selection.criteria.unresolved.length > 0);
	assert.ok(selection.instructions.length > 0);

	const minimal = buildDelegationContext(frozen({ prompt: "只有正文" }), frozen([]));
	assert.deepEqual(minimal.state, { task: { prompt: "只有正文" } });
	const minimalSelection = minimal.questions.selection;
	assert.equal(minimalSelection.type, "choice");
	if (minimalSelection.type !== "choice") return assert.fail("selection 必须是 choice");
	assert.deepEqual(Object.keys(minimalSelection.criteria), ["unresolved"]);
});

test("解析：要求当前候选键，正式审阅匹配固定型号和档位，双审交回主代理", () => {
	const review = candidate("option_0", "review-model", "medium");
	const wrongLevel = candidate("option_1", "review-model", "high");
	const worker = candidate("option_2", "worker-model", "low");
	const candidates = frozen([review, wrongLevel, worker]);
	assert.equal(resolveDelegationKeys("design_review", "option_0", candidates, REVIEW_TARGET), review);
	for (const key of ["option_1", "option_2"])
		assert.equal(resolveDelegationKeys("design_review", key, candidates, REVIEW_TARGET), undefined);
	assert.equal(resolveDelegationKeys("design_review", "option_2", candidates, { id: "worker-model", level: "low" }), worker);
	for (const kind of ["inspect", "implement", "debug"])
		assert.equal(resolveDelegationKeys(kind, "option_2", candidates, REVIEW_TARGET), worker);
	for (const [kind, key] of [["dual_review", "option_0"], ["unknown", "option_0"], ["debug", "unresolved"],
		["debug", "worker-model"], ["debug", "option_9"], [null, "option_0"], ["debug", 2]])
		assert.equal(resolveDelegationKeys(kind, key, candidates, REVIEW_TARGET), undefined);
});
