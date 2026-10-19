import { deepStrictEqual, equal } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as RUNNING_TTL,
	DEFAULT_GATEWAY_MODEL_TIMEOUT_MS,
	getCachedGatewayModelIds,
	getGatewayModelIds,
	gatewayModelCacheScope,
	loadGatewayModelCache,
	saveGatewayModelCache,
	type GatewayFetch,
} from "./gateway-catalog.ts";

function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "gateway-policy-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return {
		baseUrl: `https://${randomUUID()}.invalid`,
		cacheFilePath: join(directory, "models.json"),
	};
}
function response(id = "network-model"): Response {
	return new Response(JSON.stringify({ data: [{ id }] }));
}

async function seedMemory(baseUrl: string, storedAt: number, id = "cached-model") {
	return getGatewayModelIds(baseUrl, "key", {
		fetcher: async () => response(id),
	}, storedAt);
}

test("默认缓存为 24 小时，模型请求默认超时为 5 秒", () => {
	equal(RUNNING_TTL, 24 * 60 * 60 * 1_000);
	equal(DEFAULT_GATEWAY_MODEL_TIMEOUT_MS, 5_000);
});

for (const source of ["内存", "磁盘"] as const) {
	test(`${source}缓存的 TTL 边界严格小于 TTL，且调用 TTL 不改写存储时间`, async (t) => {
		const { baseUrl, cacheFilePath } = fixture(t);
		const storedAt = 10_000;
		const scope = gatewayModelCacheScope(baseUrl, "key");
		if (source === "内存") await seedMemory(baseUrl, storedAt, "memory-model");
		else saveGatewayModelCache(cacheFilePath, scope, ["disk-model"], storedAt);
		const original = source === "磁盘" ? readFileSync(cacheFilePath, "utf8") : undefined;
		let calls = 0;
		const blocked: GatewayFetch = async () => {
			calls++;
			return response("refreshed-model");
		};
		const options = source === "磁盘" ? { cacheFilePath, fetcher: blocked } : { fetcher: blocked };
		const within = await getGatewayModelIds(baseUrl, "key", {
			...options, ttlMs: 100,
		}, storedAt + 99);
		deepStrictEqual(within.ok && {
			ids: within.ids, cached: within.cached, stale: within.stale, storedAt: within.storedAt,
		}, {
			ids: [source === "内存" ? "memory-model" : "disk-model"],
			cached: true, stale: false, storedAt,
		});
		equal(calls, 0);
		if (original !== undefined) equal(readFileSync(cacheFilePath, "utf8"), original);
		const atBoundary = await getGatewayModelIds(baseUrl, "key", {
			...options, ttlMs: 100,
		}, storedAt + 100);
		deepStrictEqual(atBoundary.ok && { ids: atBoundary.ids, cached: atBoundary.cached }, {
			ids: ["refreshed-model"], cached: false,
		});
		equal(calls, 1);
	});
}

test("force 忽略任意 TTL 的新鲜内存及磁盘缓存，且不自动重试", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	await seedMemory(baseUrl, 100, "memory-model");
	// 使用另一作用域的 URL，避免内存缓存遮蔽磁盘路径验证。
	const diskUrl = `${baseUrl}/disk`;
	const diskScope = gatewayModelCacheScope(diskUrl, "key");
	saveGatewayModelCache(cacheFilePath, diskScope, ["disk-model"], 100);
	let calls = 0;
	const fetcher: GatewayFetch = async () => { calls++; return response("forced"); };
	for (const url of [baseUrl, diskUrl]) {
		const result = await getGatewayModelIds(url, "key", {
			cacheFilePath, force: true, ttlMs: RUNNING_TTL, fetcher,
		}, 101);
		deepStrictEqual(result.ok && { ids: result.ids, cached: result.cached }, {
			ids: ["forced"], cached: false,
		});
	}
	equal(calls, 2);
	// 第二次写入必须使用其自身的身份作用域。
	deepStrictEqual(loadGatewayModelCache(cacheFilePath, diskScope, 101)?.ids, ["forced"]);
});

test("较新磁盘缓存覆盖新鲜内存，本地快照同样选择最新条目", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const scope = gatewayModelCacheScope(baseUrl, "key");
	await seedMemory(baseUrl, 100, "memory-model");
	saveGatewayModelCache(cacheFilePath, scope, ["disk-model"], 200);
	let calls = 0;
	const fetcher: GatewayFetch = async () => { calls++; return response("network-model"); };
	const result = await getGatewayModelIds(baseUrl, "key", { cacheFilePath, fetcher }, 201);
	deepStrictEqual(result, {
		ok: true, ids: ["disk-model"], cached: true, stale: false, storedAt: 200,
	});
	equal(calls, 0);
	deepStrictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 201),
		{ ids: ["disk-model"], storedAt: 200, fresh: true },
	);
	deepStrictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 200 + RUNNING_TTL),
		{ ids: ["disk-model"], storedAt: 200, fresh: false },
	);
	const fallback = await getGatewayModelIds(baseUrl, "key", {
		cacheFilePath, ttlMs: 10,
		fetcher: async () => new Response(null, { status: 503 }),
	}, 211);
	deepStrictEqual(fallback, {
		ok: true, ids: ["disk-model"], cached: true, stale: true,
		fallbackReason: "http", fallbackStatus: 503, storedAt: 200,
	});
});

