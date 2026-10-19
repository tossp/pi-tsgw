import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { test } from "node:test";
import { FakePi } from "#tsgw/test-support.test";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "#tsgw/models/gateway-catalog";
import type { CatalogRefreshOutcome } from "./catalog-coordinator.ts";
import { registerRefreshTool } from "./refresh-tool.ts";

const NOW = Date.parse("2026-02-03T04:05:06.000Z");
const SECRET = "secret-sentinel";
const CACHE = "/tmp/tsgw-models-cache.json";
type RefreshCall = {
	registry: unknown;
	force: boolean;
	signal?: AbortSignal;
};
type Tool = { name: string; exposure: string; execute: (...args: any[]) => Promise<any> };

interface FixtureOptions {
	configured?: boolean;
	refresh?: (call: RefreshCall) => CatalogRefreshOutcome | Promise<CatalogRefreshOutcome>;
	contextSignal?: AbortSignal;
}

function fixture(options: FixtureOptions = {}) {
	const calls: RefreshCall[] = [];
	const fallback: CatalogRefreshOutcome = {
		networkSucceeded: true,
		summary: { cacheFilePath: CACHE, count: 2, storedAt: Date.now() },
	};
	const pi = new FakePi();
	const registry = {
		getProviderAuthStatus: () => ({ configured: options.configured ?? true }),
		refresh: async () => { throw new Error("工具不得直接调用 registry.refresh"); },
	};
	registerRefreshTool(pi, {
		async refresh(modelRegistry, force, signal) {
			const call = { registry: modelRegistry, force, signal };
			calls.push(call);
			return options.refresh ? options.refresh(call) : fallback;
		},
	});
	const ctx = { signal: options.contextSignal, modelRegistry: registry };
	return {
		tool: pi.tools[0] as Tool,
		ctx,
		registry,
		fallback,
		calls,
		refreshCalls: () => calls.length,
		lastCall: () => calls.at(-1),
	};
}

function invoke(
	f: ReturnType<typeof fixture>,
	params: Record<string, unknown> = {},
	signal?: AbortSignal,
) {
	return f.tool.execute("call", params, signal, undefined, f.ctx);
}

async function withNow(
	now: number,
	run: (setNow: (value: number) => void) => Promise<void>,
): Promise<void> {
	const original = Date.now;
	let current = now;
	Date.now = () => current;
	try {
		await run(value => { current = value; });
	} finally {
		Date.now = original;
	}
}

test("每次调用只向统一刷新提交一次，force 严格映射，返回形状不变", async () => {
	await withNow(NOW, async () => {
		const f = fixture();
		const cached = await invoke(f);
		equal(f.refreshCalls(), 1);
		equal(f.lastCall()?.force, false);
		equal(f.lastCall()?.registry, f.registry);
		equal(f.lastCall()?.signal, undefined);
		deepStrictEqual(cached.details, {
			cacheFilePath: CACHE, count: 2, storedAt: NOW,
		});
		deepStrictEqual(cached.structuredContent, cached.details);
		equal(cached.content[0].text, JSON.stringify(cached.details));
		equal(JSON.stringify(cached).includes(SECRET), false);

		const forced = await invoke(f, { force: true });
		equal(f.refreshCalls(), 2);
		equal(f.lastCall()?.force, true);
		deepStrictEqual(forced.details, cached.details);

		// 只有严格 true 才触发强制刷新。
		await invoke(f, { force: 1 });
		equal(f.refreshCalls(), 3);
		equal(f.lastCall()?.force, false);
	});
});

test("缺凭据或预取消发生在提交统一刷新之前", async () => {
	const missing = fixture({ configured: false });
	await rejects(invoke(missing), /目录获取失败/);
	equal(missing.refreshCalls(), 0);

	const aborted = new AbortController();
	aborted.abort();
	const byTask = fixture();
	await rejects(invoke(byTask, {}, aborted.signal), /已取消/);
	equal(byTask.refreshCalls(), 0);

	const host = new AbortController();
	host.abort();
	const byHost = fixture({ contextSignal: host.signal });
	await rejects(invoke(byHost), /已取消/);
	equal(byHost.refreshCalls(), 0);
});

