import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { CatalogRefreshContext } from "./catalog-state.ts";

export type CatalogRefreshKind = "restore" | "normal" | "force";

export interface CatalogRefreshSummary {
	cacheFilePath: string;
	count: number;
	storedAt: number;
}

export interface CatalogRefreshOutcome {
	aborted?: boolean;
	errors?: ReadonlyMap<string, Error>;
	networkSucceeded: boolean;
	summary?: CatalogRefreshSummary;
}

export interface CatalogRefreshRunResult {
	aborted?: boolean;
	errors?: ReadonlyMap<string, Error>;
}

type CatalogRefreshRun = (
	signal: AbortSignal,
) => Promise<CatalogRefreshRunResult | void>;

interface CatalogSnapshot {
	networkAttempted?: boolean;
	networkSucceeded: boolean;
	summary?: CatalogRefreshSummary;
}

interface Waiter {
	signal?: AbortSignal;
	resolve(outcome: CatalogRefreshOutcome): void;
	reject(error: Error): void;
	onAbort?: () => void;
	done: boolean;
}

interface CatalogJob {
	kind: CatalogRefreshKind;
	/** 待执行 normal 升级 force 时，必须替换为本任务对应的强制刷新闭包。 */
	run: CatalogRefreshRun;
	controller: AbortController;
	waiters: Set<Waiter>;
	/** 本 job 首个 provider 回调的宿主 signal，用于区分同任务两阶段与外部抢占。 */
	firstProviderSignal?: AbortSignal;
	/** 是否已经历首个 provider 回调；兼容旧宿主完全没有 signal 的情况。 */
	providerCallbackSeen: boolean;
	/** 已确认外部回调提前接管；即使宿主外层误报成功也不能算本 job 成功。 */
	providerPreempted: boolean;
	/** 已归属本 job 的 signal；完成时据此识别宿主误报未取消。 */
	observedSignals: Set<AbortSignal>;
	snapshot?: CatalogSnapshot;
	snapshotCaptured: boolean;
	finalized: boolean;
	generation: number;
}

const CANCELLED_MESSAGE = "TSGW 模型目录刷新已取消。";

/** 只生成本地安全取消错误，不回传宿主 signal.reason，避免带出凭据或原始响应。 */
function cancelledError(): Error {
	const error = new Error(CANCELLED_MESSAGE);
	error.name = "AbortError";
	return error;
}

function removeWaiterListener(waiter: Waiter): void {
	if (waiter.signal && waiter.onAbort) {
		waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.onAbort = undefined;
	}
}

/**
 * 汇总刷新协调器：先在本插件内合并、排队，再进入宿主 registry 刷新。
 *
 * 约束：
 * - 同一时刻至多一个真正运行的 job；网络任务至多再有一个排队。
 * - restore 是本地任务，绝不并入或升级为联网任务；它可单独排队。
 * - 调用者 signal 只取消自己的 waiter；只有最后一个 waiter 消失才 abort 共享 job。
 * - 不保存宿主生命周期 context，也不代替宿主修复 provider 回调之前的抢占。
 */
