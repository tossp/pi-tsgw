import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { deepStrictEqual, match, strictEqual } from "node:assert";
import {
	buildSearchPayload,
	buildSearchUrl,
	DEFAULT_SEARCH_MODELS,
	registerTsSearch,
	resolveSearchModels,
} from "./ts-search.ts";

interface ToolTextResult {
	content: Array<{ type: string; text: string }>;
	details: unknown;
}

interface CapturedTool {
	parameters: { properties?: Record<string, unknown> };
	execute: (
		toolCallId: string,
		params: { query: string },
		signal: AbortSignal,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<ToolTextResult>;
}

interface CapturedRequest {
	url: string;
	model: string;
	body: Record<string, unknown>;
	authorization: string | null;
	signal: AbortSignal | null;
}

function captureTool(): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			captured = tool as CapturedTool;
		},
	} as unknown as ExtensionAPI;
	registerTsSearch(pi, {
		baseUrl: "https://gateway.example.com/proxy",
		// 兼容字段应被忽略，不能改变固定白名单。
		searchModels: ["gpt-not-used", "grok-not-used"],
	});
	if (!captured) throw new Error("expected ts_search tool registration");
	return captured;
}

function fakeContext(
	getApiKey: () => Promise<string | undefined>,
): ExtensionContext {
	return {
		modelRegistry: { getApiKeyForProvider: getApiKey },
	} as unknown as ExtensionContext;
}

function responseWithAnswer(answer: string): Response {
	return new Response(
		JSON.stringify({ choices: [{ message: { content: answer } }] }),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function failedResponse(message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status: 503,
		statusText: "Service Unavailable",
	});
}

function textOf(result: ToolTextResult): string {
	return result.content.map((item) => item.text).join("\n");
}

function testFixedRoutesAndPayloads(): void {
	deepStrictEqual(DEFAULT_SEARCH_MODELS, ["gpt-5.6-luna", "grok-4.20"]);
	deepStrictEqual(resolveSearchModels(), ["gpt-5.6-luna", "grok-4.20"]);

	const routes = resolveSearchModels();
	routes[0] = "mutated";
	deepStrictEqual(resolveSearchModels(), ["gpt-5.6-luna", "grok-4.20"]);

	strictEqual(
		buildSearchUrl("https://gateway.example.com"),
		"https://gateway.example.com/v1/chat/completions",
	);
	strictEqual(
		buildSearchUrl("https://gateway.example.com/proxy"),
		"https://gateway.example.com/proxy/v1/chat/completions",
	);

	const gpt = buildSearchPayload(
		"gpt-5.6-luna",
		"gpt",
		"latest TypeScript news",
	);
	deepStrictEqual(gpt.tools, [
		{
			type: "web_search",
			search_context_size: "medium",
			external_web_access: true,
		},
	]);
	strictEqual(gpt.search_parameters, undefined);

	const grok = buildSearchPayload(
		"grok-4.20",
		"grok",
		"latest TypeScript news",
	);
	deepStrictEqual(grok.search_parameters, { mode: "on" });
	strictEqual(grok.tools, undefined);

	for (const payload of [gpt, grok]) {
		const messages = payload.messages;
		if (!Array.isArray(messages)) throw new Error("expected messages array");
		deepStrictEqual(messages.at(-1), {
			role: "user",
			content: "latest TypeScript news",
		});
	}
}

async function testPartialSuccessAndRegisteredSchema(): Promise<void> {
	const tool = captureTool();
	deepStrictEqual(Object.keys(tool.parameters.properties ?? {}), ["query"]);

	const requests: CapturedRequest[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const model = String(body.model);
		requests.push({
			url: String(input),
			model,
			body,
			authorization: new Headers(init?.headers).get("authorization"),
			signal: init?.signal ?? null,
		});
		return model === "gpt-5.6-luna"
			? responseWithAnswer("最新答案 https://source.example/a")
			: failedResponse("no available channel");
	}) as typeof fetch;

	const signal = new AbortController().signal;
	try {
		const result = await tool.execute(
			"call-1",
			{ query: "latest news" },
			signal,
			undefined,
			fakeContext(async () => "secret-key"),
		);
		const text = textOf(result);
		match(text, /状态：部分成功/);
		match(text, /gpt（gpt-5\.6-luna）结果：/);
		match(text, /最新答案/);
		match(text, /注：grok 后端不可用，已跳过。/);
		strictEqual(text.includes("no available channel"), false);
	} finally {
		globalThis.fetch = originalFetch;
	}

	deepStrictEqual(
		requests.map((request) => request.model),
		["gpt-5.6-luna", "grok-4.20"],
	);
	for (const request of requests) {
		strictEqual(
			request.url,
			"https://gateway.example.com/proxy/v1/chat/completions",
		);
		strictEqual(request.authorization, "Bearer secret-key");
		strictEqual(request.signal, signal);
	}
	deepStrictEqual(requests[0].body.tools, [
		{
			type: "web_search",
			search_context_size: "medium",
			external_web_access: true,
		},
	]);
	deepStrictEqual(requests[1].body.search_parameters, { mode: "on" });
}

async function testAllFailedAndChineseErrors(): Promise<void> {
	const tool = captureTool();
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => failedResponse("no channel")) as typeof fetch;
	try {
		const result = await tool.execute(
			"call-2",
			{ query: "latest news" },
			new AbortController().signal,
			undefined,
			fakeContext(async () => "secret-key"),
		);
		const text = textOf(result);
		match(text, /状态：失败/);
		match(text, /全部搜索后端失败：/);
		match(text, /网关请求失败：HTTP 503 Service Unavailable/);
	} finally {
		globalThis.fetch = originalFetch;
	}

	const keyFailure = await tool.execute(
		"call-3",
		{ query: "latest news" },
		new AbortController().signal,
		undefined,
		fakeContext(async () => {
			throw new Error("credential store unavailable");
		}),
	);
	match(textOf(keyFailure), /解析 API key 失败/);
}

testFixedRoutesAndPayloads();
await testPartialSuccessAndRegisteredSchema();
await testAllFailedAndChineseErrors();
console.log("ts-search.test.ts: all assertions passed");
