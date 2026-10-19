import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogRecovery, CATALOG_RECOVERY_WINDOW_MS, CATALOG_RECOVERY_DELAY_MS } from "./catalog-recovery.ts";

async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

test("恢复不在启动调用栈内请求；先 restore 再 refresh，成功后停止定时器", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let stale = true;
	let restores = 0;
	let calls = 0;
	let failures = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => stale, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: async () => { restores++; },
		refresh: async () => { calls++; stale = false; } });
	assert.equal(restores, 0);
	assert.equal(calls, 0);
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 1);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS * 2);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 1);
	assert.equal(failures, 0);
});

test("网络失败短间隔重试；整个窗口达到一分钟立即告警且只告警一次", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let calls = 0;
	let failures = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, refresh: async () => {
		calls++;
		return { errors: new Map([["tsgw", new Error("synthetic")]]) };
	} });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(calls, 1);
	for (let i = 1; i < 12; i++) {
		t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
		await drain();
		assert.equal(failures, 0);
	}
	assert.equal(calls, 12);
	t.mock.timers.tick(4999);
	await drain();
	assert.equal(failures, 0);
	t.mock.timers.tick(1);
	await drain();
	assert.equal(failures, 1);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 1);
	assert.equal(calls, 12);
});

test("请求不理会取消时，一分钟截止仍发出告警；迟到成功不能复活恢复", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let resolve!: () => void;
	let signal: AbortSignal | undefined;
	let failures = 0;
	let calls = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, refresh: input => {
		calls++;
		signal = input;
		return new Promise<void>(done => { resolve = done; });
	} });
	t.mock.timers.tick(0);
	await drain();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 1);
	assert.equal(signal?.aborted, true);
	resolve();
	await drain();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 1);
	assert.equal(calls, 1);
});

test("缺凭据在 defer 后提示用户；认证失败不重复请求", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let restores = 0;
	let calls = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => false,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => false, restore: async () => { restores++; },
		refresh: async () => { calls++; } });
	assert.equal(failures, 0, "启动栈内不应提示");
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1, "缺凭据也要先给本地快照恢复机会");
	assert.equal(failures, 1);
	assert.equal(calls, 0);
	recovery.start({ configured: () => true, restore: async () => { restores++; },
		refresh: async () => {
			calls++;
			return { errors: new Map([["tsgw", new Error("unauthorized")]]) };
		} });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(failures, 2);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(calls, 1);
	assert.equal(failures, 2);
});

test("停止后不请求、不告警；新恢复替换旧恢复", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let calls = 0;
	let restores = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	const service = { configured: () => true, restore: async () => { restores++; },
		refresh: async () => { calls++; throw new Error("network"); } };
	recovery.start(service);
	recovery.stop();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(calls, 0);
	assert.equal(restores, 0);
	assert.equal(failures, 0);
	recovery.start(service);
	recovery.start(service);
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 1);
	recovery.stop();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 0);
	assert.equal(calls, 1);
});

test("宿主禁止联网时不重试、不绕过许可（restore 仍执行）", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let calls = 0;
	let restores = 0;
	let failures = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => false, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: async () => { restores++; },
		refresh: async () => { calls++; } });
	t.mock.timers.tick(0);
	await drain();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 1);
	assert.equal(failures, 0);
});

test("其他宿主刷新取代当前请求后仍可恢复", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let calls = 0;
	let stale = true;
	const recovery = createCatalogRecovery({ needsRefresh: () => stale, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { assert.fail("不应失败"); } });
	recovery.start({ configured: () => true, refresh: async () => {
		if (++calls === 1) return { aborted: true };
		stale = false;
	} });
	t.mock.timers.tick(0);
	await drain();
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
	await drain();
	assert.equal(calls, 2);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(calls, 2);
});

test("restore 后凭据从无到有，才允许发起网络刷新", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let configured = false;
	let stale = true;
	let restores = 0;
	let calls = 0;
	let failures = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => stale, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({
		configured: () => configured,
		restore: async () => { restores++; configured = true; },
		refresh: async () => { calls++; stale = false; },
	});
	assert.equal(failures, 0);
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 1, "restore 补回凭据后应继续联网");
	assert.equal(failures, 0);
});

test("快照本已新鲜也先 restore，以吸收另一会话写入的磁盘更新", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let restores = 0;
	let calls = 0;
	let failures = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => false, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: async () => { restores++; },
		refresh: async () => { calls++; } });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 0);
	assert.equal(failures, 0);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 0);
});

test("restore 挂起占满整轮窗口：截止只告警一次、取消 restore 且不发起网络", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let restores = 0;
	let calls = 0;
	let signal: AbortSignal | undefined;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: input => {
		restores++;
		signal = input;
		return new Promise<void>(() => {});
	}, refresh: async () => { calls++; } });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS - 1);
	await drain();
	assert.equal(failures, 0);
	assert.equal(signal?.aborted, false);
	t.mock.timers.tick(1);
	await drain();
	assert.equal(failures, 1);
	assert.equal(signal?.aborted, true);
	assert.equal(calls, 0);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 1);
	assert.equal(restores, 1);
});

