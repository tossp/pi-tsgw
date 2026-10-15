import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { PayloadWriter, type Payload, type ThinkingApplier, type ThinkingLevel } from "./_tools.ts";
import { geminiModels, geminiThinking } from "./vendors/gemini.ts";
import { glmModels, glmThinking } from "./vendors/glm.ts";
import { grokModels, grokThinking } from "./vendors/grok.ts";
import { minimaxModels, minimaxThinking } from "./vendors/minimax.ts";
import { kimiModels, kimiThinking } from "./vendors/kimi.ts";
import { mimoModels, mimoThinking } from "./vendors/mimo.ts";

// Official evidence lives beside the vendor implementations; research baseline:
// Blinko #863 (2026-10-09). These are payload regressions, not gateway endpoint tests. Grok aliases and gemini-flash retain
// their existing compatibility policy pending gateway routing evidence.
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const root = "https://aih.example.com";
function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
}
function apply(strategies: Record<string, ThinkingApplier>, id: string, level: ThinkingLevel, payload: Payload): Payload {
	const before = structuredClone(payload);
	freeze(payload);
	const writer = new PayloadWriter(payload);
	strategies[id](writer, { provider: "tsgw", modelId: id, api: "openai-completions", thinkingLevel: level, tsSearchMode: "live" });
	const result = writer.result();
	deepStrictEqual(payload, before, `${id}/${level}: input mutation`);
	strictEqual(result.messages, payload.messages);
	strictEqual(result.tools, payload.tools);
	equal(result.max_tokens, payload.max_tokens);
	return result;
}
function base(): Payload {
	return { messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "probe" } }], max_tokens: 42, reasoning_effort: "medium" };
}
function coverage(ids: readonly string[], strategies: Record<string, ThinkingApplier>, models: { id: string }[]): void {
	deepStrictEqual([...ids].sort(), Object.keys(strategies).sort());
	deepStrictEqual([...ids].sort(), models.map(m => m.id).sort());
}

const geminiCases = {
	"gemini-flash": "flash-budget", // Existing gateway compatibility, not proven 3.x semantics.
	"gemini-pro": "pro-level",
	"gemini-3.5-flash": "flash-level",
	"gemini-3.5-flash-low": "flash-level",
	"gemini-3.5-flash-extra-low": "flash-level",
	"gemini-3.1-pro-low": "pro-level",
	"gemini-2.5-pro": "pro-budget",
	"gemini-2.5-flash": "flash-budget",
	"gemini-2.5-flash-lite": "flash-budget",
} as const;
coverage(Object.keys(geminiCases), geminiThinking, geminiModels(root));
for (const [id, kind] of Object.entries(geminiCases)) {
	for (const level of levels) {
		const payload = { ...base(), config: { temperature: 0.2, thinkingConfig: { thinkingLevel: "STALE", thinkingBudget: 999, retained: true } } };
		const result = apply(geminiThinking, id, level, payload);
		const expected: Payload = { includeThoughts: level !== "off", retained: true };
		if (kind === "flash-budget") expected.thinkingBudget = level === "off" ? 0 : level === "max" ? 24576 : 16000;
		if (kind === "pro-budget") expected.thinkingBudget = ["off", "minimal", "low"].includes(level) ? 128 : level === "max" ? 32768 : 16000;
		if (kind === "flash-level") expected.thinkingLevel = ["off", "minimal"].includes(level) ? "MINIMAL" : level === "low" ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH";
		if (kind === "pro-level") expected.thinkingLevel = ["off", "minimal", "low"].includes(level) ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH";
		deepStrictEqual(result.config, { temperature: 0.2, thinkingConfig: expected }, `${id}/${level}`);
		equal(Object.hasOwn(result, "reasoning_effort"), false);
	}
}