test("合并任务与宿主取消信号，只把自己的合并信号交给协调器", async () => {
	const host = new AbortController();
	const byHost = fixture({
		contextSignal: host.signal,
		refresh: call => {
			equal(call.signal?.aborted, false);
			host.abort();
			equal(call.signal?.aborted, true);
			return { networkSucceeded: true, summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW } };
		},
	});
	await rejects(byHost.tool.execute("call", { force: true }, new AbortController().signal,
		undefined, byHost.ctx), (error: Error) => {
		match(error.message, /已取消/);
		return true;
	});
	equal(byHost.refreshCalls(), 1);
	equal(byHost.lastCall()?.signal?.aborted, true);

	const task = new AbortController();
	const byTask = fixture({
		refresh: call => {
			equal(call.signal?.aborted, false);
			return { networkSucceeded: true, summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW } };
		},
	});
	const pending = invoke(byTask, { force: true }, task.signal);
	task.abort();
	await rejects(pending, /已取消/);
	equal(byTask.refreshCalls(), 1);
	equal(byTask.lastCall()?.signal?.aborted, true);
});

test("刷新期间取消不接受成功结果，返回 aborted 也按取消处理", async () => {
	const host = new AbortController();
	const during = fixture({
		contextSignal: host.signal,
		refresh: () => {
			host.abort();
			return { networkSucceeded: true, summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW } };
		},
	});
	await rejects(invoke(during, { force: true }), /已取消/);

	const aborted = fixture({
		refresh: () => ({
			aborted: true,
			networkSucceeded: false,
			summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW },
		}),
	});
	await rejects(invoke(aborted, { force: true }), /已取消/);
});

test("协调器异常与 errors 均安全脱敏且不确认旧文件", async () => {
	const thrown = fixture({
		refresh: async () => { throw new Error(SECRET); },
	});
	await rejects(invoke(thrown, { force: true }), (error: Error) => {
		match(error.message, /目录获取失败/);
		equal(error.message.includes(SECRET), false);
		return true;
	});
	equal(thrown.refreshCalls(), 1);

	const returned = fixture({
		refresh: () => ({
			networkSucceeded: true,
			errors: new Map([[ "tsgw", new Error(SECRET) ]]),
			summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW },
		}),
	});
	await rejects(invoke(returned, { force: true }), (error: Error) => {
		match(error.message, /目录获取失败/);
		equal(error.message.includes(SECRET), false);
		return true;
	});
	equal(returned.refreshCalls(), 1);
});

test("force 仅在 networkSucceeded 为 true 时成功，且必须有 summary", async () => {
	const failed = fixture({
		refresh: () => ({
			networkSucceeded: false,
			summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW },
		}),
	});
	await rejects(invoke(failed, { force: true }), /未完成强制联网刷新/);

	const missingNormal = fixture({ refresh: () => ({ networkSucceeded: true }) });
	await rejects(invoke(missingNormal), /未确认/);
	const missingForce = fixture({ refresh: () => ({ networkSucceeded: true }) });
	await rejects(invoke(missingForce, { force: true }), /未确认/);
});

test("普通请求拒绝超过 24 小时的旧文件，边界内仍成功", async () => {
	await withNow(NOW, async () => {
		const old = fixture({
			refresh: () => ({
				networkSucceeded: true,
				summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW - TTL },
			}),
		});
		await rejects(invoke(old), /未确认/);

		const edge = fixture({
			refresh: () => ({
				networkSucceeded: true,
				summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW - TTL + 1 },
			}),
		});
		const result = await invoke(edge);
		equal(result.details.storedAt, NOW - TTL + 1);
	});
});

test("并发 force 可复用先启动任务：storedAt 早于本次 caller 仍成功", async () => {
	await withNow(NOW, async (setNow) => {
		const shared: CatalogRefreshOutcome = {
			networkSucceeded: true,
			summary: { cacheFilePath: CACHE, count: 2, storedAt: NOW },
		};
		let release!: (outcome: CatalogRefreshOutcome) => void;
		const pending = new Promise<CatalogRefreshOutcome>(resolve => { release = resolve; });
		let calls = 0;
		const f = fixture({
			refresh: () => {
				calls++;
				return calls === 1 ? pending : shared;
			},
		});
		const first = invoke(f, { force: true });
		setNow(NOW + 5_000);
		const second = await invoke(f, { force: true });
		deepStrictEqual(second.details, shared.summary);
		equal(second.details.storedAt < NOW + 5_000, true);
		release(shared);
		const firstResult = await first;
		deepStrictEqual(firstResult.details, shared.summary);
		equal(f.refreshCalls(), 2, "每个调用方只提交一次，复用由协调器内部完成");
	});
});