test("restore 被其他刷新取代时不当作成功，短间隔后重试本地并停止", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let stale = true;
	let restores = 0;
	let calls = 0;
	const recovery = createCatalogRecovery({ needsRefresh: () => stale, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { assert.fail("不应失败"); } });
	recovery.start({ configured: () => true, restore: async () => {
		if (++restores === 1) return { aborted: true };
		stale = false;
	}, refresh: async () => { calls++; } });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(calls, 0);
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS - 1);
	await drain();
	assert.equal(restores, 1);
	t.mock.timers.tick(1);
	await drain();
	assert.equal(restores, 2);
	assert.equal(calls, 0, "本地恢复成功后快照已新鲜，不应联网");
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(restores, 2);
});

test("restore 持续取消时按短间隔重试，截止仍只告警一次", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let restores = 0;
	let calls = 0;
	let signal: AbortSignal | undefined;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: input => {
		restores++;
		signal = input;
		return Promise.resolve({ aborted: true });
	}, refresh: async () => { calls++; } });
	t.mock.timers.tick(0);
	await drain();
	for (let i = 1; i < 12; i++) {
		t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
		await drain();
		assert.equal(failures, 0);
	}
	assert.equal(restores, 12);
	t.mock.timers.tick(4999);
	await drain();
	assert.equal(failures, 0);
	t.mock.timers.tick(1);
	await drain();
	assert.equal(failures, 1);
	assert.equal(signal?.aborted, true);
	assert.equal(calls, 0);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(restores, 12);
	assert.equal(failures, 1);
});

test("restore 暂时失败后同窗口重试成功：不提前告警且网络成功", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let restores = 0;
	let calls = 0;
	let stale = true;
	let unhandled = 0;
	const onUnhandled = (): void => { unhandled++; };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const recovery = createCatalogRecovery({ needsRefresh: () => stale, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: async () => {
		if (++restores === 1) throw new Error("local snapshot read failed");
	}, refresh: async () => { calls++; stale = false; } });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(failures, 0, "restore 暂时失败不应提前告警");
	assert.equal(calls, 0, "restore 未成功前不应联网");
	t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS - 1);
	await drain();
	assert.equal(restores, 1);
	t.mock.timers.tick(1);
	await drain();
	assert.equal(restores, 2, "同一窗口短间隔后应重试 restore");
	assert.equal(calls, 1, "restore 成功后应继续联网");
	assert.equal(failures, 0, "网络成功不告警");
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS * 2);
	await drain();
	assert.equal(restores, 2);
	assert.equal(calls, 1);
	assert.equal(failures, 0);
	assert.equal(unhandled, 0);
});

test("restore 持续失败到一分钟：只告警一次、从不联网且停止后不再请求", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let restores = 0;
	let calls = 0;
	let signal: AbortSignal | undefined;
	let unhandled = 0;
	const onUnhandled = (): void => { unhandled++; };
	process.on("unhandledRejection", onUnhandled);
	t.after(() => process.off("unhandledRejection", onUnhandled));
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; } });
	recovery.start({ configured: () => true, restore: async input => {
		signal = input;
		// 同时覆盖抛错与 errors(tsgw) 两种失败形式。
		if (++restores % 2 === 1) return { errors: new Map([["tsgw", new Error("snapshot")]]) };
		throw new Error("local snapshot read failed");
	}, refresh: async () => { calls++; } });
	t.mock.timers.tick(0);
	await drain();
	assert.equal(restores, 1);
	assert.equal(failures, 0, "restore 失败不应提前告警");
	for (let i = 1; i < 12; i++) {
		t.mock.timers.tick(CATALOG_RECOVERY_DELAY_MS);
		await drain();
		assert.equal(restores, i + 1, "同一窗口内应持续短间隔重试 restore");
		assert.equal(failures, 0);
		assert.equal(calls, 0, "restore 持续失败时不得联网");
	}
	t.mock.timers.tick(4999);
	await drain();
	assert.equal(failures, 0);
	t.mock.timers.tick(1);
	await drain();
	assert.equal(failures, 1, "到达截止只告警一次");
	assert.equal(signal?.aborted, true);
	assert.equal(calls, 0);
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(restores, 12);
	assert.equal(failures, 1);
	assert.equal(calls, 0, "停止后不再请求");
	assert.equal(unhandled, 0);
});

test("onFailure 抛错时仍取消底层请求并清理恢复状态", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
	let failures = 0;
	let signal: AbortSignal | undefined;
	let resolve!: () => void;
	const recovery = createCatalogRecovery({ needsRefresh: () => true, retryable: () => true,
		networkAttempted: () => true, onFailure: () => { failures++; throw new Error("notify failed"); } });
	recovery.start({ configured: () => true, refresh: input => {
		signal = input;
		return new Promise<void>(done => { resolve = done; });
	} });
	t.mock.timers.tick(0);
	await drain();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 1);
	assert.equal(signal?.aborted, true);
	resolve();
	await drain();
	t.mock.timers.tick(CATALOG_RECOVERY_WINDOW_MS);
	await drain();
	assert.equal(failures, 1);
});
