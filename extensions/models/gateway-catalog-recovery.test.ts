import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
	CATALOG_RECOVERY_DELAY_MS,
	CATALOG_RECOVERY_WINDOW_MS,
	createGatewayCatalogRecovery,
} from "./gateway-catalog-recovery.ts";
import type { GatewayCatalogOutcome } from "./gateway-catalog-service.ts";

async function flush(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fakeTimers(t: TestContext): void {
	t.mock.timers.enable({ apis: ["setTimeout"] });
}

function success(ids = ["model-a"]): GatewayCatalogOutcome {
	return {
		snapshot: { ids, storedAt: 1, source: "network" },
		networkAttempted: true,
		networkSucceeded: true,
		retryable: true,
		failed: false,
	};
}

function failed(retryable = true): GatewayCatalogOutcome {
	return {
		networkAttempted: true,
		networkSucceeded: false,
		retryable,
		failed: true,
	};
}

function fallback(): GatewayCatalogOutcome {
	return {
		networkAttempted: false,
		networkSucceeded: false,
		retryable: true,
		failed: true,
	};
}

function neverUntilAborted(signal: AbortSignal): Promise<GatewayCatalogOutcome> {
	return new Promise((_resolve, reject) => {
		const abort = (): void => {
			const error = new Error("request aborted");
			error.name = "AbortError";
			reject(error);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

test("两个 join 共享同一请求重试序列，并分别取得防御复制的快照", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	const source = success(["model-a"]);
	let calls = 0;
	let requestSignal!: AbortSignal;
	const request = (signal: AbortSignal): Promise<GatewayCatalogOutcome> => {
		requestSignal = signal;
		calls++;
		return Promise.resolve(calls < 3 ? failed() : source);
	};
	const first = recovery.join(request, fallback);
	const second = recovery.join(request, fallback);
	await flush();
	assert.equal(calls, 1, "同时加入只启动一条请求序列");
	assert.equal(requestSignal.aborted, false);

	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS - 1);
	await flush();
	assert.equal(calls, 1, "重试间隔未满时不应重试");
	t.mock.timers.tick(1);
	await flush();
	assert.equal(calls, 2);
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
	await flush();
	assert.equal(calls, 3, "第二次失败后仍应按 5 秒间隔重试");

	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.failed, false);
	assert.equal(b.failed, false);
	assert.notStrictEqual(a.snapshot, b.snapshot);
	assert.notStrictEqual(a.snapshot?.ids, b.snapshot?.ids);
	a.snapshot!.ids.push("mutated-by-a");
	a.snapshot!.storedAt = 99;
	assert.deepEqual(b.snapshot, { ids: ["model-a"], storedAt: 1, source: "network" });
	assert.deepEqual(source, {
		snapshot: { ids: ["model-a"], storedAt: 1, source: "network" },
		networkAttempted: true,
		networkSucceeded: true,
		retryable: true,
		failed: false,
	});
	assert.equal(requestSignal.aborted, false);
});

test("后加入者不重置从首个 join 起算的 60 秒截止", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	let sharedSignal!: AbortSignal;
	const request = (signal: AbortSignal): Promise<GatewayCatalogOutcome> => {
		sharedSignal = signal;
		return neverUntilAborted(signal);
	};
	let firstDone = false;
	const first = recovery.join(request, fallback);
	void first.then(() => { firstDone = true; }, () => { firstDone = true; });
	await flush();
	t.mock.timers.tick(30_000);
	const second = recovery.join(request, fallback);
	let secondDone = false;
	void second.then(() => { secondDone = true; }, () => { secondDone = true; });
	await flush();
	assert.equal(firstDone, false);
	assert.equal(secondDone, false);

	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS - 30_001);
	await flush();
	assert.equal(firstDone, false);
	assert.equal(secondDone, false);
	t.mock.timers.tick(1);
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.failed, true);
	assert.equal(b.failed, true);
	assert.equal(sharedSignal.aborted, true);
});

test("401/403 分类为不可重试时，所有 join 立即共同失败", async t => {
	for (const status of [401, 403]) {
		await t.test(`HTTP ${status}`, async t => {
			fakeTimers(t);
			const recovery = createGatewayCatalogRecovery();
			let calls = 0;
			const request = async (): Promise<GatewayCatalogOutcome> => {
				calls++;
				// GatewayCatalogOutcome 把 401/403 映射为 failed + retryable:false。
				return failed(false);
			};
			const first = recovery.join(request, fallback);
			const second = recovery.join(request, fallback);
			const [a, b] = await Promise.all([first, second]);
			assert.equal(calls, 1);
			assert.deepEqual(a, failed(false));
			assert.deepEqual(b, failed(false));
			t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
			await flush();
			assert.equal(calls, 1, "认证失败不得进入重试");
		});
	}
});

test("截止时取消只作用于共享恢复 signal，挂起请求失败也不产生未处理 rejection", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	const caller = new AbortController();
	let requestSignal!: AbortSignal;
	let unhandled = 0;
	const observe = (): void => { unhandled++; };
	process.on("unhandledRejection", observe);
	t.after(() => process.off("unhandledRejection", observe));
	const request = (signal: AbortSignal): Promise<GatewayCatalogOutcome> => {
		requestSignal = signal;
		return neverUntilAborted(signal);
	};
	const joined = recovery.join(request, fallback, caller.signal);
	await flush();
	assert.notStrictEqual(requestSignal, caller.signal);
	assert.equal(requestSignal.aborted, false);

	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	const result = await joined;
	assert.equal(result.failed, true);
	assert.equal(requestSignal.aborted, true);
	assert.equal(caller.signal.aborted, false, "截止只应取消共享恢复自身的 signal");
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(unhandled, 0);
});

