import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	isPlainObject,
	PayloadWriter,
	type Payload,
	type ThinkingApplier,
	type ThinkingLevel,
} from "./_tools.ts";
import { applyModelOperations } from "./operations.ts";
import { longcatModels, longcatThinking } from "./vendors/longcat.ts";

// LongCat-2.5-Preview 接入回归测试（请求体改写 + 目录参数）。
// 官方依据（2026-10-17 核实，https://longcat.ai/platform/docs/zh/）：
// - 定价 /pricing/longcat-2.5（国内 chat 版限时折扣价）：输入未命中缓存 ¥2、
//   命中缓存 ¥0.04、输出 ¥8 每百万词元；按固定 0.1475 USD/CNY 折算
//   0.295 / 0.0059 / 1.18 USD，缓存写入不计费。
// - 参数 /api/model-params：上下文 1,048,576、max_tokens 上限 262,144。
// - chat schema /api/chat 与模型详情 /api/model：思考仅 `thinking.type`
//   enabled/disabled 且可关闭；input_modalities ["text"]；无
//   enable_thinking/thinking_effort/reasoning_effort 深度字段。
const levels = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];
const root = "https://aih.example.com";

function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
}

function apply(
	strategies: Record<string, ThinkingApplier>,
	id: string,
	level: ThinkingLevel,
	payload: Payload,
): Payload {
	const before = structuredClone(payload);
	freeze(payload);
	const writer = new PayloadWriter(payload);
	strategies[id](writer, {
		provider: "tsgw",
		modelId: id,
		api: "openai-completions",
		thinkingLevel: level,
		tsSearchMode: "live",
	});
	const result = writer.result();
	deepStrictEqual(payload, before, `${id}/${level}：输入被修改`);
	// 非目标字段按引用透传，不受改写影响。
	strictEqual(result.messages, payload.messages, `${id}/${level}：messages`);
	strictEqual(result.tools, payload.tools, `${id}/${level}：tools`);
	return result;
}

function base(): Payload {
	return {
		messages: [{ role: "user", content: "hello" }],
		tools: [{ type: "function", function: { name: "probe" } }],
		max_tokens: 42,
		reasoning_effort: "medium",
	};
}

// —— 目录与策略登记 ——
const models = longcatModels(root);
deepStrictEqual(
	Object.keys(longcatThinking).sort(),
	models.map((model) => model.id).sort(),
	"策略与登记 ID 精确对应",
);

