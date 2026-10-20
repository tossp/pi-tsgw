import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { PayloadWriter, type Payload, type ThinkingApplier, type ThinkingLevel } from "./_tools.ts";
import { geminiModels, geminiThinking } from "./vendors/gemini.ts";
import { glmModels, glmThinking } from "./vendors/glm.ts";
import { grokModels, grokThinking } from "./vendors/grok.ts";
import { minimaxModels, minimaxThinking } from "./vendors/minimax.ts";
import { kimiModels, kimiThinking } from "./vendors/kimi.ts";
import { mimoModels, mimoThinking } from "./vendors/mimo.ts";

// 官方依据位于各厂商实现旁；调研基线为 Blinko #863（2026-10-09）。
// 这些是请求体回归测试，不是网关端点测试。Grok 别名与 gemini-flash
// 在获得网关路由依据前保留现有兼容策略。
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
	deepStrictEqual(payload, before, `${id}/${level}：输入被修改`);
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
	"gemini-flash": "flash-budget", // 沿用网关兼容策略，未证实 3.x 语义。
	"gemini-pro": "pro-level",
	"gemini-3.5-flash": "flash-level",
	"gemini-3.5-flash-low": "flash-level",
	"gemini-3.5-flash-extra-low": "flash-level",
	"gemini-3.5-flash-lite": "completions-level",
	"gemini-3.8-flash-high": "pro-level",
} as const;
coverage(Object.keys(geminiCases), geminiThinking, geminiModels(root));
for (const [id, kind] of Object.entries(geminiCases)) {
	for (const level of levels) {
		const payload = { ...base(), config: { temperature: 0.2, thinkingConfig: { thinkingLevel: "STALE", thinkingBudget: 999, retained: true } } };
		const result = apply(geminiThinking, id, level, payload);
		const expected: Payload = { includeThoughts: level !== "off", retained: true };
		if (kind === "completions-level") {
			deepStrictEqual(result.config, payload.config, `${id}/${level}`);
			equal(result.reasoning_effort, ["off", "minimal"].includes(level) ? "minimal" : ["xhigh", "max"].includes(level) ? "high" : level);
			continue;
		}
		if (kind === "flash-budget") expected.thinkingBudget = level === "off" ? 0 : level === "max" ? 24576 : 16000;
		if (kind === "flash-level") expected.thinkingLevel = ["off", "minimal"].includes(level) ? "MINIMAL" : level === "low" ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH";
		if (kind === "pro-level") expected.thinkingLevel = ["off", "minimal", "low"].includes(level) ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH";
		deepStrictEqual(result.config, { temperature: 0.2, thinkingConfig: expected }, `${id}/${level}`);
		equal(Object.hasOwn(result, "reasoning_effort"), false);
	}
}

