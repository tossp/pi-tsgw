import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createModelCache,
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
	fetchGatewayModelIds,
	getGatewayModelIds,
	loadGatewayModelCache,
	saveGatewayModelCache,
	type GatewayFetch,
	type GatewayModelFailureReason,
} from "./gateway-catalog.ts";

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function expectFailure(
	result: Awaited<ReturnType<typeof fetchGatewayModelIds>>,
	reason: GatewayModelFailureReason,
): void {
	if (result.ok) throw new Error(`expected ${reason} failure`);
	equal(result.reason, reason);
}

async function testSuccessfulFetch(): Promise<void> {
	let requestedUrl = "";
	let authorization = "";
	const fetcher: GatewayFetch = async (input, init) => {
		requestedUrl = String(input);
		authorization = new Headers(init?.headers).get("authorization") ?? "";
		equal(init?.method, "GET");
		strictEqual(init?.signal instanceof AbortSignal, true);
		return jsonResponse({
			data: [
				{ id: "gpt-5.4" },
				{ id: " grok-4.20-fast " },
				{ id: "gpt-5.4" },
				{ id: "" },
				{},
			],
		});
	};

	const result = await fetchGatewayModelIds(
		"https://gateway.example.com/",
		"secret",
		{ fetcher },
	);
	if (!result.ok) throw new Error(`unexpected failure: ${result.reason}`);
	deepStrictEqual(result.ids, ["gpt-5.4", "grok-4.20-fast"]);
	equal(requestedUrl, "https://gateway.example.com/v1/models");
	equal(authorization, "Bearer secret");
}

async function testFetchFailures(): Promise<void> {
	const http = await fetchGatewayModelIds("https://http.example.com", "key", {
		fetcher: async () => new Response("unavailable", { status: 503 }),
	});
	expectFailure(http, "http");
	if (http.ok) throw new Error("expected HTTP failure");
	equal(http.status, 503);

	const network = await fetchGatewayModelIds(
		"https://network.example.com",
		"key",
		{
			fetcher: async () => {
				throw new Error("offline");
			},
		},
	);
	expectFailure(network, "network");
	if (network.ok) throw new Error("expected network failure");
	equal(network.detail, "offline");

	const invalidJson = await fetchGatewayModelIds(
		"https://invalid-json.example.com",
		"key",
		{ fetcher: async () => new Response("not json") },
	);
	expectFailure(invalidJson, "invalid-json");

	const invalidData = await fetchGatewayModelIds(
		"https://invalid-data.example.com",
		"key",
		{ fetcher: async () => jsonResponse({ data: "not-an-array" }) },
	);
	expectFailure(invalidData, "invalid-data");

	const empty = await fetchGatewayModelIds("https://empty.example.com", "key", {
		fetcher: async () => jsonResponse({ data: [] }),
	});
	expectFailure(empty, "empty");

	const timeoutFetcher: GatewayFetch = (_input, init) =>
		new Promise((_resolve, reject) => {
			const signal = init?.signal;
			const rejectAbort = () => reject(new Error("aborted"));
			if (signal?.aborted) rejectAbort();
			else signal?.addEventListener("abort", rejectAbort, { once: true });
		});
	const timeout = await fetchGatewayModelIds(
		"https://timeout.example.com",
		"key",
		{ fetcher: timeoutFetcher, timeoutMs: 1 },
	);
	expectFailure(timeout, "timeout");
}

function testModelCache(): void {
	const cache = createModelCache(100);
	strictEqual(cache.get(), undefined);
	strictEqual(cache.isFresh(0), false);
	const source = ["gpt-5.4"];
	cache.set(source, 10);
	source.push("mutated");
	deepStrictEqual(cache.get(), { ids: ["gpt-5.4"], storedAt: 10 });
	strictEqual(cache.isFresh(109), true);
	strictEqual(cache.isFresh(110), false);

	const read = cache.get();
	read?.ids.push("also-mutated");
	deepStrictEqual(cache.get()?.ids, ["gpt-5.4"]);
}

