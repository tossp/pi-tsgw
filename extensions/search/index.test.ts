import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { builtinSearchSupport, resolveSearchDelegate } from "#tsgw/models/web-search";

function testExactCandidateProtocol(): void {
	for (const [id, api, expected] of [
		["gpt-6-luna-extra", "openai-responses", undefined],
		["GPT-6-LUNA", "openai-responses", undefined],
	] as const) {
		strictEqual(builtinSearchSupport(id, api), expected, `${id}/${api}`);
	}
}

function testLunaPriorityAndCandidateFiltering(): void {
	const candidate = (id: string, api = "openai-responses") => ({ id, api });
	deepStrictEqual(resolveSearchDelegate([
		candidate("gpt-6-sol"), candidate("gpt-6-luna"),
		candidate("grok-4.5", "openai-completions"),
	]), { modelId: "gpt-6-luna", kind: "gpt" });

	// 候选顺序不优先于策略偏好；忽略错误协议与不支持的 ID，
	// 最后回退至 Grok。
	deepStrictEqual(resolveSearchDelegate([
		candidate("gpt-6-luna", "openai-completions"),
		candidate("gpt-6-luna-extra"), candidate("grok-4.5", "openai-completions"),
	]), { modelId: "grok-4.5", kind: "grok" });
	strictEqual(resolveSearchDelegate([
		candidate("gpt-6-luna", "openai-completions"),
		candidate("grok-4.5", "openai-responses"),
		candidate("gpt-6-sol-extra"),
	]), undefined);
	// 已移除的 Grok ID 不能再作为搜索代理候选。
	strictEqual(resolveSearchDelegate([
		"grok-4.20", "grok-4.20-fast", "grok-4.3-low", "grok-4.3-medium", "grok-4.3-high",
	].map(id => candidate(id, "openai-completions"))), undefined);
}

testExactCandidateProtocol();
testLunaPriorityAndCandidateFiltering();
console.log("search/index.test.ts：全部断言通过");