// GLM 文档：仅 5.2+ 支持 reasoning_effort；4.7 引入思考保留。
const glmCases = {
	"glm-5.2": { effort: true, preserve: true },
	"glm-4.5-air": { effort: false, preserve: false },
};
const glm53Ids = ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"];
coverage([...glm53Ids, ...Object.keys(glmCases)], glmThinking, glmModels(root));
// 每 ID 保留七档主映射；stream 与遗留 effort 独立取样，不做笛卡尔积。
for (const id of glm53Ids) {
	for (const level of levels) {
		const result = apply(glmThinking, id, level, { ...base(), stream: true, thinking: { type: "disabled", retained: true } });
		deepStrictEqual(result.thinking, { type: "enabled", retained: true, ...(["high", "xhigh", "max"].includes(level) ? { clear_thinking: false } : {}) });
		equal(result.reasoning_effort, ["off", "minimal", "low"].includes(level) ? "low" : ["medium", "high"].includes(level) ? "high" : "max", `${id}/${level}`);
		equal(result.tool_stream, true);
		strictEqual(apply(glmThinking, id, level, result), result);
	}
	for (const stream of [false, undefined]) {
		const result = apply(glmThinking, id, "high", { ...base(), stream });
		equal(result.tool_stream, undefined);
		equal(result.stream, stream);
	}
	for (const staleEffort of [undefined, "none", "max"]) {
		const result = apply(glmThinking, id, "off", { ...base(), reasoning_effort: staleEffort });
		equal(result.reasoning_effort, "low");
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

// MiMo V2.6 直接替代 V2.5；两个 ID 均支持图像与可切换思考。
const mimoIds = ["mimo-v2.6-pro", "mimo-v2.6-flash"];
coverage(mimoIds, mimoThinking, mimoModels(root));
for (const model of mimoModels(root)) {
	equal(model.api, "openai-completions");
	equal(model.baseUrl, `${root}/v1`);
	equal(model.reasoning, true);
	deepStrictEqual(model.input, ["text", "image"]);
	equal(model.contextWindow, 1000000);
	equal(model.maxTokens, 131072);
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

const minimaxIds = ["MiniMax-M3"];
const minimax31Ids = ["MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"];
coverage([...minimax31Ids, ...minimaxIds], minimaxThinking, minimaxModels(root));
for (const id of minimax31Ids) {
	for (const level of levels) {
		const result = apply(minimaxThinking, id, level, { ...base(), reasoning_split: false, thinking: { type: "disabled", retained: true } });
		deepStrictEqual(result.thinking, { type: "adaptive", retained: true });
		equal(result.reasoning_effort, ["off", "minimal"].includes(level) ? "low" : level);
		equal(result.reasoning_split, true);
		strictEqual(apply(minimaxThinking, id, level, result), result);
	}
	for (const staleEffort of [undefined, "none", "max"]) {
		const result = apply(minimaxThinking, id, "off", { ...base(), reasoning_effort: staleEffort });
		equal(result.reasoning_effort, "low");
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
// 国内原生 API 明确记录了 M3 / M3.1 的输出上限。
for (const model of minimaxModels(root)) {
	equal(model.maxTokens, 524288);
	equal(model.thinkingLevelMap?.off, minimax31Ids.includes(model.id) ? null : undefined);
}

const kimiIds = ["kimi-k3", "kimi-k3-256k"];
coverage(kimiIds, kimiThinking, kimiModels(root));
for (const model of kimiModels(root)) {
	equal(model.maxTokens, 131072);
	equal(model.thinkingLevelMap?.off, null);
	equal(model.contextWindow, model.id === "kimi-k3" ? 1000000 : 262144);
	for (const level of levels) {
		const result = apply(kimiThinking, model.id, level, { ...base(), thinking: { type: "disabled" } });
		equal(Object.hasOwn(result, "thinking"), false);
		equal(result.reasoning_effort, ["off", "minimal", "low"].includes(level) ? "low" : level === "max" ? "max" : "high", `${model.id}/${level}`);
		strictEqual(apply(kimiThinking, model.id, level, result), result);
	}
	// 两个变体都必须纠正遗留 off/none，且不回退到 max。
	for (const staleEffort of [undefined, "max", "none"]) {
		const result = apply(kimiThinking, model.id, "off", { ...base(), reasoning_effort: staleEffort });
		equal(result.reasoning_effort, "low");
	}
}

// Grok 4.5 与 4.7 使用不同协议，均须覆盖逐 ID 档位。
const grokIds = ["grok-4.5", "grok-4.7"];
coverage(grokIds, grokThinking, grokModels(root));
for (const id of grokIds) {
	for (const level of levels) {
		const result = apply(grokThinking, id, level, { ...base(), thinking: { type: "enabled" } });
		equal(Object.hasOwn(result, "thinking"), false);
		if (id === "grok-4.7") {
			equal(Object.hasOwn(result, "reasoning_effort"), false);
			deepStrictEqual(result.reasoning, { effort: ["off", "minimal"].includes(level) ? "low" : level === "max" ? "xhigh" : level });
		} else equal(result.reasoning_effort, ["off", "minimal", "low"].includes(level) ? "low" : level === "medium" ? "medium" : "high", `${id}/${level}`);
	}
}
console.log("vendor-strategies：逐 ID 七档请求体回归测试通过");