async function testFreshCacheHit(): Promise<void> {
	let calls = 0;
	const fetcher: GatewayFetch = async () => {
		calls += 1;
		return jsonResponse({ data: [{ id: "gpt-5.4" }] });
	};
	const baseUrl = "https://fresh-cache.example.com";
	const first = await getGatewayModelIds(baseUrl, "key", { fetcher }, 0);
	const second = await getGatewayModelIds(
		baseUrl,
		"key",
		{ fetcher },
		DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS - 1,
	);

	if (!first.ok || !second.ok) throw new Error("expected cached results");
	equal(first.cached, false);
	equal(second.cached, true);
	equal(second.stale, false);
	deepStrictEqual(second.ids, ["gpt-5.4"]);
	equal(calls, 1);
}

async function testExpiredCacheRefresh(): Promise<void> {
	let calls = 0;
	const fetcher: GatewayFetch = async () => {
		calls += 1;
		return jsonResponse({ data: [{ id: `model-${calls}` }] });
	};
	const baseUrl = "https://expired-cache.example.com";
	await getGatewayModelIds(baseUrl, "key", { fetcher }, 0);
	const refreshed = await getGatewayModelIds(
		baseUrl,
		"key",
		{ fetcher },
		DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
	);

	if (!refreshed.ok) throw new Error("expected refreshed result");
	equal(refreshed.cached, false);
	deepStrictEqual(refreshed.ids, ["model-2"]);
	equal(calls, 2);
}

async function testStaleFallback(): Promise<void> {
	let calls = 0;
	const fetcher: GatewayFetch = async () => {
		calls += 1;
		return calls === 1
			? jsonResponse({ data: [{ id: "grok-4.20-fast" }] })
			: new Response("unavailable", { status: 503 });
	};
	const baseUrl = "https://stale-cache.example.com";
	await getGatewayModelIds(baseUrl, "key", { fetcher }, 0);
	const fallback = await getGatewayModelIds(
		baseUrl,
		"key",
		{ fetcher },
		DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
	);

	if (!fallback.ok) throw new Error("expected stale fallback");
	equal(fallback.cached, true);
	equal(fallback.stale, true);
	equal(fallback.fallbackReason, "http");
	deepStrictEqual(fallback.ids, ["grok-4.20-fast"]);
}

async function testFailureWithoutCache(): Promise<void> {
	const result = await getGatewayModelIds(
		"https://no-cache.example.com",
		"key",
		{ fetcher: async () => new Response("unavailable", { status: 404 }) },
		0,
	);
	if (result.ok) throw new Error("expected uncached failure");
	equal(result.reason, "http");
}

async function testConcurrentRequestDeduplication(): Promise<void> {
	let calls = 0;
	let resolveResponse: ((response: Response) => void) | undefined;
	const fetcher: GatewayFetch = () => {
		calls += 1;
		return new Promise((resolve) => {
			resolveResponse = resolve;
		});
	};
	const baseUrl = "https://in-flight.example.com";
	const first = getGatewayModelIds(baseUrl, "key", { fetcher }, 0);
	const second = getGatewayModelIds(baseUrl, "key", { fetcher }, 0);
	equal(calls, 1);
	resolveResponse?.(jsonResponse({ data: [{ id: "gpt-5.4" }] }));
	const results = await Promise.all([first, second]);
	strictEqual(
		results.every((result) => result.ok),
		true,
	);
}

function testPersistedCacheRoundTrip(directory: string): void {
	const cacheFilePath = join(directory, "round-trip.json");
	const source = ["gpt-5.6-luna", "grok-4.20"];
	saveGatewayModelCache(cacheFilePath, source, 100);
	source.push("mutated");

	deepStrictEqual(JSON.parse(readFileSync(cacheFilePath, "utf8")), {
		storedAt: 100,
		ids: ["gpt-5.6-luna", "grok-4.20"],
	});
	const loaded = loadGatewayModelCache(cacheFilePath, 101);
	deepStrictEqual(loaded, {
		ids: ["gpt-5.6-luna", "grok-4.20"],
		fresh: true,
	});
	loaded?.ids.push("also-mutated");
	deepStrictEqual(loadGatewayModelCache(cacheFilePath, 101)?.ids, [
		"gpt-5.6-luna",
		"grok-4.20",
	]);
}

