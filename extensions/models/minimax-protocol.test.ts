import { deepStrictEqual, equal, strictEqual } from "node:assert/strict";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { applyModelOperations } from "./operations.ts";
import { minimaxModels } from "./vendors/minimax.ts";
import type { Payload, ThinkingLevel } from "./_tools.ts";

const root = "https://gateway.invalid";
const config = minimaxModels(root).find(model => model.id === "MiniMax-M3.1-Flash")!;
equal(config.api, "anthropic-messages");
equal(config.baseUrl, `${root}/anthropic`);
equal(config.thinkingLevelMap?.off, null);
deepStrictEqual(config.compat, { forceAdaptiveThinking: true, allowEmptySignature: true });
// 全系列统一协议；M3 仍可关闭思考，且没有 M3.1 的 effort 档位。
const legacy = minimaxModels(root).find(model => model.id === "MiniMax-M3")!;
for (const entry of minimaxModels(root)) {
	equal(entry.api, "anthropic-messages");
	equal(entry.baseUrl, `${root}/anthropic`);
	deepStrictEqual(entry.compat, config.compat);
}
equal(legacy.thinkingLevelMap?.off, undefined);

function apply(payload: Payload, thinkingLevel: ThinkingLevel, entry = config): Payload {
	return applyModelOperations(payload, {
		provider: "tsgw", modelId: entry.id, api: entry.api!, thinkingLevel, tsSearchMode: "live",
	}) as Payload;
}
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
for (const level of levels) {
	const messages = Object.freeze([{ role: "user", content: "保留消息" }]);
	const tools = Object.freeze([{ name: "probe", input_schema: { type: "object" } }]);
	const output = Object.freeze({ effort: "none", format: { type: "json_schema" }, retained: true });
	const thinking = Object.freeze({ type: "disabled", retained: true });
	const input = Object.freeze({
		messages, tools, output_config: output, thinking, max_tokens: 512,
		reasoning_effort: "none", reasoning_split: true, stream: true,
	});
	const result = apply(input, level);
	const effort = level === "off" || level === "minimal" ? "low" : level;
	deepStrictEqual(result.output_config, { ...output, effort });
	deepStrictEqual(result.thinking, { type: "adaptive", retained: true });
	strictEqual(result.messages, messages);
	strictEqual(result.tools, tools);
	strictEqual((result.output_config as Payload).format, output.format);
	equal(result.max_tokens, 512);
	equal(result.stream, true);
	equal(Object.hasOwn(result, "reasoning_effort"), false);
	equal(Object.hasOwn(result, "reasoning_split"), false);
	equal(input.output_config.effort, "none");
	equal(input.thinking.type, "disabled");
	strictEqual(apply(result, level), result);
}
// 未改动的 output_config 不复制，缺失配置则补入明确档位，避免服务端默认 max。
const stableOutput = { effort: "high", retained: true };
strictEqual(apply({ output_config: stableOutput }, "high").output_config, stableOutput);
deepStrictEqual(apply({}, "off"), { thinking: { type: "adaptive" }, output_config: { effort: "low" } });

for (const level of levels) {
	const output = Object.freeze({ effort: "high", format: { type: "json_schema" } });
	const input = Object.freeze({ output_config: output, reasoning_split: true, reasoning_effort: "high" });
	const result = apply(input, level, legacy);
	deepStrictEqual(result.thinking, { type: level === "off" ? "disabled" : "adaptive" });
	deepStrictEqual(result.output_config, { format: output.format });
	strictEqual((result.output_config as Payload).format, output.format);
	equal(input.output_config.effort, "high");
	equal(Object.hasOwn(result, "reasoning_split"), false);
	equal(Object.hasOwn(result, "reasoning_effort"), false);
	strictEqual(apply(result, level, legacy), result);
}
deepStrictEqual(apply({ output_config: { effort: "high" } }, "high", legacy), { thinking: { type: "adaptive" } });
const m3Output = { format: { type: "json_schema" } };
strictEqual(apply({ output_config: m3Output }, "high", legacy).output_config, m3Output);

