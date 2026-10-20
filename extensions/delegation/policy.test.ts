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

const ALL_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const TABLE: readonly (readonly [string, ModelThinkingLevel])[] = [
	["MiniMax-M3.1-Flash", "high"],
	["gpt-6-luna", "high"],
	["glm-5.3", "low"],
	["glm-5.3", "high"],
	["glm-5.3", "max"],
	["gpt-6-luna", "max"],
	["glm-5.3-flash", "max"],
	["gpt-6.1-sol", "medium"],
	["deepseek-flash", "high"],
	["deepseek-flash", "max"],
	["gpt-6.1-sol", "high"],
	["gpt-6.1-sol", "xhigh"],
	["gpt-6-astra", "high"],
	["gpt-6-astra", "xhigh"],
	["gpt-6.1-sol", "max"],
	["gpt-6-astra", "max"],
];

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

test("候选：严格按选型表逐型号与档位生成，键不使用型号名", () => {
	const tableIds = [...new Set(TABLE.map(([id]) => id))];
	const models = frozen([
		...[..."kimi-k3", "unknown-model", ...tableIds].reverse().map((id) => chatModel(id)),
	]);
	const supportedLevels = frozen((model: Model<Api>): readonly ModelThinkingLevel[] => {
		assert.equal(Object.isFrozen(model), true, "不得改写目录模型");
		return ALL_LEVELS;
	});

	const candidates = buildDelegationCandidates(models, supportedLevels);
	assert.deepEqual(candidates.map((entry) => [entry.id, entry.level]), TABLE);
	assert.deepEqual(candidates.map((entry) => entry.key), TABLE.map((_, index) => `option_${index}`));
	for (const entry of candidates) {
		assert.equal(entry.provider, "tsgw");
		assert.equal(entry.model, `tsgw/${entry.id}:${entry.level}`);
		assert.ok(entry.instructions.length > 0);
		assert.equal(entry.key.includes(entry.id), false, "协议 choice key 不绑定型号名");
	}
	assert.equal(candidates.some((entry) => entry.id === "kimi-k3"), false);
	assert.equal(candidates.some((entry) => entry.id === "unknown-model"), false);
	assert.equal(new Set(candidates.map((entry) => entry.key)).size, candidates.length);
});

test("候选：MiniMax 正式版替换旧轻量项，分类与失败指导同源", async () => {
	const { minimaxModels } = await import("../models/vendors/minimax.ts");
	const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
	const models = minimaxModels("https://models.example.test").map(model => ({ ...chatModel(model.id), ...model }));
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels);
	const selected = candidates.find(entry => entry.id === "MiniMax-M3.1-Flash");
	assert.ok(selected);
	assert.equal(selected.level, "high");
	assert.equal(selected.model, "tsgw/MiniMax-M3.1-Flash:high");
	assert.equal(candidates.some(entry => entry.id === "MiniMax-M3" || entry.id.endsWith("-Preview")), false);
	const context = buildDelegationContext({ prompt: "步骤明确的轻量任务" }, candidates);
	const selection = context.questions.selection;
	assert.equal(selection.type, "choice");
	if (selection.type !== "choice") return assert.fail("selection 必须是 choice");
	assert.equal(selection.criteria[selected.key], selected.instructions);
	assert.ok(buildDelegationGuide(candidates).includes(`| ${selected.model} | 可用 |`));
	assert.equal(buildDelegationGuide(candidates).includes("| tsgw/MiniMax-M3:high |"), false);
});

test("候选：其他供应商、非文本、非聊天与不支持档位不会补入", () => {
	const otherProvider = chatModel("gpt-6-luna", { provider: "other" });
	const imageOnly = chatModel("MiniMax-M3.1-Flash", { input: ["image"] });
	const classifierAsChat = {
		...chatModel("gpt-6-astra"),
		type: "classifier",
	} as unknown as Model<Api>;
	const glm = chatModel("glm-5.3");
	const models = frozen([otherProvider, imageOnly, classifierAsChat, chatModel("kimi-k3"), glm]);
	const supportedLevels = frozen((model: Model<Api>): readonly ModelThinkingLevel[] =>
		model.id === "glm-5.3" ? ["low", "medium"] : ALL_LEVELS);

	const candidates = buildDelegationCandidates(models, supportedLevels);
	assert.deepEqual(candidates.map((entry) => [entry.key, entry.id, entry.level]), [
		["option_0", "glm-5.3", "low"],
	]);
});

test("上下文：state 只含任务与元数据，kind/selection 结构固定且候选作为 options", () => {
	const candidates = frozen([
		candidate("option_0", "gpt-6-astra", "max", "Astra 审阅说明"),
		candidate("option_1", "deepseek-flash", "high", "DeepSeek 工程说明"),
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

test("解析：按 choice key 选择当前候选，低置信度不设阈值，也不按概率最高项改选", () => {
	const astraMax = candidate("option_0", "gpt-6-astra", "max");
	const astraHigh = candidate("option_1", "gpt-6-astra", "high");
	const deepseekHigh = candidate("option_2", "deepseek-flash", "high");
	const candidates = frozen([astraMax, astraHigh, deepseekHigh]);

	const selected = resolveDelegationChoice(
		answers(
			choice("implement", { implement: 0.2, inspect: 0.1 }, 0),
			choice("option_2", { option_0: 0.99, option_2: 0.01 }, 0),
		),
		candidates,
	);
	assert.equal(selected, deepseekHigh);
	assert.equal(resolveDelegationChoice(
		answers(choice("debug"), choice("unresolved")),
		candidates,
	), undefined);
	assert.equal(resolveDelegationChoice(
		answers(choice("debug"), choice("gpt-6-astra")),
		candidates,
	), undefined, "型号名不是当前候选 key");
});

test("解析：Astra/max 是正式设计审阅的必要边界，双审一律拒绝", () => {
	const astraMax = candidate("option_0", "gpt-6-astra", "max");
	const astraHigh = candidate("option_1", "gpt-6-astra", "high");
	const deepseekHigh = candidate("option_2", "deepseek-flash", "high");
	const candidates = frozen([astraMax, astraHigh, deepseekHigh]);

	assert.equal(resolveDelegationChoice(
		answers(choice("design_review"), choice("option_0")),
		candidates,
	), astraMax);
	assert.equal(resolveDelegationChoice(
		answers(choice("design_review"), choice("option_1")),
		candidates,
	), undefined, "Astra 非 max 也不得替代");
	assert.equal(resolveDelegationChoice(
		answers(choice("design_review"), choice("option_2")),
		candidates,
	), undefined, "正式设计审阅不得擅自改成其他候选");
	assert.equal(resolveDelegationChoice(
		answers(choice("dual_review"), choice("option_0")),
		candidates,
	), undefined, "双审必须由主代理显式安排");
	assert.equal(resolveDelegationChoice(
		answers(choice("implement"), choice("option_0")),
		candidates,
	), astraMax, "普通任务仍可选择 Astra/max");
});

test("解析：非法结构、越界概率、缺少所选概率、未知 kind 与不在候选中的选择均拒绝", () => {
	const validKind = choice("implement");
	const validSelection = choice("option_2");
	const candidates = frozen([
		candidate("option_0", "gpt-6-astra", "max"),
		candidate("option_2", "deepseek-flash", "high"),
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
		{ kind: validKind, selection: { ...validSelection, choice: "option_9" } },
	];

	for (const value of malformed) {
		assert.equal(
			resolveDelegationChoice(value as ClassifierResult["answers"], candidates),
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
