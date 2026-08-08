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
	retrySearchRoute,
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

function captureTool(searchModels?: readonly string[]): CapturedTool {
	let captured: CapturedTool | undefined;
	const pi = {
		registerTool(tool: unknown) {
			captured = tool as CapturedTool;
		},
	} as unknown as ExtensionAPI;
	registerTsSearch(pi, {
		baseUrl: "https://gateway.example.com/proxy",
		searchModels,
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

function failedResponse(
	message: string,
	status = 400,
	statusText = "Bad Request",
): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		statusText,
	});
}

function textOf(result: ToolTextResult): string {
	return result.content.map((item) => item.text).join("\n");
}

function testRoutesConfigurationAndPayloads(): void {
	deepStrictEqual(DEFAULT_SEARCH_MODELS, ["gpt-5.6-luna", "grok-chat-fast"]);
	deepStrictEqual(resolveSearchModels(), ["gpt-5.6-luna", "grok-chat-fast"]);

	const routes = resolveSearchModels();
	routes[0] = "mutated";
	deepStrictEqual(resolveSearchModels(), ["gpt-5.6-luna", "grok-chat-fast"]);

	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...values: unknown[]) => warnings.push(values.join(" "));
	try {
		deepStrictEqual(
			resolveSearchModels({
				searchModels: [
					" gpt-custom ",
					"GROK-CUSTOM",
					"gpt-custom",
					"claude-invalid",
				],
			}),
			["gpt-custom", "GROK-CUSTOM"],
		);
		deepStrictEqual(
			resolveSearchModels({ searchModels: ["claude-invalid", ""] }),
			["gpt-5.6-luna", "grok-chat-fast"],
		);
	} finally {
		console.warn = originalWarn;
	}
	strictEqual(warnings.some((warning) => warning.includes("claude-invalid")), true);

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
		"grok-chat-fast",
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
		["gpt-5.6-luna", "grok-chat-fast"],
	);
	for (const request of requests) {
		strictEqual(
			request.url,
			"https://gateway.example.com/proxy/v1/chat/completions",
		);
		strictEqual(request.authorization, "Bearer secret-key");
		strictEqual(request.signal instanceof AbortSignal, true);
		strictEqual(request.signal?.aborted, false);
		strictEqual(request.signal === signal, false);
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
		match(text, /网关请求失败：HTTP 400 Bad Request/);
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

async function testRetryClassification(): Promise<void> {
	const route = (
		fetchImpl: typeof fetch,
		requestTimeoutMs = 45_000,
	): Promise<Awaited<ReturnType<typeof retrySearchRoute>>> =>
		retrySearchRoute(
			"gpt-retry-test",
			"latest news",
			"secret-key",
			"https://gateway.example.com/proxy",
			undefined,
			{ delayMs: 0, fetch: fetchImpl, requestTimeoutMs },
		);

	let networkCalls = 0;
	const networkThenSuccess = (async () => {
		networkCalls += 1;
		if (networkCalls === 1) throw new Error("temporary network failure");
		return responseWithAnswer("retry success");
	}) as typeof fetch;
	const networkResult = await route(networkThenSuccess);
	strictEqual(networkCalls, 2);
	strictEqual(networkResult.ok, true);
	strictEqual(networkResult.answer, "retry success");

	let timeoutCalls = 0;
	const timeoutThenSuccess = (async (_input, init) => {
		timeoutCalls += 1;
		if (timeoutCalls > 1) return responseWithAnswer("timeout retry success");
		return new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			const keepAlive = setTimeout(() => {}, 100);
			const rejectOnAbort = (): void => {
				clearTimeout(keepAlive);
				reject(signal?.reason);
			};
			if (signal?.aborted) rejectOnAbort();
			else signal?.addEventListener("abort", rejectOnAbort, { once: true });
		});
	}) as typeof fetch;
	const timeoutResult = await route(timeoutThenSuccess, 1);
	strictEqual(timeoutCalls, 2);
	strictEqual(timeoutResult.ok, true);
	strictEqual(timeoutResult.answer, "timeout retry success");

	let exhaustedCalls = 0;
	const exhausted = await route(
		(async () => {
			exhaustedCalls += 1;
			throw new Error("network unavailable");
		}) as typeof fetch,
	);
	strictEqual(exhaustedCalls, 3);
	strictEqual(exhausted.ok, false);
	match(exhausted.error, /network unavailable/);

	for (const [status, statusText] of [
		[429, "Too Many Requests"],
		[500, "Internal Server Error"],
	] as const) {
		let calls = 0;
		const result = await route(
			(async () => {
				calls += 1;
				return calls === 1
					? failedResponse("retryable", status, statusText)
					: responseWithAnswer(`recovered from ${status}`);
			}) as typeof fetch,
		);
		strictEqual(calls, 2);
		strictEqual(result.ok, true);
		strictEqual(result.answer, `recovered from ${status}`);
	}

	let badRequestCalls = 0;
	const badRequest = await route(
		(async () => {
			badRequestCalls += 1;
			return failedResponse("invalid request");
		}) as typeof fetch,
	);
	strictEqual(badRequestCalls, 1);
	strictEqual(badRequest.ok, false);
	match(badRequest.error, /HTTP 400 Bad Request/);

	let noLiveWebCalls = 0;
	const noLiveWeb = await route(
		(async () => {
			noLiveWebCalls += 1;
			return responseWithAnswer("NO_LIVE_WEB");
		}) as typeof fetch,
	);
	strictEqual(noLiveWebCalls, 1);
	strictEqual(noLiveWeb.ok, true);
	strictEqual(noLiveWeb.answer, "NO_LIVE_WEB");
}

testRoutesConfigurationAndPayloads();
await testRetryClassification();
await testPartialSuccessAndRegisteredSchema();
await testAllFailedAndChineseErrors();
console.log("ts-search.test.ts: all assertions passed");