// 真宿主 Anthropic 适配器 + 受控 SSE；不访问个人凭据或真实网关。
async function testHost(config: ReturnType<typeof minimaxModels>[number]): Promise<void> {
	const runtime = await ModelRuntime.create({
		credentials: {
			read: async provider => provider === "tsgw" ? { type: "api_key" as const, key: "fixture-key" } : undefined,
			list: async () => [], modify: async () => undefined, delete: async () => {},
		},
		modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
	});
	runtime.registerProvider("tsgw", { models: [config] });
	const model = runtime.getModel("tsgw", config.id)!;
	const fetched: Payload[] = [];
	function events(blocks: Payload[], stopReason: string): Response {
		const all = [
			{ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: config.id,
				content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
			...blocks.flatMap((block, index) => [
				{ type: "content_block_start", index, content_block: block },
				...(block.type === "tool_use" ? [{ type: "content_block_delta", index,
					delta: { type: "input_json_delta", partial_json: '{"value":"PING"}' } }] : []),
				{ type: "content_block_stop", index },
			]),
			{ type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
			{ type: "message_stop" },
		];
		return new Response(all.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	}
	let fetchError: unknown;
	const fakeFetch: typeof fetch = async (url, init) => {
		try {
			const request = new Request(url, init);
			const endpoint = new URL(request.url);
			equal(`${endpoint.origin}${endpoint.pathname}`, `${root}/anthropic/v1/messages`);
			equal(request.headers.get("x-api-key"), "fixture-key");
			const body = await request.json() as Payload;
			fetched.push(body);
			equal(body.model, config.id);
			equal(body.max_tokens, 512);
			equal(Object.hasOwn(body, "reasoning_effort"), false);
			equal(Object.hasOwn(body, "reasoning_split"), false);
			return fetched.length === 1 ? events([
				// MiniMax 可返回无签名 thinking；工具回放不得被宿主降为 text。
				{ type: "thinking", thinking: "先调用工具确认", signature: "" },
				{ type: "tool_use", id: "call_fixture", name: "probe", input: {} },
			], "tool_use") : events([{ type: "text", text: "OK" }], "end_turn");
		} catch (error) {
			fetchError = error;
			throw error;
		}
	};
	const context = {
		messages: [{ role: "user" as const, content: "Call probe.", timestamp: 0 }],
		tools: [{ name: "probe", description: "测试工具", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
	};
	function options(level: ThinkingLevel) {
		return { reasoning: level === "off" ? undefined : level, maxTokens: 512, maxRetries: 0, fetch: fakeFetch,
			onPayload: (payload: unknown) => apply(payload as Payload, level, config) };
	}
	const first = await runtime.streamSimple(model, context, options("high")).result();
	if (fetchError) throw fetchError;
	equal(first.stopReason, "toolUse", first.errorMessage ?? "首轮工具调用失败");
	const call = first.content.find(part => part.type === "toolCall")!;
	equal(call.name, "probe");
	deepStrictEqual(call.arguments, { value: "PING" });
	const thought = first.content.find(part => part.type === "thinking")!;
	equal(thought.thinking, "先调用工具确认");
	const second = await runtime.streamSimple(model, { ...context, messages: [...context.messages, first, {
		role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "PONG" }], isError: false, timestamp: 1,
	}] }, options("high")).result();
	equal(second.stopReason, "stop", second.errorMessage ?? "工具回放失败");
	deepStrictEqual(second.content.filter(part => part.type === "text").map(part => part.text), ["OK"]);
	const replay = fetched[1]!.messages as { role: string; content: Payload[] }[];
	const assistant = replay.find(message => message.role === "assistant")!;
	equal(assistant.content[0]!.type, "thinking");
	equal(assistant.content[0]!.thinking, "先调用工具确认");
	equal(assistant.content[1]!.type, "tool_use");
	equal(replay.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_result" && block.tool_use_id === call.id)), true);
	for (const level of levels) {
		const result = await runtime.streamSimple(model, context, options(level)).result();
		equal(result.stopReason, "stop", result.errorMessage ?? "档位请求失败");
		const body = fetched.at(-1)!;
		equal((body.thinking as Payload).type, config.id === legacy.id && level === "off" ? "disabled" : "adaptive");
		if (config.id === legacy.id) equal(Object.hasOwn(body, "output_config"), false);
		else deepStrictEqual(body.output_config, { effort: ["off", "minimal"].includes(level) ? "low" : level });
	}
	equal(fetched.length, 9);
}
for (const entry of minimaxModels(root)) await testHost(entry);
console.log("minimax-protocol：全系列 Anthropic 登记、七档参数与宿主 thinking/工具回放隔离测试通过（不代表真实端点验收）");
