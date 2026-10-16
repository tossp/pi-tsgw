import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { registerSearchProxyTool } from "./search-proxy.ts";
import type { SearchDelegate } from "./models/web-search.ts";
import { modelsForRoot } from "./models/catalog.ts";

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

test("proxy snapshots mode, injects into frozen payload and preserves Pi usage/citation URLs", async () => {
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

test("proxy validates current delegate and actual registry protocol before requesting", async () => {
	const f = fixture();
	f.delegate(undefined);
	await assert.rejects(f.run(), /no available delegate/);
	f.delegate({ modelId: "gpt-6-luna", kind: "grok" });
	await assert.rejects(f.run(), /supported protocol/);
	assert.equal(f.calls(), 0);
});

test("proxy preserves failure usage but never exposes raw provider errors or partial answer", async () => {
	const f = fixture();
	f.reply({ stopReason: "error", errorMessage: "secret-provider-error", content: [{ type: "text", text: "partial-private-response" }] });
	const result = await f.run();
	assert.equal(result.isError, true);
	assert.equal(result.usage, usage);
	assert.doesNotMatch(JSON.stringify(result), /secret-provider-error|partial-private-response/);
	f.throw();
	await assert.rejects(f.run(), error => {
		assert.match(String(error), /delegated search failed/);
		assert.doesNotMatch(String(error), /private-provider-response-with-secret/);
		return true;
	});
});

test("proxy reports truncation and empty answer, and pre-abort never starts a request", async () => {
	const f = fixture();
	f.reply({ stopReason: "length" });
	const truncated = await f.run();
	assert.match(JSON.stringify(truncated.content), /truncated/);
	f.reply({ content: [] });
	assert.equal((await f.run()).isError, true);
	const before = f.calls();
	await assert.rejects(f.run(AbortSignal.abort()));
	assert.equal(f.calls(), before);
});
