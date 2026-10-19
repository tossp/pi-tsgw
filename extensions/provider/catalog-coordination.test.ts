import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { CATALOG_RECOVERY_WINDOW_MS } from "./catalog-recovery.ts";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "#tsgw/models/gateway-catalog";
import { modelResponse, waitUntil, withUi } from "./catalog-test-support.test.ts";

type CatalogDetails = { cacheFilePath: string; count: number; storedAt: number };
type RefreshTool = {
	name: string;
	execute(
		id: string,
		params: { force?: boolean },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ details: CatalogDetails }>;
};

function refreshTool(pi: { tools: unknown[] }): RefreshTool {
	const tool = pi.tools.find((candidate) =>
		(candidate as { name?: unknown }).name === "tsgw_refresh_models") as
		| RefreshTool
		| undefined;
	if (!tool) throw new Error("缺少 tsgw_refresh_models 工具");
	return tool;
}

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

// 1. 同一 force 任务：两个工具调用只产生一次宿主刷新和一次 GET，两者都成功。
await withUi(async ({ pi, ctx, refreshCalls }) => {
	const before = refreshCalls();
	const network = controlledNetwork();
	const tool = refreshTool(pi);
	const first = tool.execute("force-a", { force: true },
		new AbortController().signal, undefined, ctx);
	await network.started(0);
	const second = tool.execute("force-b", { force: true },
		new AbortController().signal, undefined, ctx);
	await flush();
	equal(refreshCalls(), before + 1, "并发 force 只能提交一次宿主刷新");
	equal(network.calls(), 1, "并发 force 只能发起一次网关 GET");
	network.release(0, modelResponse());
	const [firstResult, secondResult] = await Promise.all([first, second]);
	equal(firstResult.details.count, 2);
	deepStrictEqual(secondResult.details, firstResult.details, "同一任务的调用方必须得到一致结果");
	equal(network.signals[0].aborted, false, "共享任务不得因第二个调用方进入而被取消");
	equal(refreshCalls(), before + 1);
	equal(network.calls(), 1);
});

// 2. 命令强制刷新与 force 工具合流：复用同一宿主刷新，不取消共享 signal，结果正确。
await withUi(async ({ pi, ctx, notices, refreshCalls }) => {
	const before = refreshCalls();
	const network = controlledNetwork();
	const command = pi.invokeCommand("tsgw-refresh", ctx);
	await network.started(0);
	const toolSignal = new AbortController();
	const tool = refreshTool(pi).execute("force-tool", { force: true },
		toolSignal.signal, undefined, ctx);
	await flush();
	equal(refreshCalls(), before + 1, "命令与工具并发时只能提交一次宿主刷新");
	equal(network.signals[0].aborted, false, "工具合流不得取消命令等待的共享请求");
	equal(toolSignal.signal.aborted, false);
	network.release(0, modelResponse(["glm-5.2"]));
	const [, result] = await Promise.all([command, tool]);
	equal(result.details.count, 1, "工具必须返回与命令相同的网络结果");
	match(notices.at(-1)?.text ?? "", /已刷新/);
	equal(notices.at(-1)?.level, "info");
	equal(network.signals[0].aborted, false);
	equal(refreshCalls(), before + 1);
	equal(network.calls(), 1);
});

