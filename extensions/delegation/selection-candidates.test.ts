import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DELEGATION_KNOWLEDGE } from "./knowledge.ts";
import { registerDelegation } from "./index.ts";
import { failureGuidance } from "./failure.ts";
import {
	buildDelegationCandidates, buildDelegationContext, buildDelegationGuide, resolveDelegationKeys,
} from "./policy.ts";

function chatModel(id: string, provider = "tsgw"): Model<Api> {
	return {
		id, provider, name: id, api: "openai-responses", input: ["text"],
		baseUrl: "https://models.example.test/v1", reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000, maxTokens: 32_000,
	};
}

const models = [...new Set(DELEGATION_KNOWLEDGE.map(entry => entry.id))].map(id => chatModel(id));
const guideRows = (guide: string) => guide.split("\n").filter(line => line.startsWith("| tsgw/"));

test("渐进式暴露：常驻注入只提供调用契约，保留宿主提示且不提前提供接管材料", async () => {
	const handlers = new Map<string, (event: any) => any>();
	const pi = {
		on: (event: string, handler: (event: any) => any) => { handlers.set(event, handler); },
		getActiveTools: () => ["Agent"],
		getAllTools: () => [{ name: "Agent", parameters: { type: "object", properties: {
			prompt: { type: "string" }, model: { type: "string" }, resume: { type: "string" },
		} } }],
	};
	// 测试替身仅覆盖本例执行的事件与工具元数据接口，不调用其他宿主能力。
	registerDelegation(pi as unknown as ExtensionAPI);
	await handlers.get("session_start")!({ type: "session_start" });
	const sections: Record<string, string> = { host: "宿主提示标记" };
	const inject = handlers.get("before_agent_start")!;
	assert.equal(await inject({ systemPromptOptions: { sections } }), undefined);
	assert.equal(sections.host, "宿主提示标记");
	const guidance = sections.tsgw_delegation;
	assert.ok(guidance);
	assert.ok(guidance.includes("Agent") && guidance.includes("model") && guidance.includes("resume"));
	for (const row of DELEGATION_KNOWLEDGE) assert.equal(guidance.includes(row.id), false);
	for (const kind of ["unknown", "cancelled"] as const)
		assert.equal(guidance.includes(failureGuidance(kind)), false);
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels);
	assert.equal(guidance.includes(buildDelegationGuide(candidates)), false);
	const legacy = await inject({ systemPrompt: "宿主原始提示" });
	assert.equal(legacy.systemPrompt, `宿主原始提示\n\n${guidance}`);
	await handlers.get("session_shutdown")!({ type: "session_shutdown" });
	assert.equal(await inject({ systemPrompt: "结束后" }), undefined);
});

test("有效候选：目录、会话型号与显式档位一次取交集，过滤后生成连续 choice key", () => {
	const deepseek = models.find(model => model.id === "deepseek-flash")!;
	const scope = Object.freeze([{ model: deepseek, thinkingLevel: "max" as const }]);
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels, scope);
	assert.deepEqual(candidates.map(entry => [entry.key, entry.model]), [["option_0", "tsgw/deepseek-flash:max"]]);
	assert.deepEqual(buildDelegationCandidates([], getSupportedThinkingLevels, scope), [], "scope 不能补回目录缺席项");
	assert.deepEqual(buildDelegationCandidates(models, () => ["high"], scope), [], "不支持的档位不能改档加入");
	assert.deepEqual(buildDelegationCandidates(models, getSupportedThinkingLevels,
		[{ model: chatModel(deepseek.id, "other") }]), [], "会话型号匹配必须包含 provider");
	const allLevels = buildDelegationCandidates(models, getSupportedThinkingLevels, [{ model: deepseek }]);
	assert.ok(allLevels.length > candidates.length, "未指定 scope 档位时保留该型号的合法候选");
	assert.ok(allLevels.every(entry => entry.id === deepseek.id));
});

test("材料同源：分类器与接管表只接收有效候选，静态知识不能补行", () => {
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels,
		[{ model: chatModel("deepseek-flash"), thinkingLevel: "high" }]);
	const context = buildDelegationContext({ prompt: "实现指定模块并运行回归测试" }, candidates);
	const selection = context.questions.selection;
	assert.equal(selection.type, "choice");
	if (selection.type !== "choice") return assert.fail("selection 必须是 choice");
	assert.deepEqual(Object.keys(selection.criteria), [...candidates.map(entry => entry.key), "unresolved"]);
	const guide = buildDelegationGuide(candidates);
	assert.deepEqual(guideRows(guide), candidates.map(entry => `| ${entry.model} | ${entry.instructions} |`));
	for (const candidate of candidates) assert.equal(selection.criteria[candidate.key], candidate.instructions);
	// 固定审阅的型号属于硬约束，可出现在规则中；其他缺席型号不应残留在全局推荐里。
	for (const id of new Set(DELEGATION_KNOWLEDGE.map(entry => entry.id))) {
		if (["deepseek-flash", "gpt-6-astra", "kimi-k3.1-pro"].includes(id)) continue;
		assert.equal(JSON.stringify(context).includes(id), false, `${id} 不应进入分类材料`);
		assert.equal(guide.includes(id), false, `${id} 不应进入失败接管指导`);
	}
	const custom = [{ ...candidates[0], instructions: "本次候选的独立说明标记" }];
	assert.deepEqual(guideRows(buildDelegationGuide(custom)),
		[`| ${custom[0].model} | ${custom[0].instructions} |`], "接管表不能回查静态知识覆盖候选材料");
});

test("空候选与核验未完成：不展示静态型号、状态行或空表", () => {
	const empty = buildDelegationGuide([]);
	const unverified = buildDelegationGuide(undefined);
	assert.notEqual(empty, unverified, "无可选项和核验未完成应分别说明");
	for (const guide of [empty, unverified]) {
		assert.ok(guide.length > 0);
		assert.equal(guide.includes("|"), false);
		for (const entry of DELEGATION_KNOWLEDGE) assert.equal(guide.includes(entry.id), false);
	}
});

test("多候选参与：普通任务可接受任意有效候选，不由默认型号收敛；硬审阅约束不放松", () => {
	const candidates = buildDelegationCandidates(models, getSupportedThinkingLevels);
	assert.ok(new Set(candidates.map(entry => entry.id)).size > 1);
	for (const candidate of candidates) {
		for (const kind of ["inspect", "implement", "debug"])
			assert.equal(resolveDelegationKeys(kind, candidate.key, candidates), candidate);
		assert.equal(resolveDelegationKeys("dual_review", candidate.key, candidates), undefined);
		const formalReview = resolveDelegationKeys("design_review", candidate.key, candidates);
		if (candidate.id === "gpt-6-astra" && candidate.level === "max") assert.equal(formalReview, candidate);
		else assert.equal(formalReview, undefined);
	}
	const missingReview = candidates.filter(entry => entry.id !== "gpt-6-astra");
	for (const candidate of missingReview)
		assert.equal(resolveDelegationKeys("design_review", candidate.key, missingReview), undefined);
});
