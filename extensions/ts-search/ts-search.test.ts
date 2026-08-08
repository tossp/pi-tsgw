import { deepStrictEqual, strictEqual, throws } from "node:assert";
import {
	buildSearchPayload,
	buildSearchUrl,
	detectSearchFamily,
	filterSearchModels,
	resolveSearchModels,
} from "./ts-search.ts";

function testModelSelection(): void {
	deepStrictEqual(
		filterSearchModels([
			"deepseek-v4-flash",
			"gpt-5.4",
			"grok-4.20-fast",
			"claude-sonnet-5",
			"gpt-5.4",
		]),
		["gpt-5.4", "grok-4.20-fast"],
	);
	strictEqual(detectSearchFamily("gpt-5.4"), "gpt");
	strictEqual(detectSearchFamily("grok-4.20-fast"), "grok");
	strictEqual(detectSearchFamily("gptish-model"), "unsupported");
	strictEqual(detectSearchFamily("other/grok-4.20-fast"), "unsupported");
	throws(
		() => resolveSearchModels("deepseek-v4-flash"),
		/only gpt-\* or grok-\*/,
	);
}

function testDefaultRoutes(): void {
	deepStrictEqual(resolveSearchModels(), ["gpt-5.4", "grok-4.20-fast"]);
	deepStrictEqual(resolveSearchModels("gpt-5.6-sol"), ["gpt-5.6-sol"]);
	deepStrictEqual(resolveSearchModels("grok-4.5"), ["grok-4.5"]);
}

function testPayloads(): void {
	strictEqual(
		buildSearchUrl("https://gateway.example.com"),
		"https://gateway.example.com/v1/chat/completions",
	);
	strictEqual(
		buildSearchUrl("https://gateway.example.com/proxy"),
		"https://gateway.example.com/proxy/v1/chat/completions",
	);

	const gpt = buildSearchPayload("gpt-5.4", "gpt", "latest TypeScript news");
	deepStrictEqual(gpt.tools, [{ type: "web_search" }]);
	strictEqual(gpt.search_parameters, undefined);

	const grok = buildSearchPayload(
		"grok-4.20-fast",
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

testModelSelection();
testDefaultRoutes();
testPayloads();
console.log("ts-search.test.ts: all assertions passed");