// —— longcat-2.5-preview 参数（官方文档核实值） ——
const m25 = models.find((model) => model.id === "longcat-2.5-preview")!;
equal(m25.api, "openai-completions");
equal(m25.baseUrl, `${root}/v1`);
equal(m25.reasoning, true);
deepStrictEqual(m25.input, ["text"], "API 契约为纯文本输入");
deepStrictEqual(m25.cost, {
	input: 0.295,
	output: 1.18,
	cacheRead: 0.0059,
	cacheWrite: 0,
});
// 三个计费档位必须区分：命中缓存 < 未命中输入 < 输出。
equal(m25.cost.cacheRead < m25.cost.input, true, "缓存命中价低于未命中价");
equal(m25.cost.input < m25.cost.output, true, "输入价低于输出价");
equal(m25.contextWindow, 1048576, "上下文 1,048,576");
equal(m25.maxTokens, 262144, "max_tokens 上限 262,144（参数参考页）");
deepStrictEqual(m25.compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
equal(m25.thinkingLevelMap, undefined, "思考可关闭且无深度档位，不登记映射");

// —— longcat-2.0 保持既有登记不变 ——
deepStrictEqual(
	(({ name: _name, ...model }) => model)(models.find((model) => model.id === "longcat-2.0")!),
	{
		id: "longcat-2.0",
		api: "openai-completions",
		baseUrl: `${root}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0.295, output: 1.18, cacheRead: 0.0059, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 131072,
		compat: { supportsDeveloperRole: false },
	},
	"longcat-2.0 不得因 2.5 接入而变化",
);
equal(m25.contextWindow !== 1000000 || m25.maxTokens !== 131072, true);
equal(m25.maxTokens > 131072, true, "2.5 输出上限高于 2.0 的 128K");

// —— longcat-2.5-preview 七档冻结输入回归 ——
for (const level of levels) {
	const payload = {
		...base(),
		stream: true,
		thinking: { type: "legacy", retained: true },
		temperature: 0.7,
		top_p: 0.95,
		top_k: -1,
		repetition_penalty: 1,
	};
	const result = apply(longcatThinking, "longcat-2.5-preview", level, payload);
	// 思考开关：off 关闭，其余档位一律开启；无深度字段可映射。
	deepStrictEqual(
		result.thinking,
		{ type: level === "off" ? "disabled" : "enabled", retained: true },
		`longcat-2.5-preview/${level}`,
	);
	equal(Object.hasOwn(result, "reasoning_effort"), false, "不支持 reasoning_effort");
	// 采样参数由服务端按思考状态固定覆盖，策略不改写、不剔除。
	equal(result.temperature, 0.7);
	equal(result.top_p, 0.95);
	equal(result.top_k, -1);
	equal(result.repetition_penalty, 1);
	equal(result.max_tokens, 42);
	equal(result.stream, true);
	// 幂等：二次应用返回同一引用。
	strictEqual(
		apply(longcatThinking, "longcat-2.5-preview", level, result),
		result,
		`longcat-2.5-preview/${level} 幂等`,
	);
}

// 遗留/缺失 reasoning_effort 一律剔除，不按原值透传。
for (const staleEffort of [undefined, "none", "max", "high"]) {
	const result = apply(longcatThinking, "longcat-2.5-preview", "high", {
		...base(),
		reasoning_effort: staleEffort,
	});
	equal(Object.hasOwn(result, "reasoning_effort"), false);
}
// 无 thinking 字段时构造完整对象；保留未知嵌套键之外的既有内容。
const noThinking = apply(
	longcatThinking,
	"longcat-2.5-preview",
	"medium",
	base(),
);
deepStrictEqual(noThinking.thinking, { type: "enabled" });

// —— longcat-2.0 策略保持通用开关式不变 ——
for (const level of levels) {
	const result = apply(longcatThinking, "longcat-2.0", level, {
		...base(),
		thinking: { retained: true },
	});
	deepStrictEqual(result.thinking, {
		type: level === "off" ? "disabled" : "enabled",
		retained: true,
	});
	equal(Object.hasOwn(result, "reasoning_effort"), false);
}

// —— operations 调度接入：新 ID 经完整链路生效，非 tsgw 不改写 ——
for (const level of ["off", "max"] as const) {
	const raw = applyModelOperations(
		{ ...base(), thinking: { type: "legacy" } },
		{
			provider: "tsgw",
			modelId: "longcat-2.5-preview",
			api: "openai-completions",
			thinkingLevel: level,
			tsSearchMode: "live",
		},
	);
	if (!isPlainObject(raw)) throw new Error("调度结果应为普通对象");
	deepStrictEqual(raw.thinking, {
		type: level === "off" ? "disabled" : "enabled",
	});
}
const foreign = { ...base(), thinking: { type: "legacy" } };
strictEqual(
	applyModelOperations(foreign, {
		provider: "other",
		modelId: "longcat-2.5-preview",
		api: "openai-completions",
		thinkingLevel: "high",
		tsSearchMode: "live",
	}),
	foreign,
	"非 tsgw 请求原样返回",
);

// 真宿主 adapter 验证官方 max_tokens 字段；仅 HTTP 夹具，不访问生产。
const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	credentials: { read: async () => ({ type: "api_key" as const, key: "fixture-key" }),
		list: async () => [], modify: async () => undefined, delete: async () => {} },
});
runtime.registerProvider("tsgw", { models: [m25] });
const originalFetch = globalThis.fetch;
try {
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		equal(request.url, `${root}/v1/chat/completions`);
		equal(request.headers.get("authorization"), "Bearer fixture-key");
		const body = await request.json() as Payload;
		equal(body.max_tokens, 512);
		equal(Object.hasOwn(body, "max_completion_tokens"), false);
		equal(Object.hasOwn(body, "reasoning_effort"), false);
		deepStrictEqual(body.thinking, { type: "enabled" });
		return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
	};
	const model = runtime.getModel("tsgw", m25.id)!;
	const result = await runtime.streamSimple(model, { messages: [{ role: "user", content: "test", timestamp: 0 }] }, {
		reasoning: "low", maxTokens: 512, maxRetries: 0,
		onPayload: payload => applyModelOperations(payload, { provider: "tsgw", modelId: m25.id, api: m25.api!, thinkingLevel: "low", tsSearchMode: "live" }),
	}).result();
	equal(result.stopReason, "stop", result.errorMessage ?? m25.id);
} finally { globalThis.fetch = originalFetch; }
console.log("longcat-new.test.ts：LongCat-2.5-Preview 接入回归测试通过");
