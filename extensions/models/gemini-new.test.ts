import { deepStrictEqual, equal, strictEqual } from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyModelOperations } from "./operations.ts";
import { geminiModels, geminiThinking } from "./vendors/gemini.ts";
import { effectiveModelsForGateway } from "./catalog.ts";
import type { Payload, ThinkingLevel } from "./_tools.ts";

const root = "https://gateway.invalid";
const models = geminiModels(root);
const ids = ["gemini-3.5-flash-lite", "gemini-3.8-flash-high", "gemini-3.8-flash"];
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const lite = models.find(model => model.id === ids[0])!;
const high = models.find(model => model.id === ids[1])!;
const flash = models.find(model => model.id === ids[2])!;
for (const model of [lite, high, flash]) {
	equal(model.reasoning, true);
	equal(model.contextWindow, 1048576);
	equal(model.maxTokens, 65536);
	deepStrictEqual(model.input, ["text", "image"]);
	equal(model.thinkingLevelMap?.off, null);
}
equal(lite.api, "openai-completions");
equal(lite.baseUrl, `${root}/v1`);
deepStrictEqual(lite.compat, { supportsDeveloperRole: false });
deepStrictEqual(lite.cost, { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 });
equal(high.api, "google-generative-ai");
equal(high.baseUrl, `${root}/gemini/v1beta`);
deepStrictEqual(high.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
equal(flash.api, "google-generative-ai");
equal(flash.baseUrl, `${root}/v1beta`);
deepStrictEqual(flash.thinkingLevelMap, high.thinkingLevelMap);
deepStrictEqual(flash.cost, high.cost);
// 网关只列裸 ID 时能登记；保留的旧别名仍受目录交集约束。
deepStrictEqual(effectiveModelsForGateway(root, undefined, new Set([flash.id]), false, false).map(model => model.id), [flash.id]);
deepStrictEqual(models.map(model => model.id).sort(), Object.keys(geminiThinking).sort());

function freeze(value: unknown): void {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
}
function apply(id: string, payload: Payload, thinkingLevel: ThinkingLevel): Payload {
	return applyModelOperations(payload, { provider: "tsgw", modelId: id,
		api: id === lite.id ? "openai-completions" : "google-generative-ai", thinkingLevel, tsSearchMode: "live" }) as Payload;
}
for (const model of [lite, high, flash]) {
	for (const level of levels) {
		const payload: Payload = {
			model: "keep", messages: [{ role: "user", content: "hello" }], contents: [{ role: "user", parts: [{ text: "hello" }] }],
			tools: [{ type: "function", name: "probe" }], max_tokens: 42, thinking: { type: "disabled" }, reasoning_effort: "stale",
			config: { temperature: 0.7, topP: 0.9, topK: 40, systemInstruction: "keep", thinkingConfig: { thinkingBudget: 42, retained: true } },
		};
		const before = structuredClone(payload);
		freeze(payload);
		const result = apply(model.id, payload, level);
		deepStrictEqual(payload, before);
		strictEqual(result.messages, payload.messages);
		strictEqual(result.contents, payload.contents);
		strictEqual(result.tools, payload.tools);
		equal(result.max_tokens, 42);
		if (model.id === lite.id) {
			equal(Object.hasOwn(result, "thinking"), false);
			equal(result.reasoning_effort, ["off", "minimal"].includes(level) ? "minimal" : ["xhigh", "max"].includes(level) ? "high" : level);
			strictEqual(result.config, payload.config, "Completions 不改写无关 Google config");
		} else {
			equal(Object.hasOwn(result, "reasoning_effort"), false);
			strictEqual(result.thinking, payload.thinking, "原生 Google 不改写无关顶层 thinking");
			deepStrictEqual(result.config, {
				temperature: 0.7, topP: 0.9, topK: 40, systemInstruction: "keep",
				thinkingConfig: { retained: true, includeThoughts: level !== "off",
					thinkingLevel: ["off", "minimal", "low"].includes(level) ? "LOW" : level === "medium" ? "MEDIUM" : "HIGH" },
			});
		}
		strictEqual(apply(model.id, result, level), result);
		strictEqual(applyModelOperations(payload, { provider: "other", modelId: model.id, api: model.api!, thinkingLevel: level, tsSearchMode: "live" }), payload);
	}
}

// 真宿主 Google/Completions adapter + HTTP 夹具：验证路径、认证与最终线上字段形状。
// 只覆盖适配契约，不替代实际模型的工具往返验收。
const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	credentials: { read: async id => id === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
		list: async () => [], modify: async () => undefined, delete: async () => {} },
});
runtime.registerProvider("tsgw", { models: [lite, high, flash] });
const originalFetch = globalThis.fetch;
try {
	for (const config of [lite, high, flash]) {
		let requests = 0;
		globalThis.fetch = async (input, init) => {
			requests++;
			const request = new Request(input, init);
			const body = await request.json() as Record<string, any>;
			if (config.api === "google-generative-ai") {
				equal(new URL(request.url).pathname, `${new URL(config.baseUrl!).pathname}/models/${config.id}:streamGenerateContent`);
				equal(request.headers.get("x-goog-api-key"), "fixture-key");
				deepStrictEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: "LOW" });
				if (config.id === flash.id) {
					const calls = body.contents.flatMap((content: any) => content.parts).filter((part: any) => part.functionCall);
					if (requests === 1) {
						equal(body.tools[0].functionDeclarations[0].name, "probe");
						return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"probe","args":{"value":"PING"}},"thoughtSignature":"Zml4dHVyZQ=="}]},"finishReason":"STOP","index":0}]}\n\n', { headers: { "content-type": "text/event-stream" } });
					}
					equal(calls[0].thoughtSignature, "Zml4dHVyZQ==");
					deepStrictEqual(calls[0].functionCall.args, { value: "PING" });
					const response = body.contents.flatMap((content: any) => content.parts).find((part: any) => part.functionResponse);
					equal(response.functionResponse.name, "probe");
					equal(JSON.stringify(response.functionResponse.response).includes("PONG"), true);
				}
				return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP","index":0}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}\n\n', { headers: { "content-type": "text/event-stream" } });
			}
			equal(new URL(request.url).pathname, "/v1/chat/completions");
			equal(request.headers.get("authorization"), "Bearer fixture-key");
			equal(body.reasoning_effort, "low");
			equal(Object.hasOwn(body, "config"), false);
			equal(Object.hasOwn(body, "thinking"), false);
			return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
		};
		const model = runtime.getModel("tsgw", config.id)!;
		const context = {
			messages: [{ role: "user" as const, content: "test", timestamp: 0 }],
			tools: [{ name: "probe", description: "测试工具", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
		};
		const options = { reasoning: "low" as const, maxTokens: 512, maxRetries: 0,
			onPayload: (payload: unknown) => apply(config.id, payload as Payload, "low") };
		let result = await runtime.streamSimple(model, context, options).result();
		if (config.id === flash.id) {
			equal(result.stopReason, "toolUse", result.errorMessage ?? config.id);
			const call = result.content.find(part => part.type === "toolCall")!;
			equal(call.name, "probe");
			deepStrictEqual(call.arguments, { value: "PING" });
			result = await runtime.streamSimple(model, { ...context, messages: [...context.messages, result, {
				role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "PONG" }], isError: false, timestamp: 1,
			}] }, options).result();
		}
		equal(result.stopReason, "stop", result.errorMessage ?? config.id);
		deepStrictEqual(result.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
		equal(requests, config.id === flash.id ? 2 : 1);
	}
} finally { globalThis.fetch = originalFetch; }
console.log("gemini-new.test.ts：混合协议、七档、冻结输入及宿主路径契约通过");
