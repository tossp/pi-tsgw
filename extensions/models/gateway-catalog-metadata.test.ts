import { deepStrictEqual, equal, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL,
	getGatewayModelIds,
	gatewayModelCacheScope,
	getCachedGatewayModelIds,
	loadGatewayModelCache,
	readGatewayModelCacheSummary,
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

test("缓存摘要与启动加载共用格式校验，保留作用域恢复边界", (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const scope = gatewayModelCacheScope(baseUrl, "key");
	saveGatewayModelCache(cacheFilePath, scope, [" known ", "known", "unknown-model"], 123);
	deepStrictEqual(readGatewayModelCacheSummary(cacheFilePath, 123), {
		cacheFilePath, count: 2, storedAt: 123,
	});
	deepStrictEqual(readGatewayModelCacheSummary(cacheFilePath, 123, scope), {
		cacheFilePath, count: 2, storedAt: 123,
	});
	deepStrictEqual(loadGatewayModelCache(cacheFilePath, scope, 123), {
		ids: ["known", "unknown-model"], fresh: true,
	});
	equal(loadGatewayModelCache(cacheFilePath, "other-scope", 123), undefined);
	equal(readGatewayModelCacheSummary(cacheFilePath, 123, "other-scope"), undefined);
	equal(readGatewayModelCacheSummary(cacheFilePath, 123, ""), undefined);
	equal(readGatewayModelCacheSummary(cacheFilePath, 124), undefined);
	// 摘要不对外暴露 scope，且不能用于绕过启动加载的身份校验。
	equal(JSON.stringify(readGatewayModelCacheSummary(cacheFilePath, 123)).includes(scope), false);
});

test("缓存摘要拒绝缺失、畸形、空列表及无作用域文件", (t) => {
	const { cacheFilePath } = fixture(t);
	equal(readGatewayModelCacheSummary(cacheFilePath, 0), undefined);
	for (const payload of [
		"not-json", "null", "[]",
		JSON.stringify({ storedAt: 123, ids: ["model"] }),
		JSON.stringify({ scope: "", storedAt: 123, ids: ["model"] }),
		JSON.stringify({ scope: "scope", storedAt: "123", ids: ["model"] }),
		JSON.stringify({ scope: "scope", storedAt: -1, ids: ["model"] }),
		JSON.stringify({ scope: "scope", storedAt: 123, ids: [] }),
		JSON.stringify({ scope: "scope", storedAt: 123, ids: [" "] }),
		JSON.stringify({ scope: "scope", storedAt: 123, ids: [1] }),
	]) {
		writeFileSync(cacheFilePath, payload);
		equal(readGatewayModelCacheSummary(cacheFilePath, 0), undefined);
	}
});

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
	deepStrictEqual(loadGatewayModelCache(cacheFilePath, gatewayModelCacheScope(baseUrl, "key"), storedAt), {
		ids: ["network-model"],
		fresh: true,
	});
});

test("本地快照只读内存与磁盘，选择较新条目并标注新鲜度", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	strictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 0),
		undefined,
	);
	await getGatewayModelIds(baseUrl, "key", { cacheFilePath, fetcher: success(["memory-model"]) }, 100);
	deepStrictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 101),
		{ ids: ["memory-model"], storedAt: 100, fresh: true },
	);
	saveGatewayModelCache(
		cacheFilePath,
		gatewayModelCacheScope(baseUrl, "key"),
		["disk-model"],
		200,
	);
	const newer = { ids: ["disk-model"], storedAt: 200 };
	deepStrictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 201),
		{ ...newer, fresh: true },
	);
	deepStrictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 200 + TTL),
		{ ...newer, fresh: false },
	);
	// 配置变化时旧磁盘缓存不参与快照。
	strictEqual(
		getCachedGatewayModelIds(`${baseUrl}/other`, "key", { cacheFilePath }, 201),
		undefined,
	);
	strictEqual(
		getCachedGatewayModelIds(baseUrl, "other-key", { cacheFilePath }, 201),
		undefined,
	);
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
		{ cacheFilePath, fetcher: blocked.fetcher },
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
				{ cacheFilePath, fetcher: success(["memory-model"]) },
				memoryAt,
			);
			rmSync(cacheFilePath);
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
				fallbackStatus: 503,
				storedAt,
			});
		}
		equal(calls, 2);
		if (original !== undefined)
			equal(readFileSync(cacheFilePath, "utf8"), original);
	});
}
