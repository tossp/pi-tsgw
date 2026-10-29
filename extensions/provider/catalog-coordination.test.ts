import { deepStrictEqual, equal, match } from "node:assert/strict";
import { CATALOG_RECOVERY_WINDOW_MS } from "./catalog-recovery.ts";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "#tsgw/models/gateway-catalog";
import { modelResponse, waitUntil, withUi } from "./catalog-test-support.test.ts";

/*
 * 模型可调用的目录刷新工具已撤下，本文件只经真实用户入口验证协调语义：
 * - 命令 `/tsgw-refresh` 提交 force；
 * - `session_start` 的后台恢复提交 restore，并在需要时提交 normal。
 * 等待者级并发、排队与取消细项由 catalog-coordinator.test.ts 覆盖。
 */

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

/** 等本轮已排队的微任务落定；用于确认并发调用已经提交/合并且不依赖 sleep。 */
async function flush(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

/** 每次 fetch 都由 started/release 显式控制，避免用超时猜测竞态。 */
function controlledNetwork() {
	const starts = [deferred<void>(), deferred<void>(), deferred<void>()];
	const signals: AbortSignal[] = [];
	const events: string[] = [];
	const releases = new Map<number, (response: Response) => void>();
	let calls = 0;
	globalThis.fetch = async (_input, init) => {
		const index = calls++;
		const signal = init?.signal ?? new AbortController().signal;
		signals[index] = signal;
		events.push(`start:${index}`);
		starts[index]?.resolve();
		const response = await new Promise<Response>((resolve) => {
			releases.set(index, resolve);
		});
		events.push(`end:${index}`);
		return response;
	};
	return {
		events,
		signals,
		started: (index: number) => starts[index].promise,
		calls: () => calls,
		release(index: number, response: Response) {
			const release = releases.get(index);
			if (!release) throw new Error(`第 ${index} 次网络请求尚未启动`);
			release(response);
		},
	};
}

/** 只让缓存快照相对当前时间过期，不改动真实定时器。 */
function advanceClock(by: number): () => void {
	const original = Date.now;
	Date.now = () => original() + by;
	return () => { Date.now = original; };
}

const DEADLINE = Symbol("recovery-deadline");
type DeadlineHandle = ReturnType<typeof setTimeout> & { [DEADLINE]?: number };

/**
 * 捕获恢复轮的 60 秒截止，而不触发网关请求自身的 5 秒超时。
 * 网络仍由 controlledNetwork 的 release 控制，因此这里只模拟恢复轮到期。
 */
function captureRecoveryDeadline() {
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const records: Array<{ callback: () => void; canceled: boolean }> = [];
	globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number,
		...args: any[]) => {
		if (delay !== CATALOG_RECOVERY_WINDOW_MS)
			return originalSetTimeout(callback, delay, ...args);
		const id = records.length + 1;
		records.push({ callback: () => callback(...args), canceled: false });
		return {
			[DEADLINE]: id,
			unref() {},
			ref() {},
			hasRef: () => true,
			refresh() { return this; },
		} as unknown as DeadlineHandle;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
		const id = (handle as DeadlineHandle | undefined)?.[DEADLINE];
		const record = id === undefined ? undefined : records[id - 1];
		if (record) { record.canceled = true; return; }
		originalClearTimeout(handle);
	}) as typeof clearTimeout;
	return {
		trigger() {
			const record = records.find((candidate) => !candidate.canceled);
			if (!record) throw new Error("未捕获到恢复截止定时器");
			record.canceled = true;
			record.callback();
		},
		restore() {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		},
	};
}

const availableIds = (registry: { getAvailable(): Array<{ provider: string; id: string }> }) =>
	registry.getAvailable().filter((model) => model.provider === "tsgw").map((model) => model.id).sort();