// GLM docs: reasoning_effort only 5.2+; 4.7 introduced preserved thinking.
const glmCases = {
	"glm-5.2": { effort: true, preserve: true },
	"glm-5.1": { effort: false, preserve: true },
	"glm-5": { effort: false, preserve: true },
	"glm-5-turbo": { effort: false, preserve: true },
	"glm-4.7": { effort: false, preserve: true },
	"glm-4.6": { effort: false, preserve: false },
	"glm-4.5": { effort: false, preserve: false },
	"glm-4.5-air": { effort: false, preserve: false },
};
const glm53Ids = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"];
coverage([...glm53Ids, ...Object.keys(glmCases)], glmThinking, glmModels(root));
for (const id of glm53Ids) {
	for (const level of levels) {
		for (const stream of [true, false, undefined]) {
			for (const staleEffort of [undefined, "none", "medium", "max"]) {
				const result = apply(glmThinking, id, level, { ...base(), stream, reasoning_effort: staleEffort, thinking: { type: "disabled", retained: true } });
				deepStrictEqual(result.thinking, { type: "enabled", retained: true, ...(["high", "xhigh", "max"].includes(level) ? { clear_thinking: false } : {}) });
				equal(result.reasoning_effort, ["off", "minimal", "low"].includes(level) ? "low" : ["medium", "high"].includes(level) ? "high" : "max", `${id}/${level}`);
				equal(result.tool_stream, stream === true ? true : undefined);
				strictEqual(apply(glmThinking, id, level, result), result);
			}
		}
	}
}
for (const [id, support] of Object.entries(glmCases)) {
	for (const level of levels) {
		for (const stream of [true, false, undefined]) {
			const result = apply(glmThinking, id, level, { ...base(), stream, thinking: { retained: true } });
			const high = ["high", "xhigh", "max"].includes(level);
			deepStrictEqual(result.thinking, { retained: true, type: level === "off" ? "disabled" : "enabled", ...(support.preserve && high ? { clear_thinking: false } : {}) }, `${id}/${level}`);
			equal(result.tool_stream, stream === true ? true : undefined);
			const effort = level === "off" ? "none" : level === "high" ? "high" : ["xhigh", "max"].includes(level) ? "max" : "medium";
			equal(result.reasoning_effort, support.effort ? effort : undefined, `${id}/${level}`);
			if (!support.effort) equal(Object.hasOwn(result, "reasoning_effort"), false);
		}
	}
}

// MiMo V2.6 directly replaces V2.5; both IDs support images and switchable thinking.
const mimoIds = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
coverage(mimoIds, mimoThinking, mimoModels(root));
for (const model of mimoModels(root)) {
	equal(model.name, model.id === "mimo-v2.6-pro" ? "MiMo V2.6 Pro" : "MiMo V2.6 Flash");
	equal(model.api, "openai-completions");
	equal(model.baseUrl, `${root}/v1`);
	equal(model.reasoning, true);
	deepStrictEqual(model.input, ["text", "image"]);
	equal(model.contextWindow, 1000000);
	equal(model.maxTokens, 131072);
	deepStrictEqual(model.cost, model.id === "mimo-v2.6-pro"
		? { input: 0.4425, output: 0.885, cacheRead: 0.0036875, cacheWrite: 0 }
		: { input: 0.1475, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 });
	deepStrictEqual(model.compat, { supportsDeveloperRole: false });
	for (const level of levels) {
		const result = apply(mimoThinking, model.id, level, { ...base(), thinking: { retained: true }, temperature: 0.2, top_p: 0.8 });
		deepStrictEqual(result.thinking, { retained: true, type: level === "off" ? "disabled" : "enabled" });
		equal(Object.hasOwn(result, "reasoning_effort"), false);
		equal(result.temperature, 0.2);
		equal(result.top_p, 0.8);
		strictEqual(apply(mimoThinking, model.id, level, result), result);
	}
}

