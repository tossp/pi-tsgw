import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { registerSearchProxyTool } from "./proxy.ts";
import type { SearchDelegate } from "../models/web-search.ts";
import { modelsForRoot } from "../models/catalog.ts";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Registry = ExtensionToolContext["modelRegistry"];
type Reply = Awaited<ReturnType<Registry["complete"]>>;
const usage: Reply["usage"] = {
	input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, total: 0.31 },
};

function fixture() {
	let tool!: Tool;
	let delegate: SearchDelegate | undefined = { modelId: "gpt-6-luna", kind: "gpt" };
	let mode: "live" | "cached" = "live";
	const model = { ...modelsForRoot("https://proxy-test.invalid").find(model => model.id === "gpt-6-luna")!, provider: "tsgw" } as NonNullable<ReturnType<Registry["find"]>>;
	let calls = 0;
	let reply = { content: [{ type: "text", text: "answer" }], stopReason: "stop", usage } as Reply;
	let thrown = false;
	let payload: unknown;
	let operation: AbortSignal | undefined;
	const registry = {
		find: () => model,
		streamSimple: (_model, context, options) => {
			calls++;
			assert.equal(context.messages.length, 1);
			assert.equal(context.messages[0].role, "user");
			assert.equal(context.messages[0].content, "question");
			assert.equal(context.tools, undefined);
			assert.equal(options?.reasoning, "low");
			operation = options?.signal;
			const original = Object.freeze({ model: model.id, tools: Object.freeze([]), keep: 42 });
			payload = options?.onPayload?.(original, model as never);
			const url = "https://source.example/article";
			for (const event of [
				{ type: "response.output_text.annotation.added", annotation: { url } },
				{ type: "response.output_item.done", item: { content: [{ annotations: [{ url }] }] } },
				{ citations: [url, "javascript:alert(1)", "invalid", { url: "https://source.example/other" }] },
			]) options?.onProviderStreamEvent?.(Object.freeze(event), model as never);
			return { result: async () => {
				if (thrown) throw new Error("private-provider-response-with-secret");
				return reply;
			} } as ReturnType<Registry["streamSimple"]>;
		},
	} satisfies Pick<Registry, "streamSimple" | "find">;
	registerSearchProxyTool({ registerTool: value => { tool = value as unknown as Tool; } } as ExtensionAPI,
		{ delegate: () => delegate, mode: () => mode });
	const ctx = { modelRegistry: registry } as unknown as ExtensionToolContext;
	return {
		tool, registry, model, calls: () => calls, payload: () => payload, operation: () => operation,
		run: (signal?: AbortSignal) => tool.execute("call", { query: "question" }, signal, undefined, ctx),
		delegate: (value: SearchDelegate | undefined) => { delegate = value; },
		mode: (value: typeof mode) => { mode = value; },
		reply: (value: Partial<Reply>) => { reply = { ...reply, ...value }; },
		throw: () => { thrown = true; },
	};
}

test("代理保存模式快照、向冻结请求体注入参数并保留 Pi 用量与引用 URL", async () => {
	const f = fixture();
	assert.equal(f.tool.defaultActive, false);
	f.mode("cached");
	const controller = new AbortController();
	const result = await f.run(controller.signal);
	assert.equal(result.usage, usage);
	assert.equal(result.isError, undefined);
	assert.deepEqual(result.structuredContent, {
		delegate: "gpt-6-luna", answer: "answer", truncated: false,
		citations: ["https://source.example/article", "https://source.example/other"],
	});
	assert.deepEqual(f.payload(), {
		model: "gpt-6-luna", keep: 42, text: { verbosity: "low" },
		tools: [{ type: "web_search", search_context_size: "medium", external_web_access: false }],
	});
	controller.abort();
	assert.equal(f.operation()?.aborted, true);
});

test("代理在请求前校验当前委托模型与注册表中的实际协议", async () => {
	const f = fixture();
	f.delegate(undefined);
	await assert.rejects(f.run(), /没有可供当前模型使用的代理模型/);
	f.delegate({ modelId: "gpt-6-luna", kind: "grok" });
	await assert.rejects(f.run(), /受支持的协议/);
	assert.equal(f.calls(), 0);
});

test("代理保留失败用量但绝不暴露提供方原始错误或部分回答", async () => {
	const f = fixture();
	f.reply({ stopReason: "error", errorMessage: "secret-provider-error", content: [{ type: "text", text: "partial-private-response" }] });
	const result = await f.run();
	assert.equal(result.isError, true);
	assert.equal(result.usage, usage);
	assert.doesNotMatch(JSON.stringify(result), /secret-provider-error|partial-private-response/);
	f.throw();
	await assert.rejects(f.run(), error => {
		assert.match(String(error), /代理搜索失败/);
		assert.doesNotMatch(String(error), /private-provider-response-with-secret/);
		return true;
	});
});

test("代理报告截断与空回答，预先取消时绝不发起请求", async () => {
	const f = fixture();
	f.reply({ stopReason: "length" });
	const truncated = await f.run();
	assert.match(JSON.stringify(truncated.content), /已截断/);
	f.reply({ content: [] });
	assert.equal((await f.run()).isError, true);
	const before = f.calls();
	await assert.rejects(f.run(AbortSignal.abort()));
	assert.equal(f.calls(), before);
});
