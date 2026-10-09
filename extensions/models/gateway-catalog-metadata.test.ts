import { deepStrictEqual, equal } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL,
	getGatewayModelIds,
	gatewayModelCacheScope,
	saveGatewayModelCache,
	type GatewayFetch,
} from "./gateway-catalog.ts";

function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "gateway-catalog-metadata-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return {
		baseUrl: `https://${randomUUID()}.invalid`,
		cacheFilePath: join(directory, "models.json"),
	};
}

function success(ids: string[]): GatewayFetch {
	return async () =>
		new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
			headers: { "content-type": "application/json" },
		});
}

// Every request injects a fetcher; no test can reach the real network.
function cacheOnly() {
	let calls = 0;
	const fetcher: GatewayFetch = async () => {
		calls += 1;
		throw new Error("unexpected fetch on cache hit");
	};
	return { fetcher, calls: () => calls };
}

test("network success returns exactly the timestamp persisted to disk", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const storedAt = 0;
	const result = await getGatewayModelIds(
		baseUrl,
		"key",
		{ cacheFilePath, fetcher: success(["network-model"]) },
		storedAt,
	);
	deepStrictEqual(result, {
		ok: true,
		ids: ["network-model"],
		cached: false,
		stale: false,
		storedAt,
	});
	deepStrictEqual(JSON.parse(readFileSync(cacheFilePath, "utf8")), {
		scope: gatewayModelCacheScope(baseUrl, "key"),
		ids: ["network-model"],
		storedAt,
	});
});

test("memory hit keeps the network storage time rather than the lookup time", async (t) => {
	const { baseUrl } = fixture(t);
	const storedAt = 123;
	await getGatewayModelIds(
		baseUrl,
		"key",
		{ fetcher: success(["memory-model"]) },
		storedAt,
	);
	const blocked = cacheOnly();
	const result = await getGatewayModelIds(
		`${baseUrl}/`,
		"key",
		{ fetcher: blocked.fetcher },
		storedAt + TTL - 1,
	);
	deepStrictEqual(result, {
		ok: true,
		ids: ["memory-model"],
		cached: true,
		stale: false,
		storedAt,
	});
	equal(blocked.calls(), 0);
});

test("disk hit and subsequent memory hit both keep the disk storage time", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const storedAt = 456;
	saveGatewayModelCache(cacheFilePath, gatewayModelCacheScope(baseUrl, "key"), ["disk-model"], storedAt);
	const original = readFileSync(cacheFilePath, "utf8");
	const blocked = cacheOnly();
	const disk = await getGatewayModelIds(
		baseUrl,
		"key",
		{ cacheFilePath, fetcher: blocked.fetcher },
		storedAt + 10,
	);
	deepStrictEqual(disk, {
		ok: true,
		ids: ["disk-model"],
		cached: true,
		stale: false,
		storedAt,
	});
	const memory = await getGatewayModelIds(
		baseUrl,
		"key",
		{ fetcher: blocked.fetcher },
		storedAt + TTL - 1,
	);
	deepStrictEqual(memory, disk);
	equal(blocked.calls(), 0);
	equal(readFileSync(cacheFilePath, "utf8"), original);
});

for (const scenario of [
	{ name: "memory only", memoryAt: 100, diskAt: undefined },
	{ name: "disk only", memoryAt: undefined, diskAt: 200 },
	{ name: "newer memory", memoryAt: 300, diskAt: 200 },
	{ name: "newer disk", memoryAt: 100, diskAt: 200 },
]) {
	test(`expired fallback preserves the original time: ${scenario.name}`, async (t) => {
		const { baseUrl, cacheFilePath } = fixture(t);
		const { memoryAt, diskAt } = scenario;
		if (memoryAt !== undefined) {
			await getGatewayModelIds(
				baseUrl,
				"key",
				{ fetcher: success(["memory-model"]) },
				memoryAt,
			);
		}
		if (diskAt !== undefined)
			saveGatewayModelCache(cacheFilePath, gatewayModelCacheScope(baseUrl, "key"), ["disk-model"], diskAt);
		const original = diskAt === undefined
			? undefined
			: readFileSync(cacheFilePath, "utf8");
		const useMemory = memoryAt !== undefined &&
			(diskAt === undefined || memoryAt >= diskAt);
		const storedAt = useMemory ? memoryAt! : diskAt!;
		let calls = 0;
		const fetcher: GatewayFetch = async () => {
			calls += 1;
			return new Response("unavailable", { status: 503 });
		};
		// Repeated failures must not refresh either cache's storage time or TTL.
		for (const now of [storedAt + TTL, storedAt + TTL + 1]) {
			const result = await getGatewayModelIds(
				baseUrl,
				"key",
				{ cacheFilePath, fetcher },
				now,
			);
			deepStrictEqual(result, {
				ok: true,
				ids: [useMemory ? "memory-model" : "disk-model"],
				cached: true,
				stale: true,
				fallbackReason: "http",
				storedAt,
			});
		}
		equal(calls, 2);
		if (original !== undefined)
			equal(readFileSync(cacheFilePath, "utf8"), original);
	});
}