// 1. 同一 force 任务：两个并发命令只产生一次宿主刷新和一次 GET，两者都成功。
await withUi(async ({ pi, ctx, notices, refreshCalls }) => {
	const before = refreshCalls();
	const noticesBefore = notices.length;
	const network = controlledNetwork();
	const first = pi.invokeCommand("tsgw-refresh", ctx);
	await network.started(0);
	const second = pi.invokeCommand("tsgw-refresh", ctx);
	await flush();
	equal(refreshCalls(), before + 1, "并发强制命令只能提交一次宿主刷新");
	equal(network.calls(), 1, "并发强制命令只能发起一次网关 GET");
	network.release(0, modelResponse());
	await Promise.all([first, second]);
	equal(network.signals[0].aborted, false, "共享任务不得因第二个调用方进入而被取消");
	equal(refreshCalls(), before + 1);
	equal(network.calls(), 1);
	equal(notices.length, noticesBefore + 2, "两个命令都必须得到自己的刷新结果");
	for (const notice of notices.slice(noticesBefore)) {
		match(notice.text, /已刷新/);
		equal(notice.level, "info");
	}
	deepStrictEqual(availableIds(ctx.modelRegistry), ["glm-5.2", "gpt-6-sol"]);
});

// 2. 后台恢复已开始实际联网时，强制命令复用同一 GET，不启动第二轮，也不取消共享请求。
await withUi(async ({ pi, ctx, notices, refreshCalls, restoreCalls }) => {
	const restoreClock = advanceClock(TTL + 60_000);
	try {
		const network = controlledNetwork();
		const before = refreshCalls();
		const restores = restoreCalls();
		pi.invoke("session_start", { reason: "new" }, ctx);
		await waitUntil(() => restoreCalls() === restores + 1, "替换会话未执行本地 restore");
		await network.started(0);
		const recoverySignal = network.signals[0];
		const noticesBefore = notices.length;
		const command = pi.invokeCommand("tsgw-refresh", ctx);
		await flush();
		equal(network.calls(), 1, "命令必须复用后台正在进行的 GET，不能并发发起第二次联网");
		equal(recoverySignal.aborted, false, "命令合流不得取消后台恢复等待的请求");
		equal(refreshCalls(), before + 2, "命令不得额外提交宿主刷新（restore + normal 各一次）");

		network.release(0, modelResponse(["glm-5.2"]));
		await command;
		equal(recoverySignal.aborted, false);
		deepStrictEqual(network.events, ["start:0", "end:0"]);
		equal(network.calls(), 1);
		equal(refreshCalls(), before + 2);
		equal(notices.length, noticesBefore + 1, "恢复成功不额外告警，只有命令报告结果");
		match(notices.at(-1)?.text ?? "", /已刷新/);
		equal(notices.at(-1)?.level, "info");
		deepStrictEqual(availableIds(ctx.modelRegistry), ["glm-5.2"]);
	} finally {
		restoreClock();
	}
});

// 3. 恢复轮 deadline 只取消恢复自己的等待者；已合流的命令继续完成共享任务并报告成功。
await withUi(async ({ pi, ctx, notices, refreshCalls, restoreCalls }) => {
	const restoreClock = advanceClock(TTL + 60_000);
	const deadline = captureRecoveryDeadline();
	try {
		const network = controlledNetwork();
		const before = refreshCalls();
		const restores = restoreCalls();
		pi.invoke("session_start", { reason: "new" }, ctx);
		await waitUntil(() => restoreCalls() === restores + 1, "替换会话未执行本地 restore");
		await network.started(0);
		const taskSignal = network.signals[0];
		const noticesBefore = notices.length;
		const command = pi.invokeCommand("tsgw-refresh", ctx);
		await flush();
		equal(network.calls(), 1, "命令应合流到恢复中的联网任务");
		equal(taskSignal.aborted, false);

		deadline.trigger();
		await flush();
		equal(taskSignal.aborted, false, "恢复截止只能取消恢复自身，不能中止仍有人等待的任务");
		equal(notices.length, noticesBefore + 1, "截止只追加恢复失败告警");
		match(notices.at(-1)?.text ?? "", /模型目录获取失败/);
		equal(notices.at(-1)?.level, "error");
		equal(refreshCalls(), before + 2, "取消恢复等待者不得重复提交刷新");

		network.release(0, modelResponse(["glm-5.2"]));
		await command;
		equal(network.calls(), 1, "恢复停止后不得额外发起网络请求");
		equal(refreshCalls(), before + 2);
		match(notices.at(-1)?.text ?? "", /已刷新/);
		equal(notices.at(-1)?.level, "info", "命令仍必须收到共享任务的网络结果");
		deepStrictEqual(availableIds(ctx.modelRegistry), ["glm-5.2"]);
	} finally {
		deadline.restore();
		restoreClock();
	}
});

console.log("catalog-coordination.test.ts：全部断言通过");