function testInvalidPersistedCache(directory: string): void {
	const cacheFilePath = join(directory, "invalid.json");
	writeFileSync(cacheFilePath, "not-json", "utf8");
	strictEqual(loadGatewayModelCache(cacheFilePath), undefined);
	strictEqual(
		loadGatewayModelCache(join(directory, "missing.json")),
		undefined,
	);
}

function testPersistFailureIsIgnored(directory: string): void {
	const nonDirectory = join(directory, "not-a-directory");
	writeFileSync(nonDirectory, "block nested writes", "utf8");
	const cacheFilePath = join(nonDirectory, "cache.json");
	saveGatewayModelCache(cacheFilePath, ["gpt-5.6-luna"], 100);
	strictEqual(loadGatewayModelCache(cacheFilePath), undefined);
}

function testExpiredPersistedCache(directory: string): void {
	const cacheFilePath = join(directory, "expired.json");
	saveGatewayModelCache(cacheFilePath, ["gpt-5.6-luna"], 100);
	deepStrictEqual(
		loadGatewayModelCache(
			cacheFilePath,
			100 + DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
		),
		{ ids: ["gpt-5.6-luna"], fresh: false },
	);
}

async function testFreshDiskCacheHit(directory: string): Promise<void> {
	const cacheFilePath = join(directory, "fresh-hit.json");
	saveGatewayModelCache(cacheFilePath, ["gpt-5.6-luna"], 100);
	let calls = 0;
	const result = await getGatewayModelIds(
		"https://fresh-disk-cache.example.com",
		"key",
		{
			cacheFilePath,
			fetcher: async () => {
				calls += 1;
				return jsonResponse({ data: [{ id: "unexpected" }] });
			},
		},
		101,
	);

	if (!result.ok) throw new Error("expected persisted cache hit");
	equal(calls, 0);
	equal(result.cached, true);
	equal(result.stale, false);
	deepStrictEqual(result.ids, ["gpt-5.6-luna"]);
}

async function testSuccessfulFetchPersistsDiskCache(
	directory: string,
): Promise<void> {
	const cacheFilePath = join(directory, "fetch-write.json");
	const result = await getGatewayModelIds(
		"https://persist-after-fetch.example.com",
		"key",
		{
			cacheFilePath,
			fetcher: async () =>
				jsonResponse({ data: [{ id: "gpt-5.6-luna" }, { id: "grok-4.20" }] }),
		},
		200,
	);

	if (!result.ok) throw new Error("expected successful refresh");
	deepStrictEqual(loadGatewayModelCache(cacheFilePath, 200), {
		ids: ["gpt-5.6-luna", "grok-4.20"],
		fresh: true,
	});
}

async function testStaleDiskFallback(directory: string): Promise<void> {
	const cacheFilePath = join(directory, "stale-fallback.json");
	saveGatewayModelCache(cacheFilePath, ["grok-4.20"], 0);
	const result = await getGatewayModelIds(
		"https://stale-disk-cache.example.com",
		"key",
		{
			cacheFilePath,
			fetcher: async () => new Response("unavailable", { status: 503 }),
		},
		DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
	);

	if (!result.ok) throw new Error("expected stale persisted fallback");
	equal(result.cached, true);
	equal(result.stale, true);
	equal(result.fallbackReason, "http");
	deepStrictEqual(result.ids, ["grok-4.20"]);
}

const cacheDirectory = mkdtempSync(join(tmpdir(), "pi-tsgw-model-cache-"));
try {
	await testSuccessfulFetch();
	await testFetchFailures();
	testModelCache();
	await testFreshCacheHit();
	await testExpiredCacheRefresh();
	await testStaleFallback();
	await testFailureWithoutCache();
	await testConcurrentRequestDeduplication();
	testPersistedCacheRoundTrip(cacheDirectory);
	testInvalidPersistedCache(cacheDirectory);
	testPersistFailureIsIgnored(cacheDirectory);
	testExpiredPersistedCache(cacheDirectory);
	await testFreshDiskCacheHit(cacheDirectory);
	await testSuccessfulFetchPersistsDiskCache(cacheDirectory);
	await testStaleDiskFallback(cacheDirectory);
} finally {
	rmSync(cacheDirectory, { recursive: true, force: true });
}
console.log("gateway-catalog.test.ts: all assertions passed");
