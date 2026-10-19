import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogCoordinator, type CatalogRefreshRunResult } from "./catalog-coordinator.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function fixture() {
	let begins = 0;
	let networkSucceeded = false;
	let count = 0;
	const coordinator = createCatalogCoordinator({
		begin() { begins++; networkSucceeded = false; },
		inspect: () => ({ networkSucceeded,
			summary: { cacheFilePath: "/synthetic/catalog.json", count, storedAt: 100 } }),
	});
	return { coordinator, begins: () => begins,
		complete(value: number) { networkSucceeded = true; count = value; } };
}

async function flush(): Promise<void> {
	for (let index = 0; index < 12; index++) await Promise.resolve();
}

test("首次 provider 回调已取消时不得替换 signal 后启动联网", async () => {
	const f = fixture();
	const host = new AbortController();
	host.abort(new Error("synthetic private reason"));
	let executed = 0;
	const result = await f.coordinator.request("normal", async () => {
		await assert.rejects(f.coordinator.provider({ allowNetwork: true, signal: host.signal }, async () => {
			executed++;
			return [];
		}), { name: "AbortError" });
		return {};
	});
	assert.equal(executed, 0);
	assert.equal(result.aborted, true);
	assert.equal(result.networkSucceeded, false);
	assert.equal(result.summary, undefined);
});

test("force 与普通调用合流；每个结果保存本任务快照", async () => {
	const f = fixture();
	const hold = deferred<CatalogRefreshRunResult>();
	const first = f.coordinator.request("force", () => hold.promise);
	const second = f.coordinator.request("force", async () => { throw new Error("不应执行"); });
	const normal = f.coordinator.request("normal", async () => { throw new Error("不应执行"); });
	assert.equal(f.begins(), 1);
	f.complete(2);
	hold.resolve({});
	const results = await Promise.all([first, second, normal]);
	assert.equal(results[0].networkSucceeded, true);
	assert.equal(results[0].summary?.count, 2);
	assert.deepEqual(results, [results[0], results[0], results[0]]);
	await f.coordinator.request("force", async () => { f.complete(3); });
	assert.equal(results[0].summary?.count, 2, "后续任务不能污染已交付的结果");
});

test("normal 最终真实联网时吸收排队 force，不重复请求或取消已有任务", async () => {
	const f = fixture();
	const hold = deferred<CatalogRefreshRunResult>();
	let runningSignal!: AbortSignal;
	let forced = false;
	const normal = f.coordinator.request("normal", signal => { runningSignal = signal; return hold.promise; });
	const force = f.coordinator.request("force", async () => { forced = true; f.complete(2); });
	assert.equal(forced, false);
	assert.equal(runningSignal.aborted, false);
	f.complete(1);
	hold.resolve({});
	const [a, b] = await Promise.all([normal, force]);
	assert.equal(a.summary?.count, 1);
	assert.equal(b.summary?.count, 1);
	assert.equal(f.begins(), 1);
	assert.equal(forced, false, "普通任务已经联网成功，不能再执行排队的 force 闭包");
	assert.equal(runningSignal.aborted, false);
});

test("排队 normal 升级为 force 时替换执行闭包，restore 仍只读本地", async () => {
	const f = fixture();
	const hold = deferred<CatalogRefreshRunResult>();
	const calls: string[] = [];
	const restore = f.coordinator.request("restore", () => { calls.push("restore"); return hold.promise; });
	const normal = f.coordinator.request("normal", async () => { calls.push("normal"); });
	const force = f.coordinator.request("force", async () => { calls.push("force"); f.complete(2); });
	assert.deepEqual(calls, ["restore"]);
	hold.resolve({});
	const [local, a, b] = await Promise.all([restore, normal, force]);
	assert.equal(local.networkSucceeded, false);
	assert.deepEqual(calls, ["restore", "force"]);
	assert.deepEqual(a, b);
	assert.equal(a.networkSucceeded, true);
});