test("取消单个 waiter 不影响其他 join，最后一个取消才中止共享请求", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	const firstCaller = new AbortController();
	const lastCaller = new AbortController();
	let requestSignal!: AbortSignal;
	const request = (signal: AbortSignal): Promise<GatewayCatalogOutcome> => {
		requestSignal = signal;
		return neverUntilAborted(signal);
	};
	const first = recovery.join(request, fallback, firstCaller.signal);
	const last = recovery.join(request, fallback, lastCaller.signal);
	await flush();

	firstCaller.abort();
	await assert.rejects(first, { name: "AbortError" });
	assert.equal(requestSignal.aborted, false, "仍有 waiter 时底层请求继续");
	lastCaller.abort();
	await assert.rejects(last, { name: "AbortError" });
	assert.equal(requestSignal.aborted, true, "最后一个 waiter 取消才中止共享请求");
});

test("stop 中止当前轮次，之后的新 join 可以启动新轮次", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	let calls = 0;
	let stoppedSignal!: AbortSignal;
	const stopped = recovery.join(signal => {
		stoppedSignal = signal;
		calls++;
		return neverUntilAborted(signal);
	}, fallback);
	await flush();
	recovery.stop();
	await assert.rejects(stopped, { name: "AbortError" });
	assert.equal(stoppedSignal.aborted, true);

	let newSignal!: AbortSignal;
	const next = recovery.join(async signal => {
		newSignal = signal;
		calls++;
		return success();
	}, fallback);
	const result = await next;
	assert.equal(result.failed, false);
	assert.equal(calls, 2);
	assert.notStrictEqual(newSignal, stoppedSignal);
	assert.equal(newSignal.aborted, false);
});

test("请求成功后清除截止定时器，后续 join 可建立新轮次", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	let calls = 0;
	let fallbacks = 0;
	const signals: AbortSignal[] = [];
	const request = async (signal: AbortSignal): Promise<GatewayCatalogOutcome> => {
		calls++;
		signals.push(signal);
		return success();
	};
	const getFallback = (): GatewayCatalogOutcome => {
		fallbacks++;
		return fallback();
	};
	assert.equal((await recovery.join(request, getFallback)).failed, false);
	const fallbackCallsAfterSuccess = fallbacks;
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await flush();
	assert.equal(signals[0].aborted, false, "成功的轮次不应被旧截止 timer 取消");
	assert.equal(fallbacks, fallbackCallsAfterSuccess, "旧轮次截止不得触发 fallback");

	assert.equal((await recovery.join(request, getFallback)).failed, false);
	assert.equal(calls, 2);
	assert.notStrictEqual(signals[0], signals[1]);
});

test("获取器首次抛普通异常后按短间隔重试，成功不外传原始异常", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	let calls = 0;
	const result = recovery.join(async () => {
		if (++calls === 1) throw new Error("synthetic private failure");
		return success();
	}, fallback);
	await flush();
	assert.equal(calls, 1);
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS - 1);
	await flush();
	assert.equal(calls, 1);
	t.mock.timers.tick(1);
	await flush();
	assert.equal((await result).failed, false);
	assert.equal(calls, 2);
});

test("持续抛异常到截止只交付一次失败，deadline 与重试同 tick 不额外请求", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	let calls = 0;
	let fallbacks = 0;
	const result = recovery.join(async () => { calls++; throw new Error("synthetic"); },
		() => { fallbacks++; return fallback(); });
	await flush();
	for (let i = 1; i < 12; i++) {
		t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
		await flush();
	}
	assert.equal(calls, 12);
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
	assert.equal((await result).failed, true);
	await flush();
	assert.equal(calls, 12);
	assert.equal(fallbacks, 1);
});

test("截止 fallback 抛错也返回安全失败并取消请求，不泄漏 timer 异常", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	let signal!: AbortSignal;
	const result = recovery.join(input => { signal = input; return neverUntilAborted(input); },
		() => { throw new Error("synthetic private fallback"); });
	await flush();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	assert.deepEqual(await result, fallback());
	assert.equal(signal.aborted, true);
});

test("首个实例退出后重试改由仍活跃实例执行，不再调用旧宿主服务", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	const caller = new AbortController();
	let firstCalls = 0;
	let secondCalls = 0;
	const first = recovery.join(async () => { firstCalls++; return failed(); }, fallback, caller.signal);
	const rejected = assert.rejects(first, { name: "AbortError" });
	const second = recovery.join(async () => { secondCalls++; return success(); }, fallback);
	await flush();
	assert.equal(firstCalls, 1);
	assert.equal(secondCalls, 0);
	caller.abort();
	await rejected;
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
	await flush();
	assert.equal((await second).failed, false);
	assert.equal(firstCalls, 1);
	assert.equal(secondCalls, 1);
});

test("最后一个等待者在重试间隔退出，清除等待 timer 且不再发起请求", async t => {
	fakeTimers(t);
	const recovery = createGatewayCatalogRecovery();
	const caller = new AbortController();
	let calls = 0;
	const result = recovery.join(async () => { calls++; return failed(); }, fallback, caller.signal);
	const rejected = assert.rejects(result, { name: "AbortError" });
	await flush();
	caller.abort();
	await rejected;
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await flush();
	assert.equal(calls, 1);
});
