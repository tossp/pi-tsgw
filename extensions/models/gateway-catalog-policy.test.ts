import { deepStrictEqual, equal } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as RUNNING_TTL,
	DEFAULT_GATEWAY_MODEL_TIMEOUT_MS,
	STARTUP_GATEWAY_MODEL_CACHE_TTL_MS as STARTUP_TTL,
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

test("默认运行缓存为 24 小时、启动窗口为 7 天，模型请求默认超时为 5 秒", () => {
	equal(RUNNING_TTL, 24 * 60 * 60 * 1_000);
	equal(STARTUP_TTL, 7 * RUNNING_TTL);
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

for (const source of ["内存", "磁盘"] as const) {
	test(`同一${source}缓存可在 7 天启动窗口命中、24 小时运行窗口过期`, async (t) => {
		const { baseUrl, cacheFilePath } = fixture(t);
		const storedAt = 50;
		if (source === "内存") await seedMemory(baseUrl, storedAt);
		else saveGatewayModelCache(cacheFilePath, gatewayModelCacheScope(baseUrl, "key"), ["cached-model"], storedAt);
		let calls = 0;
		const fetcher: GatewayFetch = async () => { calls++; return response("new-model"); };
		const options = source === "磁盘" ? { cacheFilePath, fetcher } : { fetcher };
		const startup = await getGatewayModelIds(baseUrl, "key", {
			...options, ttlMs: STARTUP_TTL,
		}, storedAt + RUNNING_TTL);
		deepStrictEqual(startup.ok && { ids: startup.ids, cached: startup.cached, storedAt: startup.storedAt }, {
			ids: ["cached-model"], cached: true, storedAt,
		});
		const running = await getGatewayModelIds(baseUrl, "key", {
			...options, ttlMs: RUNNING_TTL,
		}, storedAt + RUNNING_TTL);
		deepStrictEqual(running.ok && { ids: running.ids, cached: running.cached }, {
			ids: ["new-model"], cached: false,
		});
		equal(calls, 1);
	});
}

test("force 忽略任意 TTL 的新鲜内存及磁盘缓存", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const scope = gatewayModelCacheScope(baseUrl, "key");
	await seedMemory(baseUrl, 100, "memory-model");
	// 使用另一作用域的 URL，避免内存缓存遮蔽磁盘路径验证。
	const diskUrl = `${baseUrl}/disk`;
	const diskScope = gatewayModelCacheScope(diskUrl, "key");
	saveGatewayModelCache(cacheFilePath, diskScope, ["disk-model"], 100);
	let calls = 0;
	const fetcher: GatewayFetch = async () => { calls++; return response("forced"); };
	for (const url of [baseUrl, diskUrl]) {
		const result = await getGatewayModelIds(url, "key", {
			cacheFilePath, force: true, ttlMs: STARTUP_TTL, retryWithoutCache: true, fetcher,
		}, 101);
		deepStrictEqual(result.ok && { ids: result.ids, cached: result.cached }, {
			ids: ["forced"], cached: false,
		});
	}
	equal(calls, 2);
	// 第二次写入必须使用其自身的身份作用域。
	deepStrictEqual(loadGatewayModelCache(cacheFilePath, diskScope, 101)?.ids, ["forced"]);
	equal(scope.length, 64);
});

for (const secondAttempt of ["success", "failure"] as const) {
	test(`无缓存 retryWithoutCache 最多两次，第二次${secondAttempt === "success" ? "成功" : "失败"}`, async (t) => {
		const { baseUrl, cacheFilePath } = fixture(t);
		let calls = 0;
		const fetcher: GatewayFetch = async () => {
			calls++;
			if (calls === 1 || secondAttempt === "failure") return new Response(null, { status: 503 });
			return response("retried-model");
		};
		const result = await getGatewayModelIds(baseUrl, "key", {
			cacheFilePath, fetcher, retryWithoutCache: true,
		}, 1);
		equal(calls, 2);
		if (secondAttempt === "success") {
			deepStrictEqual(result.ok && { ids: result.ids, cached: result.cached }, {
				ids: ["retried-model"], cached: false,
			});
		} else deepStrictEqual(result, { ok: false, reason: "http", status: 503 });
	});
}

test("失败的过期旧缓存不触发 retry，回退不变更 storedAt", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	const scope = gatewayModelCacheScope(baseUrl, "key");
	const storedAt = 100;
	saveGatewayModelCache(cacheFilePath, scope, ["expired-model"], storedAt);
	const original = readFileSync(cacheFilePath, "utf8");
	let calls = 0;
	const result = await getGatewayModelIds(baseUrl, "key", {
		cacheFilePath, ttlMs: 10, retryWithoutCache: true,
		fetcher: async () => { calls++; return new Response(null, { status: 503 }); },
	}, 110);
	deepStrictEqual(result, {
		ok: true, ids: ["expired-model"], cached: true, stale: true,
		fallbackReason: "http", storedAt,
	});
	equal(calls, 1);
	equal(readFileSync(cacheFilePath, "utf8"), original);
});

test("磁盘作用域不匹配视为无缓存并允许 retryWithoutCache", async (t) => {
	const { baseUrl, cacheFilePath } = fixture(t);
	saveGatewayModelCache(cacheFilePath, gatewayModelCacheScope(baseUrl, "other-key"), ["private-model"], 0);
	let calls = 0;
	const result = await getGatewayModelIds(baseUrl, "key", {
		cacheFilePath, retryWithoutCache: true,
		fetcher: async () => { calls++; return calls === 1 ? new Response(null, { status: 503 }) : response("right-scope"); },
	}, 1);
	deepStrictEqual(result.ok && { ids: result.ids, cached: result.cached }, {
		ids: ["right-scope"], cached: false,
	});
	equal(calls, 2);
});

test("普通请求、force 请求和取消均不自动重试", async (t) => {
	const { baseUrl } = fixture(t);
	for (const force of [false, true]) {
		let calls = 0;
		const result = await getGatewayModelIds(`${baseUrl}/${force ? "force" : "normal"}`, "key", {
			force, retryWithoutCache: false,
			fetcher: async () => { calls++; return new Response(null, { status: 503 }); },
		}, 1);
		deepStrictEqual(result, { ok: false, reason: "http", status: 503 });
		equal(calls, 1);
	}
	const controller = new AbortController();
	let calls = 0;
	const cancelled = await getGatewayModelIds(`${baseUrl}/cancel`, "key", {
		retryWithoutCache: true, signal: controller.signal,
		fetcher: async (_input, init) => {
			calls++;
			controller.abort();
			return init?.signal?.aborted ? new Response(null, { status: 503 }) : response();
		},
	}, 2);
	deepStrictEqual(cancelled, { ok: false, reason: "aborted" });
	equal(calls, 1);
});
