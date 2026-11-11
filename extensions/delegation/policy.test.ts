import assert from "node:assert/strict";
import test from "node:test";
import type {
	Api,
	ClassifierApi,
	ClassifierChoiceAnswer,
	ClassifierModel,
	ClassifierResult,
	Model,
	ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	buildDelegationCandidates,
	buildDelegationContext,
	buildDelegationGuide,
	chooseClassifier,
	resolveDelegationChoice,
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

function classifierModel(
	id: string,
	overrides: Partial<ClassifierModel<ClassifierApi>> = {},
): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id,
		name: id,
		provider: "tsgw",
		api: "typesafe-system-one",
		baseUrl: "https://models.example.test/v1",
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 64_000,
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

function choice(
	selected: string,
	probabilities: Record<string, number> = { [selected]: 0.5 },
	confidence = 0.5,
): ClassifierChoiceAnswer {
	return { type: "choice", choice: selected, probabilities, confidence };
}

function answers(
	kind: ClassifierChoiceAnswer,
	selection: ClassifierChoiceAnswer,
): ClassifierResult["answers"] {
	return { kind, selection };
}

const KNOWLEDGE: readonly CandidateKnowledge[] = [
	{ id: "alpha", level: "low", suitability: "样本 A", effort: "低档", inputPrice: "1", outputPrice: "2", note: "样本说明 A" },
	{ id: "alpha", level: "high", suitability: "样本 A", effort: "高档", inputPrice: "1", outputPrice: "2", note: "样本说明 A" },
	{ id: "beta", level: "max", suitability: "样本 B", effort: "深档", inputPrice: "3", outputPrice: "4", note: "样本说明 B" },
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

test("解析：按 choice key 选择当前候选，不按置信度或最高概率改选", () => {
	const first = candidate("option_0", "sample-a", "low");
	const second = candidate("option_1", "sample-b", "high");
	const candidates = frozen([first, second]);
	const selected = resolveDelegationChoice(answers(
		choice("implement", { implement: 0.2, inspect: 0.1 }, 0),
		choice("option_1", { option_0: 0.99, option_1: 0.01 }, 0),
	), candidates, REVIEW_TARGET);
	assert.equal(selected, second);
	assert.equal(resolveDelegationChoice(
		answers(choice("debug"), choice("unresolved")), candidates, REVIEW_TARGET,
	), undefined);
	assert.equal(resolveDelegationChoice(
		answers(choice("debug"), choice("sample-a")), candidates, REVIEW_TARGET,
	), undefined, "型号名不是当前候选 key");
});

test("解析：正式审阅匹配传入的型号和档位，双审交回主代理", () => {
	const review = candidate("option_0", "review-model", "medium");
	const wrongLevel = candidate("option_1", "review-model", "high");
	const other = candidate("option_2", "worker-model", "low");
	const candidates = frozen([review, wrongLevel, other]);
	assert.equal(resolveDelegationChoice(
		answers(choice("design_review"), choice("option_0")), candidates, REVIEW_TARGET,
	), review);
	for (const key of ["option_1", "option_2"]) {
		assert.equal(resolveDelegationChoice(
			answers(choice("design_review"), choice(key)), candidates, REVIEW_TARGET,
		), undefined);
	}
	assert.equal(resolveDelegationChoice(
		answers(choice("design_review"), choice("option_2")), candidates, { id: "worker-model", level: "low" },
	), other, "审阅目标来自传入数据，不绑定实际配置或最高档位");
	assert.equal(resolveDelegationChoice(
		answers(choice("dual_review"), choice("option_0")), candidates, REVIEW_TARGET,
	), undefined);
	for (const candidate of candidates) {
		for (const kind of ["inspect", "implement", "debug"])
			assert.equal(resolveDelegationChoice(answers(choice(kind), choice(candidate.key)), candidates, REVIEW_TARGET), candidate);
	}
});

test("解析：非法结构、越界概率、缺少所选概率、未知 kind 与不在候选中的选择均拒绝", () => {
	const validKind = choice("implement");
	const validSelection = choice("option_2");
	const candidates = frozen([
		candidate("option_0", "review-model", "max"),
		candidate("option_2", "worker-model", "max"),
	]);

	const malformed: unknown[] = [
		null,
		[],
		{},
		{ kind: validKind },
		{ selection: validSelection },
		{ kind: { ...validKind, type: "score" }, selection: validSelection },
		{ kind: validKind, selection: { ...validSelection, type: "bool" } },
		{ kind: { ...validKind, choice: "unknown" }, selection: validSelection },
		{ kind: { ...validKind, choice: 3 }, selection: validSelection },
		{ kind: validKind, selection: { ...validSelection, choice: null } },
		{ kind: validKind, selection: { ...validSelection, probabilities: null } },
		{ kind: validKind, selection: { ...validSelection, probabilities: [] } },
		{ kind: { ...validKind, probabilities: {} }, selection: validSelection },
		{ kind: validKind, selection: { ...validSelection, probabilities: {} } },
		{ kind: validKind, selection: { ...validSelection, probabilities: { option_0: 0.9 } } },
		{ kind: validKind, selection: { ...validSelection, probabilities: Object.create({ option_2: 0.9 }) } },
		{ kind: { ...validKind, probabilities: { implement: Number.NaN } }, selection: validSelection },
		{ kind: { ...validKind, probabilities: { implement: Number.POSITIVE_INFINITY } }, selection: validSelection },
		{ kind: validKind, selection: { ...validSelection, probabilities: { option_2: -0.01 } } },
		{ kind: validKind, selection: { ...validSelection, probabilities: { option_2: 1.01 } } },
		{ kind: validKind, selection: { ...validSelection, probabilities: { option_2: "0.5" } } },
		{ kind: validKind, selection: { ...validSelection, probabilities: { option_2: 0.5, extra: Number.NaN } } },
		{ kind: { ...validKind, confidence: 1.01 }, selection: validSelection },
		{ kind: validKind, selection: { ...validSelection, confidence: -0.01 } },
		{ kind: validKind, selection: { ...validSelection, confidence: Number.NaN } },
		{ kind: validKind, selection: { ...validSelection, confidence: "0.5" } },
		{ kind: validKind, selection: { ...validSelection, choice: "option_9" } },
	];

	for (const value of malformed) {
		assert.equal(
			resolveDelegationChoice(value as ClassifierResult["answers"], candidates, REVIEW_TARGET),
			undefined,
		);
	}
});

test("分类器：已知正价按参考费率选择，未知/零价末组按 id 字典序", () => {
	const cheap = classifierModel("zeta", {
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
	});
	const alphaTie = classifierModel("alpha", {
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
	});
	const betaTie = classifierModel("beta", {
		cost: { input: 0.2, output: 0.1, cacheRead: 0, cacheWrite: 0 },
	});
	const expensive = classifierModel("mid", {
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	});
	const zero = classifierModel("aaa", {
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const zeroOutput = classifierModel("zero-output", {
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const otherProvider = classifierModel("cheap-other", {
		provider: "other",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const imageOnly = classifierModel("cheap-image", {
		input: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const negative = classifierModel("negative", {
		cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
	});
	const nan = classifierModel("nan", {
		cost: { input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 },
	});
	const infinite = classifierModel("infinite", {
		cost: { input: Number.POSITIVE_INFINITY, output: 0, cacheRead: 0, cacheWrite: 0 },
	});

	const models = frozen([
		zero,
		expensive,
		betaTie,
		otherProvider,
		imageOnly,
		alphaTie,
		nan,
		negative,
		infinite,
		cheap,
	]);
	assert.equal(chooseClassifier(models), cheap, "不固定 ID，也不依赖数组顺序");
	assert.equal(chooseClassifier(frozen([betaTie, zero, alphaTie])), alphaTie, "同价按 id 字典序");
	assert.equal(
		chooseClassifier(frozen([zero, zeroOutput])),
		zeroOutput,
		"仅输出价为零不等同总价未知",
	);
	assert.equal(chooseClassifier(frozen([zero, negative, nan, infinite])), zero, "全部未知/零价时仍返回可用候选");
	assert.equal(
		chooseClassifier(frozen([otherProvider, imageOnly])),
		undefined,
		"无 tsgw 文本分类模型时不返回候选",
	);
});

test("分类器：缺失/非法价格不会丢弃文本候选，唯一未知价格仍可选择", () => {
	const missing = classifierModel("alpha-missing");
	delete (missing as Partial<ClassifierModel<ClassifierApi>>).cost;
	const invalid = classifierModel("invalid-cost", {
		cost: { input: -1, output: 2, cacheRead: 0, cacheWrite: 0 },
	});
	const zero = classifierModel("alpha-zero", {
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const positive = classifierModel("zzz-positive", {
		cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
	});
	const otherProvider = classifierModel("other-provider", {
		provider: "other",
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
	const imageOnly = classifierModel("image-only", {
		input: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});

	assert.equal(chooseClassifier(frozen([missing])), missing, "唯一缺失价格候选仍可选择");
	assert.equal(chooseClassifier(frozen([invalid])), invalid, "唯一非法价格候选仍可选择");
	assert.equal(chooseClassifier(frozen([missing, zero, positive])), positive, "已知正价优先");
	assert.equal(chooseClassifier(frozen([zero, missing])), missing, "未知与零价同末组按 id 字典序");
	assert.equal(chooseClassifier(frozen([missing, zero])), missing, "末组排序不依赖数组顺序");
	assert.equal(chooseClassifier(frozen([otherProvider, imageOnly])), undefined);
});