test("仅获取缓存时选中较新磁盘会预热共享内存，磁盘损坏或删除不回退旧内存", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const scope = gatewayModelCacheScope(baseUrl, "key");
	await seedMemory(baseUrl, 100, "memory-model");
	saveGatewayModelCache(cacheFilePath, scope, ["disk-model"], 200);
	const original = readFileSync(cacheFilePath, "utf8");

	// 模拟初始化：只读取缓存，选中较新的磁盘快照并同步到共享内存。
	deepStrictEqual(
		getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, 201),
		{ ids: ["disk-model"], storedAt: 200, fresh: true },
	);
	equal(readFileSync(cacheFilePath, "utf8"), original);

	let calls = 0;
	const blocked: GatewayFetch = async () => {
		calls++;
		return response("network-model");
	};
	const assertNewSnapshotSurvives = async (now: number) => {
		deepStrictEqual(
			getCachedGatewayModelIds(baseUrl, "key", { cacheFilePath }, now),
			{ ids: ["disk-model"], storedAt: 200, fresh: true },
		);
		deepStrictEqual(
			await getGatewayModelIds(baseUrl, "key", {
				cacheFilePath, fetcher: blocked,
			}, now),
			{ ok: true, ids: ["disk-model"], cached: true, stale: false, storedAt: 200 },
		);
		equal(calls, 0);
	};

	writeFileSync(cacheFilePath, "{broken", "utf8");
	await assertNewSnapshotSurvives(202);

	rmSync(cacheFilePath, { force: true });
	await assertNewSnapshotSurvives(203);
});

test("失败的过期旧缓存回退不变更 storedAt 且不重试", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const scope = gatewayModelCacheScope(baseUrl, "key");
	const storedAt = 100;
	saveGatewayModelCache(cacheFilePath, scope, ["expired-model"], storedAt);
	const original = readFileSync(cacheFilePath, "utf8");
	let calls = 0;
	const result = await getGatewayModelIds(baseUrl, "key", {
		cacheFilePath, ttlMs: 10,
		fetcher: async () => { calls++; return new Response(null, { status: 503 }); },
	}, 110);
	deepStrictEqual(result, {
		ok: true, ids: ["expired-model"], cached: true, stale: true,
		fallbackReason: "http", fallbackStatus: 503, storedAt,
	});
	equal(calls, 1);
	equal(readFileSync(cacheFilePath, "utf8"), original);
});

for (const status of [401, 403] as const) {
	test(`HTTP ${status} 回退携带 fallbackStatus，供上层识别且不重试`, async (t) => {
		const { baseUrl, cacheFilePath } = fixture(t);
		saveGatewayModelCache(
			cacheFilePath,
			gatewayModelCacheScope(baseUrl, "key"),
			["cached-model"],
			0,
		);
		let calls = 0;
		const result = await getGatewayModelIds(baseUrl, "key", {
			cacheFilePath, force: true,
			fetcher: async () => { calls++; return new Response(null, { status }); },
		}, 2);
		deepStrictEqual(result, {
			ok: true, ids: ["cached-model"], cached: true, stale: true,
			fallbackReason: "http", fallbackStatus: status, storedAt: 0,
		});
		equal(calls, 1);
	});
}

for (const change of ["baseUrl", "key"] as const) {
	test(`配置${change === "baseUrl" ? "根地址" : "凭据"}变化不取旧缓存且不重试`, async (t) => {
		const { baseUrl, cacheFilePath } = fixture(t);
		const oldUrl = change === "baseUrl" ? `${baseUrl}/old` : baseUrl;
		const oldKey = change === "key" ? "old-key" : "key";
		const newKey = change === "key" ? "new-key" : "key";
		saveGatewayModelCache(
			cacheFilePath,
			gatewayModelCacheScope(oldUrl, oldKey),
			["private-model"],
			0,
		);
		let calls = 0;
		const result = await getGatewayModelIds(baseUrl, newKey, {
			cacheFilePath,
			fetcher: async () => { calls++; return new Response(null, { status: 503 }); },
		}, 1);
		deepStrictEqual(result, { ok: false, reason: "http", status: 503 });
		equal(calls, 1);
		equal(loadGatewayModelCache(cacheFilePath, gatewayModelCacheScope(baseUrl, newKey)), undefined);
	});
}

test("普通请求、force 请求和取消均不自动重试", async (t) => {
	const { baseUrl } = fixture(t);
	for (const force of [false, true]) {
		let calls = 0;
		const result = await getGatewayModelIds(`${baseUrl}/${force ? "force" : "normal"}`, "key", {
			force,
			fetcher: async () => { calls++; return new Response(null, { status: 503 }); },
		}, 1);
		deepStrictEqual(result, { ok: false, reason: "http", status: 503 });
		equal(calls, 1);
	}
	const controller = new AbortController();
	let calls = 0;
	const cancelled = await getGatewayModelIds(`${baseUrl}/cancel`, "key", {
		signal: controller.signal,
		fetcher: async (_input, init) => {
			calls++;
			controller.abort();
			return init?.signal?.aborted ? new Response(null, { status: 503 }) : response();
		},
	}, 2);
	deepStrictEqual(cancelled, { ok: false, reason: "aborted" });
	equal(calls, 1);
});
