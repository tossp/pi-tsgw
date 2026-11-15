import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { registerSearchProxyTool } from "./proxy.ts";
import type { SearchDelegate } from "#tsgw/models/web-search";
import { modelsForRoot } from "#tsgw/models/catalog";

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
				{ type: "response.output_item.done", item: { content: [{ annotations: [
					{ url }, { url: "javascript:alert(1)" }, { url: "invalid" }, { url: "https://source.example/other" },
				] }] } },
			]) options?.onProviderStreamEvent?.(Object.freeze(event), model as never);
			return { result: async () => {
				if (thrown) throw new Error("private-provider-response-with-secret");
				return reply;
			} } as ReturnType<Registry["streamSimple"]>;
		},
	} satisfies Pick<Registry, "streamSimple" | "find">;
	registerSearchProxyTool({ registerTool: value => { tool = value as unknown as Tool; } } as ExtensionAPI,
		{ delegate: () => delegate });
	const ctx = { modelRegistry: registry } as unknown as ExtensionToolContext;
	return {
		tool, registry, model, calls: () => calls, payload: () => payload, operation: () => operation,
		run: (signal?: AbortSignal, mode?: "live" | "cached") => tool.execute("call", { query: "question", ...(mode ? { mode } : {}) }, signal, undefined, ctx),
		delegate: (value: SearchDelegate | undefined) => { delegate = value; },
		reply: (value: Partial<Reply>) => { reply = { ...reply, ...value }; },
		throw: () => { thrown = true; },
	};
}

test("代理按调用模式向冻结请求体注入参数并保留 Pi 用量与引用 URL", async () => {
	const f = fixture();
	assert.equal(f.tool.exposure, "deferred");
	assert.equal(f.tool.namespace?.name, "tsgw_search");
	const controller = new AbortController();
	const result = await f.run(controller.signal, "cached");
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

test("每次调用独立选择模式，省略时回到实时且不继承前次缓存模式", async () => {
	const f = fixture();
	for (const mode of [undefined, "cached", "live", "cached", undefined] as const) {
		await f.run(undefined, mode);
		assert.equal((f.payload() as { tools: { external_web_access: boolean }[] }).tools[0]!.external_web_access,
			mode !== "cached");
	}
	assert.equal(f.calls(), 5);
});

test("代理在请求前校验当前委托模型与注册表中的实际协议", async () => {
	const f = fixture();
	f.delegate(undefined);
	await assert.rejects(f.run());
	f.delegate({ modelId: "gpt-6-luna", kind: "gpt" });
	f.model.api = "openai-completions";
	await assert.rejects(f.run());
	assert.equal(f.calls(), 0);
});

test("代理保留失败用量但绝不暴露提供方原始错误或部分回答", async () => {
	const f = fixture();
	f.reply({ stopReason: "error", errorMessage: "secret-provider-error", content: [{ type: "text", text: "partial-private-response" }] });
	const result = await f.run();
	assert.equal(result.isError, true);
	assert.equal(result.usage, usage);
	assert.doesNotMatch(JSON.stringify(result), /secret-provider-error|partial-private-response/);
	assert.equal(f.calls(), 1);
	f.throw();
	await assert.rejects(f.run(), error => {
		assert.doesNotMatch(String(error), /private-provider-response-with-secret/);
		return true;
	});
	assert.equal(f.calls(), 2);
});

test("代理报告截断与空回答，预先取消时绝不发起请求", async () => {
	const f = fixture();
	f.reply({ stopReason: "length" });
	const truncated = await f.run();
	assert.equal((truncated.structuredContent as { truncated: boolean }).truncated, true);
	assert.equal(truncated.isError, undefined);
	assert.equal(truncated.usage, usage);
	assert.equal(f.calls(), 1);
	f.reply({ content: [] });
	const empty = await f.run();
	assert.equal(empty.isError, true);
	assert.equal(empty.usage, usage);
	assert.equal(f.calls(), 2);
	const before = f.calls();
	await assert.rejects(f.run(AbortSignal.abort()));
	assert.equal(f.calls(), before);
});
