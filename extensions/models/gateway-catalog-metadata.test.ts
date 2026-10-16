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

// 每个请求均注入 fetcher；所有测试均无法访问真实网络。
function cacheOnly() {
	let calls = 0;
	const fetcher: GatewayFetch = async () => {
		calls += 1;
		throw new Error("缓存命中时意外发起请求");
	};
	return { fetcher, calls: () => calls };
}

test("网络请求成功时返回的时间戳与持久化到磁盘的完全一致", async (t) => {
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

test("内存命中保留网络存储时间，而非查询时间", async (t) => {
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

test("磁盘命中与随后的内存命中均保留磁盘存储时间", async (t) => {
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
	{ name: "仅内存", memoryAt: 100, diskAt: undefined },
	{ name: "仅磁盘", memoryAt: undefined, diskAt: 200 },
	{ name: "内存更新", memoryAt: 300, diskAt: 200 },
	{ name: "磁盘更新", memoryAt: 100, diskAt: 200 },
]) {
	test(`过期回退保留原始时间：${scenario.name}`, async (t) => {
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
		// 连续失败不得刷新任一缓存的存储时间或 TTL。
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