// 3. normal 已经开始实际联网时，force 合流复用同一 GET，不启动第二轮。
await withUi(async ({ pi, ctx, refreshCalls }) => {
	const before = refreshCalls();
	const restoreClock = advanceClock(TTL + 60_000);
	try {
		const network = controlledNetwork();
		const tool = refreshTool(pi);
		const normal = tool.execute("normal", {}, undefined, undefined, ctx);
		await network.started(0);
		const normalSignal = network.signals[0];
		const forced = tool.execute("force", { force: true }, undefined, undefined, ctx);
		await flush();
		equal(network.calls(), 1, "force 必须等待挂起的 normal，不能并发发起第二次 GET");
		equal(normalSignal.aborted, false, "force 入队不得取消 normal 的网络请求");
		equal(refreshCalls(), before + 1, "force 在 normal 完成前不得提交新的宿主刷新");

		network.release(0, modelResponse(["glm-5.2"]));
		const [normalResult, forceResult] = await Promise.all([normal, forced]);
		equal(normalResult.details.count, 1);
		deepStrictEqual(forceResult.details, normalResult.details,
			"force 要求绕过缓存，正在进行的 GET 已满足，不应重复获取");
		equal(normalSignal.aborted, false);
		deepStrictEqual(network.events, ["start:0", "end:0"]);
		equal(network.calls(), 1);
		equal(refreshCalls(), before + 1);
	} finally {
		restoreClock();
	}
});

// 4. 一个工具调用方取消只脱离自己；命令和另一工具仍等待共享任务并成功。
await withUi(async ({ pi, ctx, notices, refreshCalls }) => {
	const before = refreshCalls();
	const network = controlledNetwork();
	const tool = refreshTool(pi);
	const command = pi.invokeCommand("tsgw-refresh", ctx);
	await network.started(0);
	const canceledSignal = new AbortController();
	const waitingSignal = new AbortController();
	const canceled = tool.execute("canceled", { force: true },
		canceledSignal.signal, undefined, ctx);
	const waiting = tool.execute("waiting", { force: true },
		waitingSignal.signal, undefined, ctx);
	await flush();
	canceledSignal.abort();
	await rejects(canceled, /已取消/);
	equal(network.signals[0].aborted, false, "单个工具取消不能中止共享任务");
	equal(waitingSignal.signal.aborted, false, "其他调用方的 signal 不能被连带取消");
	equal(refreshCalls(), before + 1, "取消只脱离等待者，不重复提交刷新");
	network.release(0, modelResponse(["glm-5.2"]));
	const [, result] = await Promise.all([command, waiting]);
	equal(result.details.count, 1, "剩余调用方必须继续得到正确结果");
	match(notices.at(-1)?.text ?? "", /已刷新/);
	equal(notices.at(-1)?.level, "info");
	equal(refreshCalls(), before + 1);
	equal(network.calls(), 1);
});

// 5. 恢复轮 deadline 只取消恢复自己的等待者；已合流的 manual 等待者继续完成共享任务。
await withUi(async ({ pi, ctx, notices, restoreCalls }) => {
	const restoreClock = advanceClock(TTL + 60_000);
	const deadline = captureRecoveryDeadline();
	try {
		const network = controlledNetwork();
		const tool = refreshTool(pi);
		const restores = restoreCalls();
		pi.invoke("session_start", { reason: "new" }, ctx);
		await waitUntil(() => restoreCalls() === restores + 1,
			"替换会话未执行本地 restore");
		await network.started(0);
		const taskSignal = network.signals[0];
		const manualSignal = new AbortController();
		const manual = tool.execute("manual", {}, manualSignal.signal, undefined, ctx);
		await flush();
		equal(network.calls(), 1, "manual 应合流到恢复中的 normal 任务");
		equal(taskSignal.aborted, false);

		deadline.trigger();
		await flush();
		equal(taskSignal.aborted, false, "恢复截止只能取消恢复自身，不能中止仍有人等待的任务");
		equal(manualSignal.signal.aborted, false, "manual 等待者不得被恢复截止取消");
		match(notices.at(-1)?.text ?? "", /模型目录获取失败/);
		equal(notices.at(-1)?.level, "error");

		network.release(0, modelResponse(["glm-5.2"]));
		const result = await manual;
		equal(result.details.count, 1, "manual 等待者仍必须收到共享任务的网络结果");
		equal(network.calls(), 1, "恢复停止后不得额外发起网络请求");
	} finally {
		deadline.restore();
		restoreClock();
	}
});

console.log("catalog-coordination.test.ts：全部断言通过");