const minimaxIds = ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1"];
const minimax31Id = "MiniMax-M3.1-Flash-Preview";
coverage([minimax31Id, ...minimaxIds], minimaxThinking, minimaxModels(root));
for (const level of levels) {
	for (const staleEffort of [undefined, "none", "max"]) {
		const result = apply(minimaxThinking, minimax31Id, level, { ...base(), reasoning_effort: staleEffort, reasoning_split: false, thinking: { type: "disabled", retained: true } });
		deepStrictEqual(result.thinking, { type: "adaptive", retained: true });
		equal(result.reasoning_effort, ["off", "minimal"].includes(level) ? "low" : level);
		equal(result.reasoning_split, true);
		strictEqual(apply(minimaxThinking, minimax31Id, level, result), result);
	}
}
for (const id of minimaxIds) {
	for (const level of levels) {
		const result = apply(minimaxThinking, id, level, { ...base(), thinking: { retained: true }, reasoning_split: false });
		deepStrictEqual(result.thinking, { retained: true, type: id === "MiniMax-M3" && level === "off" ? "disabled" : "adaptive" }, `${id}/${level}`);
		equal(result.reasoning_split, true);
		equal(Object.hasOwn(result, "reasoning_effort"), false);
	}
}
// Domestic native API explicitly documents these output caps, including M2.x.
for (const model of minimaxModels(root)) {
	equal(model.maxTokens, model.id.startsWith("MiniMax-M3") ? 524288 : 204800);
	if (model.id.startsWith("MiniMax-M2")) deepStrictEqual(model.thinkingLevelMap, { off: null });
	else equal(model.thinkingLevelMap?.off, model.id === minimax31Id ? null : undefined);
}

const kimiCodeIds = ["kimi-k2.7-code", "kimi-k2.7-code-highspeed"];
for (const id of kimiCodeIds) {
	const model = kimiModels(root).find(m => m.id === id)!;
	deepStrictEqual(model.thinkingLevelMap, { off: null });
	equal(model.maxTokens, 262144); // Compatibility value, not a verified output limit.
	for (const level of levels) {
		for (const thinking of [undefined, { type: "disabled" }, { type: "enabled", keep: "none", retained: true }]) {
			const result = apply(kimiThinking, id, level, { ...base(), thinking });
			deepStrictEqual(result.thinking, { ...thinking, type: "enabled", keep: "all" }, `${id}/${level}`);
			equal(Object.hasOwn(result, "reasoning_effort"), false);
			// Already-correct requests remain unchanged (copy-on-write).
			strictEqual(apply(kimiThinking, id, level, result), result);
		}
	}
}
// Do not transfer canonical Code restrictions to the unknown gateway alias.
const codingAlias = kimiModels(root).find(m => m.id === "kimi-for-coding")!;
equal(codingAlias.thinkingLevelMap?.off, undefined);
equal(codingAlias.maxTokens, 32768);
for (const level of levels) {
	const result = apply(kimiThinking, codingAlias.id, level, base());
	deepStrictEqual(result.thinking, { type: level === "off" ? "disabled" : "enabled" });
}
const kimiK3 = kimiModels(root).find(m => m.id === "kimi-k3")!;
equal(kimiK3.maxTokens, 131072);
equal(kimiK3.thinkingLevelMap?.off, null);
for (const level of levels) {
	// A stale off snapshot must not omit effort and accidentally select default max.
	for (const effort of [undefined, "max", "none"]) {
		const result = apply(kimiThinking, kimiK3.id, level, { ...base(), reasoning_effort: effort, thinking: { type: "disabled" } });
		equal(Object.hasOwn(result, "thinking"), false);
		equal(result.reasoning_effort, ["off", "minimal", "low"].includes(level) ? "low" : level === "max" ? "max" : "high", `kimi-k3/${level}`);
		strictEqual(apply(kimiThinking, kimiK3.id, level, result), result);
	}
}

// Only grok-4.5 has confirmed effort support in the current official reasoning
// guide. Other IDs below intentionally freeze legacy policy, not an API claim.
const grokIds = ["grok-4.20", "grok-4.5", "grok-4.3-low", "grok-4.3-medium", "grok-4.3-high", "grok-4.20-fast"];
coverage(grokIds, grokThinking, grokModels(root));
for (const id of grokIds) {
	for (const level of levels) {
		const result = apply(grokThinking, id, level, { ...base(), thinking: { type: "enabled" } });
		equal(Object.hasOwn(result, "thinking"), false);
		equal(result.reasoning_effort, ["off", "minimal", "low"].includes(level) ? "low" : level === "medium" ? "medium" : "high", `${id}/${level}`);
	}
}
console.log("vendor-strategies: per-ID seven-level payload regressions passed");