export function createCatalogCoordinator(options: {
	begin(): void;
	inspect(): { networkAttempted?: boolean; networkSucceeded: boolean; summary?: CatalogRefreshSummary };
	/** 普通任务已经开始实际 GET，足以满足后来 force 的绕过缓存要求。 */
	canShareNetwork?(): boolean;
}) {
	/** stop 递增代际；旧 run 的迟到完成只能被忽略。 */
	let generation = 0;
	let running: CatalogJob | undefined;
	let pendingNetwork: CatalogJob | undefined;
	let pendingRestore: CatalogJob | undefined;
	/** 完成快照期间暂停启动下一 job，防止 inspect 被后续计数变化污染。 */
	let settling = 0;

	const captureSnapshot = (job: CatalogJob): CatalogSnapshot => {
		if (job.snapshotCaptured) return job.snapshot ?? { networkSucceeded: false };
		job.snapshotCaptured = true;
		try {
			job.snapshot = options.inspect();
		} catch {
			// 诊断读取失败不能把已完成的目录请求伪装成成功。
			job.snapshot = { networkSucceeded: false };
		}
		return job.snapshot;
	};

	const resolveWaiters = (job: CatalogJob, outcome: CatalogRefreshOutcome): void => {
		for (const waiter of [...job.waiters]) {
			if (waiter.done) continue;
			waiter.done = true;
			removeWaiterListener(waiter);
			job.waiters.delete(waiter);
			waiter.resolve({ ...outcome,
				...(outcome.summary ? { summary: { ...outcome.summary } } : {}),
				...(outcome.errors ? { errors: new Map(outcome.errors) } : {}),
			});
		}
	};

	const rejectWaiters = (job: CatalogJob, error: Error): void => {
		for (const waiter of [...job.waiters]) {
			if (waiter.done) continue;
			waiter.done = true;
			removeWaiterListener(waiter);
			job.waiters.delete(waiter);
			waiter.reject(error);
		}
	};

	const clearQueued = (job: CatalogJob): void => {
		if (pendingNetwork === job) pendingNetwork = undefined;
		if (pendingRestore === job) pendingRestore = undefined;
	};

	/**
	 * 最后 waiter 取消或 stop 时立即解锁调度，不等待不响应 abort 的 runner。
	 * 迟到 run 的完成由 finalized / 代际检查丢弃。
	 */
	const abortJob = (job: CatalogJob, error: Error): void => {
		if (job.finalized) return;
		job.finalized = true;
		if (running === job) running = undefined;
		clearQueued(job);
		// 先清状态再 abort，允许 abort 监听器安全地发起新请求而不撞见旧 running。
		job.controller.abort();
		rejectWaiters(job, error);
		pump();
	};

	const finishJob = (job: CatalogJob, result: CatalogRefreshRunResult | void): void => {
		if (job.finalized || job.generation !== generation) return;
		// 先标记完成但保留 running 占位，确保 inspect 期间不会启动下一 job。
		job.finalized = true;
		settling++;
		let snapshot: CatalogSnapshot;
		try {
			snapshot = captureSnapshot(job);
		} finally {
			settling--;
		}
		// inspect 期间若发生 stop，代际变化或占位被清理，旧 job 不得再交付结果。
		if (job.generation !== generation || running !== job) return;
		running = undefined;

		const observedAbort = [...job.observedSignals].some(signal => signal.aborted);
		const aborted = result?.aborted === true || observedAbort || job.providerPreempted;
		const errors = result?.errors;
		const failed = aborted || (errors?.size ?? 0) > 0;
		const outcome: CatalogRefreshOutcome = {
			...(aborted ? { aborted: true } : {}),
			...(errors ? { errors } : {}),
			// 失败或取消不能沿用快照里的联网成功；摘要也只用于成功结果。
			networkSucceeded: failed ? false : snapshot.networkSucceeded,
			...(!failed && snapshot.summary ? { summary: snapshot.summary } : {}),
		};
		resolveWaiters(job, outcome);
		// force 在普通任务启动 GET 前排队；若该轮最终确实联网成功，
		// 同一轮已满足强制语义；联网失败也交付同一错误，不自动再 GET。
		if (job.kind !== "restore" && (outcome.networkSucceeded || (snapshot.networkAttempted && !aborted)) &&
			pendingNetwork?.kind === "force") {
			const merged = pendingNetwork;
			pendingNetwork = undefined;
			merged.finalized = true;
			resolveWaiters(merged, outcome);
		}
		pump();
	};

	const failJob = (job: CatalogJob, error: unknown): void => {
		if (job.finalized || job.generation !== generation) return;
		job.finalized = true;
		if (running === job) running = undefined;
		clearQueued(job);
		// run 抛错原样透传；协调器不包装凭据、地址或响应内容。
		rejectWaiters(job, error instanceof Error ? error : new Error(String(error)));
		pump();
	};

	const startJob = (job: CatalogJob): void => {
		if (job.finalized || job.generation !== generation || job.waiters.size === 0) return;
		running = job;
		const execute = async (): Promise<void> => {
			let runPromise: Promise<CatalogRefreshRunResult | void>;
			try {
				options.begin();
				// begin 内若已 stop，则不再启动旧任务。
				if (job.finalized || job.generation !== generation) return;
				runPromise = Promise.resolve(job.run(job.controller.signal));
			} catch (error) {
				failJob(job, error);
				return;
			}

			let abortCleanup: (() => void) | undefined;
			const abortPromise = new Promise<"aborted">(resolve => {
				if (job.controller.signal.aborted) {
					resolve("aborted");
					return;
				}
				const onAbort = (): void => { resolve("aborted"); };
				job.controller.signal.addEventListener("abort", onAbort, { once: true });
				abortCleanup = () => job.controller.signal.removeEventListener("abort", onAbort);
			});
			// 把 run 的 rejection 立即转成已处理的 race 分支，避免迟到 rejection 未处理。
			const runSettled = runPromise.then(
				value => ({ type: "result" as const, value }),
				error => ({ type: "error" as const, error }),
			);
			let raced: { type: "result"; value: CatalogRefreshRunResult | void } |
				{ type: "error"; error: unknown } | "aborted";
			try {
				raced = await Promise.race([runSettled, abortPromise]);
			} finally {
				abortCleanup?.();
			}

			if (job.finalized || job.generation !== generation) return;
			if (raced === "aborted") {
				// 正常路径下 abortJob 已清理；此处兜底外部直接取消 controller 的情况。
				abortJob(job, cancelledError());
			} else if (raced.type === "error") {
				failJob(job, raced.error);
			} else {
				finishJob(job, raced.value);
			}
		};
		// run 本身及最终清理都不能演变成未处理的顶层 rejection。
		void execute().catch(error => { failJob(job, error); });
	};

	function pump(): void {
		if (running || settling > 0) return;
		for (;;) {
			const next = pendingNetwork ?? pendingRestore;
			if (!next) return;
			if (next === pendingNetwork) pendingNetwork = undefined;
			else pendingRestore = undefined;
			if (next.finalized || next.waiters.size === 0) continue;
			startJob(next);
			return;
		}
	}

	const targetFor = (kind: CatalogRefreshKind, run: CatalogRefreshRun): CatalogJob | undefined => {
		if (kind === "restore") {
			// restore 只与本地 restore 合并，绝不借用联网任务的结果。
			if (running?.kind === "restore" && !running.finalized) return running;
			return pendingRestore && !pendingRestore.finalized ? pendingRestore : undefined;
		}
		if (running?.kind === "force" && !running.finalized) return running;
		if (running?.kind === "normal" && !running.finalized) {
			if (kind === "normal") return running;
			if (options.canShareNetwork?.()) {
				running.kind = "force";
				return running;
			}
		}
		const queued = pendingNetwork;
		if (queued && !queued.finalized) {
			if (kind === "force" && queued.kind === "normal") {
				// 排队中的普通刷新被强制刷新提升；既有 waiter 也必须使用新的 force run。
				queued.kind = "force";
				queued.run = run;
			}
			return queued;
		}
		return undefined;
	};

	function request(
		kind: CatalogRefreshKind,
		run: CatalogRefreshRun,
		signal?: AbortSignal,
	): Promise<CatalogRefreshOutcome> {
		// 已在请求前取消时不得占用队列、begin 或 inspect。
		if (signal?.aborted) return Promise.reject(cancelledError());

		const existing = targetFor(kind, run);
		const job: CatalogJob = existing ?? {
			kind,
			run,
			controller: new AbortController(),
			waiters: new Set(),
			providerCallbackSeen: false,
			providerPreempted: false,
			observedSignals: new Set(),
			snapshotCaptured: false,
			finalized: false,
			generation,
		};
		if (!existing) {
			if (kind === "restore") pendingRestore = job;
			else pendingNetwork = job;
		}

		const promise = new Promise<CatalogRefreshOutcome>((resolve, reject) => {
			const waiter: Waiter = { signal, resolve, reject, done: false };
			job.waiters.add(waiter);
			if (signal) {
				waiter.onAbort = () => {
					if (waiter.done) return;
					waiter.done = true;
					removeWaiterListener(waiter);
					job.waiters.delete(waiter);
					waiter.reject(cancelledError());
					// 一个 waiter 取消不影响其他 waiter；只有清空后才取消共享 job。
					if (job.waiters.size === 0) abortJob(job, cancelledError());
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
		});
		// 新 waiter 已挂好后再启动，避免同步 run/stop 让返回的 Promise 永远悬空。
		pump();
		return promise;
	}

	/**
	 * provider 执行端：只直接执行，绝不再次 request，否则会等待自己造成死锁。
	 *
	 * 归属边界：首个 provider 回调前，无法判断它属于当前 job 还是外部
	 * runtime.refresh 抢占，这是本模块不可消除的剩余边界。首个回调按 active
	 * job 兼容；同一宿主 signal 视为同一 job 的两个阶段；不同 signal 始终
	 * 视为外部调用，不继承旧 controller，也不改变本 job 的强制意图和取消状态。
	 * 仅首个 signal 已取消时标记旧 job aborted。旧宿主无 signal 时仍支持 stop。
	 */
	function provider(
		context: CatalogRefreshContext,
		execute: (context: CatalogRefreshContext) => Promise<ProviderModelConfig[]>,
	): Promise<ProviderModelConfig[]> {
		const job = running && !running.finalized ? running : undefined;
		if (context.signal?.aborted) {
			if (job && (!job.providerCallbackSeen || context.signal === job.firstProviderSignal))
				job.observedSignals.add(context.signal);
			return Promise.reject(cancelledError());
		}
		if (!job) return execute(context);
		const hostSignal = context.signal;
		const first = job.firstProviderSignal;
		if (job.providerCallbackSeen && hostSignal && hostSignal !== first) {
			// 宿主 availability 等尾部工作可能仍未结束；不同 signal 也不能借用
			// 旧 job 的 controller/force，否则双方的取消和刷新意图会互相污染。
			if (first?.aborted) job.providerPreempted = true;
			return execute(context);
		}
		// 普通刷新尚未作出缓存决定时，后来的 force 提升本轮网络阶段。
		if (context.allowNetwork && (job.kind === "force" || pendingNetwork?.kind === "force"))
			context = { ...context, force: true };

		if (!job.providerCallbackSeen) {
			job.providerCallbackSeen = true;
			if (hostSignal) job.firstProviderSignal = hostSignal;
		}
		if (hostSignal) job.observedSignals.add(hostSignal);

		// registry 的代际取消只决定宿主是否接收 publication，不代表所有共享
		// 调用方都取消实际 GET。插件任务由自己的 controller 管生命周期。
		return execute({ ...context, signal: job.controller.signal });
	}

	/** 释放当前队列并递增代际；不设永久禁用标记，session_start 后可继续 request。 */
	function stop(): void {
		generation++;
		const jobs = new Set<CatalogJob>();
		if (running) jobs.add(running);
		if (pendingNetwork) jobs.add(pendingNetwork);
		if (pendingRestore) jobs.add(pendingRestore);
		running = undefined;
		pendingNetwork = undefined;
		pendingRestore = undefined;
		for (const job of jobs) {
			job.finalized = true;
			job.controller.abort();
			rejectWaiters(job, cancelledError());
		}
	}

	return { request, provider, stop };
}
