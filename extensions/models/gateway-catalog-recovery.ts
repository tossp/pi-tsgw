import type { GatewayCatalogOutcome } from "./gateway-catalog-service.ts";

export const CATALOG_RECOVERY_WINDOW_MS = 60_000;
export const CATALOG_RECOVERY_DELAY_MS = 5_000;

function cancelled(): Error {
	const error = new Error("TSGW 模型目录获取已取消。");
	error.name = "AbortError";
	return error;
}

interface RecoveryParticipant {
	request(signal: AbortSignal): Promise<GatewayCatalogOutcome>;
}

interface RecoveryRound {
	controller: AbortController;
	waiters: number;
	participants: Set<RecoveryParticipant>;
	promise: Promise<GatewayCatalogOutcome>;
}

/** 进程共享服务内的一轮恢复；新加入者不延长截止，手动获取不触发重试。 */
export function createGatewayCatalogRecovery(options: { onIdle?(): void } = {}) {
	let active: RecoveryRound | undefined;
	return {
		stop() { active?.controller.abort(); active = undefined; options.onIdle?.(); },
		hasParticipants: () => !!active && !active.controller.signal.aborted && active.waiters > 0,
		join(
			request: (signal: AbortSignal) => Promise<GatewayCatalogOutcome>,
			fallback: () => GatewayCatalogOutcome,
			signal?: AbortSignal,
		): Promise<GatewayCatalogOutcome> {
			if (signal?.aborted) return Promise.reject(cancelled());
			if (active?.controller.signal.aborted) active = undefined;
			if (!active) {
				const round: RecoveryRound = { controller: new AbortController(), waiters: 0, participants: new Set(),
					promise: Promise.resolve({ networkAttempted: false, networkSucceeded: false, failed: true, retryable: true }) };
				active = round;
				let deadline: ReturnType<typeof setTimeout> | undefined;
				let wake: ReturnType<typeof setTimeout> | undefined;
				let cancelWait: (() => void) | undefined;
				let deadlineReached = false;
				let abort!: () => void;
				const end = new Promise<GatewayCatalogOutcome>((resolve, reject) => {
					abort = () => {
						options.onIdle?.();
						if (!deadlineReached) reject(cancelled());
					};
					round.controller.signal.addEventListener("abort", abort, { once: true });
					deadline = setTimeout(() => {
						deadlineReached = true;
						try { resolve({ ...fallback(), failed: true }); }
						catch { resolve({ networkAttempted: false, networkSucceeded: false, failed: true, retryable: true }); }
						finally { round.controller.abort(); }
					}, CATALOG_RECOVERY_WINDOW_MS);
					deadline.unref?.();
				});
				const wait = (): Promise<void> => new Promise(resolve => {
					cancelWait = resolve;
					wake = setTimeout(() => { cancelWait = undefined; resolve(); }, CATALOG_RECOVERY_DELAY_MS);
					wake.unref?.();
				});
				const run = Promise.resolve().then(async () => {
					while (!round.controller.signal.aborted) {
						try {
							const participant = round.participants.values().next().value;
							if (!participant) throw cancelled();
							const outcome = await participant.request(round.controller.signal);
							if (!outcome.failed || !outcome.retryable) return outcome;
						} catch {
							// 不外传获取器原始异常；取消立即结束，其他异常在本轮短间隔重试。
							if (round.controller.signal.aborted) throw cancelled();
						}
						if (round.controller.signal.aborted) throw cancelled();
						await wait();
					}
					throw cancelled();
				});
				round.promise = Promise.race([run, end]).finally(() => {
					clearTimeout(deadline);
					clearTimeout(wake);
					cancelWait?.();
					round.controller.signal.removeEventListener("abort", abort);
					if (active === round) { active = undefined; options.onIdle?.(); }
				});
			}
			const round = active;
			const participant = { request };
			round.participants.add(participant);
			round.waiters++;
			return new Promise((resolve, reject) => {
				let done = false;
				const finish = (): boolean => {
					if (done) return false;
					done = true;
					signal?.removeEventListener("abort", abort);
					round.waiters--;
					round.participants.delete(participant);
					return true;
				};
				const abort = (): void => {
					if (!finish()) return;
					if (round.waiters === 0) round.controller.abort();
					reject(cancelled());
				};
				round.promise.then(
					outcome => {
						if (finish()) resolve({ ...outcome, ...(outcome.snapshot ? {
							snapshot: { ...outcome.snapshot, ids: [...outcome.snapshot.ids] },
						} : {}) });
					},
					error => { if (finish()) reject(error); },
				);
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		},
	};
}