test("restore 不借用联网任务；同类 restore 合并", async () => {
	const f = fixture();
	const hold = deferred<CatalogRefreshRunResult>();
	let restores = 0;
	const force = f.coordinator.request("force", () => hold.promise);
	const a = f.coordinator.request("restore", async () => { restores++; });
	const b = f.coordinator.request("restore", async () => { throw new Error("不应执行"); });
	f.complete(2);
	hold.resolve({});
	const results = await Promise.all([force, a, b]);
	assert.equal(restores, 1);
	assert.equal(results[0].networkSucceeded, true);
	assert.equal(results[1].networkSucceeded, false);
	assert.deepEqual(results[1], results[2]);
});

test("等待者独立取消；最后一个取消才中止共享任务", async () => {
	const f = fixture();
	const hold = deferred<CatalogRefreshRunResult>();
	const a = new AbortController();
	const b = new AbortController();
	let shared!: AbortSignal;
	const first = f.coordinator.request("force", signal => { shared = signal; return hold.promise; }, a.signal);
	const second = f.coordinator.request("force", async () => {}, b.signal);
	const firstRejected = assert.rejects(first, /已取消/);
	a.abort();
	await firstRejected;
	assert.equal(shared.aborted, false);
	const secondRejected = assert.rejects(second, /已取消/);
	b.abort();
	await secondRejected;
	assert.equal(shared.aborted, true);
	await f.coordinator.request("normal", async () => { f.complete(5); });
	hold.reject(new Error("迟到的合成错误"));
	await flush();
	assert.equal(f.begins(), 2, "不响应取消的旧任务也不能卡住队列");
});

test("预取消和排队取消不执行，stop 取消全部任务且允许新会话继续", async () => {
	const f = fixture();
	const before = new AbortController();
	before.abort();
	await assert.rejects(f.coordinator.request("force", async () => {}, before.signal), /已取消/);
	assert.equal(f.begins(), 0);
	const hold = deferred<CatalogRefreshRunResult>();
	const running = f.coordinator.request("normal", () => hold.promise);
	const queuedSignal = new AbortController();
	const queued = f.coordinator.request("force", async () => { throw new Error("不应执行"); }, queuedSignal.signal);
	const queuedRejected = assert.rejects(queued, /已取消/);
	queuedSignal.abort();
	await queuedRejected;
	const pending = f.coordinator.request("restore", async () => {});
	const rejected = [assert.rejects(running, /已取消/), assert.rejects(pending, /已取消/)];
	f.coordinator.stop();
	await Promise.all(rejected);
	const next = await f.coordinator.request("force", async () => { f.complete(7); });
	hold.resolve({});
	await flush();
	assert.equal(next.summary?.count, 7);
	assert.equal(f.begins(), 2);
});

test("provider 为直接执行端不递归排队；识别宿主误报未取消", async () => {
	const f = fixture();
	const host = new AbortController();
	let callbacks = 0;
	const result = await f.coordinator.request("force", async () => {
		await f.coordinator.provider({ allowNetwork: false, signal: host.signal }, async () => { callbacks++; return []; });
		await f.coordinator.provider({ allowNetwork: true, signal: host.signal }, async () => {
			callbacks++;
			host.abort();
			return [];
		});
		f.complete(2);
		return { aborted: false, errors: new Map() };
	});
	assert.equal(callbacks, 2);
	assert.equal(result.aborted, true);
	assert.equal(result.networkSucceeded, false);
	assert.equal(result.summary, undefined);
});

test("旧宿主不提供 signal 也可整体取消 provider；外部接管不继承旧任务取消", async () => {
	const f = fixture();
	const hold = deferred<CatalogRefreshRunResult>();
	let effective!: AbortSignal;
	const first = f.coordinator.request("force", async () => {
		await f.coordinator.provider({ allowNetwork: false }, async context => {
			effective = context.signal!;
			return [];
		});
		return hold.promise;
	});
	await flush();
	const rejected = assert.rejects(first, /已取消/);
	f.coordinator.stop();
	await rejected;
	assert.equal(effective.aborted, true);

	const own = new AbortController();
	const external = new AbortController();
	let inherited!: AbortSignal;
	const task = f.coordinator.request("force", async () => {
		await f.coordinator.provider({ allowNetwork: false, signal: own.signal }, async () => []);
		own.abort();
		await f.coordinator.provider({ allowNetwork: true, signal: external.signal }, async context => {
			inherited = context.signal!;
			return [];
		});
		return hold.promise;
	});
	await flush();
	const taskRejected = assert.rejects(task, /已取消/);
	f.coordinator.stop();
	await taskRejected;
	assert.equal(inherited, external.signal);
	assert.equal(inherited.aborted, false, "不得连带取消已接管的外部刷新");
	hold.resolve({});
});

test("已识别首回调后，不同宿主 signal 不继承强制意图或互相取消", async () => {
	for (const cancelExternal of [false, true]) {
		const f = fixture();
		const own = new AbortController();
		const external = new AbortController();
		const caller = new AbortController();
		const gate = deferred<CatalogRefreshRunResult>();
		const started = deferred<void>();
		let effective: AbortSignal | undefined;
		let forced: boolean | undefined;
		const task = f.coordinator.request("force", async () => {
			await f.coordinator.provider({ allowNetwork: true, signal: own.signal }, async () => []);
			await f.coordinator.provider({ allowNetwork: true, force: false, signal: external.signal }, async context => {
				effective = context.signal;
				forced = context.force;
				return [];
			});
			started.resolve();
			return gate.promise;
		}, caller.signal);
		await started.promise;
		assert.equal(effective, external.signal);
		assert.equal(forced, false, "外部普通获取不继承当前 job 的 force");
		if (cancelExternal) {
			external.abort();
			f.complete(2);
			gate.resolve({});
			const result = await task;
			assert.notEqual(result.aborted, true, "外部取消不污染已识别的本任务");
			assert.equal(result.networkSucceeded, true);
		} else {
			const rejected = assert.rejects(task, /已取消/);
			caller.abort();
			await rejected;
			assert.equal(effective?.aborted, false, "最后 waiter 取消也不误伤外部回调");
			gate.resolve({});
		}
	}
});

test("待处理 force 在普通请求缓存决策前提升同一回调；网络失败也只交付一轮结果", async () => {
	for (const fails of [false, true]) {
		const gate = deferred<void>();
		let attempted = false;
		let forced = false;
		let begins = 0;
		const coordinator = createCatalogCoordinator({
			begin() { begins++; },
			inspect: () => ({ networkAttempted: attempted, networkSucceeded: attempted && !fails }),
		});
		const first = coordinator.request("normal", async () => {
			await gate.promise;
			await coordinator.provider({ allowNetwork: true, force: false }, async context => {
				forced = context.force === true;
				attempted = true;
				return [];
			});
			return { errors: fails ? new Map([["tsgw", new Error("合成网络失败")]]) : new Map<string, Error>() };
		});
		const second = coordinator.request("force", async () => { throw new Error("不应第二轮执行"); });
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);
		assert.equal(forced, true);
		assert.equal(begins, 1);
		assert.deepEqual(a, b);
		assert.equal(a.networkSucceeded, !fails);
		assert.equal(a.errors?.has("tsgw"), fails);
	}
});

test("普通任务已命中缓存时，force 才需要启动后续联网任务", async () => {
	const f = fixture();
	const gate = deferred<CatalogRefreshRunResult>();
	const a = f.coordinator.request("normal", () => gate.promise);
	const b = f.coordinator.request("force", async () => { f.complete(5); });
	gate.resolve({});
	const [cached, network] = await Promise.all([a, b]);
	assert.equal(cached.networkSucceeded, false);
	assert.equal(network.networkSucceeded, true);
	assert.equal(network.summary?.count, 5);
	assert.equal(f.begins(), 2);
});

test("抛错与失败结果不交付成功摘要，也不阻塞下一任务", async () => {
	const f = fixture();
	await assert.rejects(f.coordinator.request("force", async () => { throw new Error("合成失败"); }), /合成失败/);
	const failed = await f.coordinator.request("force", async () => {
		f.complete(2);
		return { errors: new Map([["tsgw", new Error("合成失败")]]) };
	});
	assert.equal(failed.networkSucceeded, false);
	assert.equal(failed.summary, undefined);
	assert.equal(failed.errors?.has("tsgw"), true);
	assert.equal(f.begins(), 2);
});
