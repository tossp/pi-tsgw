import { resolve } from "node:path";
import { createGatewayCatalogRecovery } from "./gateway-catalog-recovery.ts";
import { getGatewayCatalogRegistry, type GatewayCatalogState, type CatalogFetchTask as FetchTask } from "./gateway-catalog-shared.ts";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
	gatewayModelCacheScope,
	getCachedGatewayModelIds,
	getGatewayModelIds,
	readGatewayModelCacheSummary,
	type ModelCacheEntry,
} from "./gateway-catalog.ts";

export interface GatewayCatalogSnapshot extends ModelCacheEntry {
	source: "cache" | "network";
}

export interface GatewayCatalogOutcome {
	snapshot?: GatewayCatalogSnapshot;
	networkAttempted: boolean;
	networkSucceeded: boolean;
	retryable: boolean;
	failed: boolean;
}

export function catalogCancelledError(): Error {
	const error = new Error("TSGW 模型目录获取已取消。");
	error.name = "AbortError";
	return error;
}

const copy = (entry: GatewayCatalogSnapshot): GatewayCatalogSnapshot => ({ ...entry, ids: [...entry.ids] });
const fresh = (entry: ModelCacheEntry): boolean =>
	Math.max(0, Date.now() - entry.storedAt) < DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS;

/** 等待者独立取消；不把某个宿主回调的 signal 作为整个进程的获取信号。 */
function waitForTask(task: FetchTask, signal: AbortSignal | undefined, valid: () => boolean,
	keepAlive: () => boolean): Promise<GatewayCatalogOutcome> {
	task.waiters++;
	return new Promise((resolve, reject) => {
		let done = false;
		const finish = (): boolean => {
			if (done) return false;
			done = true;
			signal?.removeEventListener("abort", abort);
			task.waiters--;
			return true;
		};
		const abort = (): void => {
			if (!finish()) return;
			if (task.waiters === 0 && !task.cacheSelected && !keepAlive()) task.controller.abort();
			reject(catalogCancelledError());
		};
		task.promise.then(
			result => {
				if (!finish()) return;
				if (task.controller.signal.aborted || !valid()) reject(catalogCancelledError());
				else resolve({ ...result, ...(result.snapshot ? { snapshot: copy(result.snapshot) } : {}) });
			},
			error => { if (finish()) reject(error); },
		);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

/** 当前模块的方法包装共享状态，不保存 UI、过滤配置、宿主 context 或常驻明文密钥。 */
function createService(root: string, cacheFilePath: string, state: GatewayCatalogState) {
	const { scope } = state;
	const changed = () => { for (const listener of state.listeners) listener(); };
	const recovery = createGatewayCatalogRecovery({ state: state.recovery, onIdle: () => {
		if (state.task?.waiters === 0 && !state.task.cacheSelected) state.task.controller.abort();
	} });

	const check = (key: string): void => {
		if (!state.valid || gatewayModelCacheScope(root, key) !== scope) throw catalogCancelledError();
	};
	const read = (key: string): GatewayCatalogSnapshot | undefined => {
		check(key);
		const local = getCachedGatewayModelIds(root, key, { cacheFilePath });
		if (local && (!state.snapshot || local.storedAt > state.snapshot.storedAt)) {
			state.snapshot = { ids: [...local.ids], storedAt: local.storedAt, source: "cache",
				...(local.magpie ? { magpie: local.magpie } : {}) };
			changed();
		}
		return state.snapshot ? copy(state.snapshot) : undefined;
	};
	const currentOutcome = (networkAttempted: boolean, networkSucceeded: boolean,
		failed = false, retryable = true): GatewayCatalogOutcome => ({
		...(state.snapshot ? { snapshot: copy(state.snapshot) } : {}),
		networkAttempted, networkSucceeded, failed, retryable,
	});

	const api = {
		scope,
		/** 方法包装可更新，额度共享始终关联这一份稳定状态。 */
		identity: state as object,
		subscribe(listener: () => void): () => void {
			state.listeners.add(listener);
			return () => { state.listeners.delete(listener); };
		},
		valid: () => state.valid,
		isMagpie: () => state.valid && state.snapshot?.magpie === true,
		read,
		fetching: () => !!state.task?.networkStarted && !state.task.controller.signal.aborted,
		refreshKind: () => state.task && !state.task.controller.signal.aborted ? (state.task.force ? "force" : "normal") : undefined,
		summary(minimumStoredAt = 0, applied = state.snapshot) {
			if (!state.valid || !applied) return undefined;
			const result = readGatewayModelCacheSummary(cacheFilePath, minimumStoredAt, scope, applied.ids);
			return result?.storedAt === applied.storedAt ? result : undefined;
		},
		invalidate() {
			state.valid = false;
			recovery.stop();
			state.task?.controller.abort();
			state.task = undefined;
			state.snapshot = undefined;
			changed();
			state.listeners.clear();
		},
		/** 后台通过仍活跃实例的宿主服务发起单次获取，联网许可和凭据仍交宿主。 */
		recoverUsing(run: (signal: AbortSignal) => Promise<GatewayCatalogOutcome>, signal?: AbortSignal): Promise<GatewayCatalogOutcome> {
			if (!state.valid) return Promise.reject(catalogCancelledError());
			return recovery.join(run, () => currentOutcome(false, false, true), signal).then(outcome => {
				if (!state.valid || signal?.aborted) throw catalogCancelledError();
				return outcome;
			});
		},
		peek: () => state.snapshot ? copy(state.snapshot) : undefined,
		recover(key: string, signal?: AbortSignal): Promise<GatewayCatalogOutcome> {
			try { check(key); } catch (error) { return Promise.reject(error); }
			return recovery.join(
				input => api.request(key, { allowNetwork: true, signal: input }),
				() => currentOutcome(false, false, true), signal,
			).then(outcome => { check(key); if (signal?.aborted) throw catalogCancelledError(); return outcome; });
		},
		request(key: string, options: { force?: boolean; allowNetwork: boolean; signal?: AbortSignal }): Promise<GatewayCatalogOutcome> {
			if (options.signal?.aborted) return Promise.reject(catalogCancelledError());
			try { check(key); } catch (error) { return Promise.reject(error); }
			// 本地读取不加入联网任务，不延迟启动，也绝不取消已有 GET。
			if (!options.allowNetwork) {
				read(key);
				return Promise.resolve(currentOutcome(false, false));
			}
			if (state.task?.controller.signal.aborted) state.task = undefined;
			if (state.task?.cacheSelected && options.force) {
				// 缓存决定已经完成；这次 force 不能被旧缓存结果吞掉。
				return state.task.promise.then(() => api.request(key, options));
			}
			if (state.task) {
				state.task.force ||= options.force === true;
				return waitForTask(state.task, options.signal, () => state.valid, recovery.hasParticipants);
			}
			const controller = new AbortController();
			const active: FetchTask = { controller, force: options.force === true,
				networkStarted: false, cacheSelected: false, waiters: 0, promise: Promise.resolve(currentOutcome(false, false)) };
			state.task = active;
			// 微任务内才决定缓存/网络，使同批 force 能提升尚未决策的 normal。
			const execute = Promise.resolve().then(async () => {
				controller.signal.throwIfAborted();
				const cached = read(key);
				if (!active.force && cached && fresh(cached)) {
					active.cacheSelected = true;
					return currentOutcome(false, false);
				}
				active.networkStarted = true;
				const result = await getGatewayModelIds(root, key, {
					cacheFilePath, force: true, signal: controller.signal,
				});
				if (!state.valid || state.task !== active || controller.signal.aborted) throw catalogCancelledError();
				if (!result.ok || result.stale) {
					read(key);
					const code = result.ok ? result.fallbackStatus : result.status;
					return currentOutcome(true, false, true, code !== 401 && code !== 403);
				}
				if (!state.snapshot || result.storedAt >= state.snapshot.storedAt) {
					state.snapshot = { ids: [...result.ids], storedAt: result.storedAt, source: result.cached ? "cache" : "network",
						...(result.magpie ? { magpie: result.magpie } : {}) };
					changed();
				}
				return currentOutcome(true, !result.cached);
			});
			// 即使底层忽略取消，取消仍立即释放共享槽；迟到结果不能提交。
			let onAbort: (() => void) | undefined;
			const aborted = new Promise<never>((_, reject) => {
				onAbort = () => { reject(catalogCancelledError()); };
				controller.signal.addEventListener("abort", onAbort, { once: true });
			});
			active.promise = Promise.race([execute, aborted]).finally(() => {
				if (onAbort) controller.signal.removeEventListener("abort", onAbort);
				if (state.task === active) state.task = undefined;
			});
			return waitForTask(active, options.signal, () => state.valid, recovery.hasParticipants);
		},
	};
	return api;
}

export type GatewayCatalogService = ReturnType<typeof createService>;

const services = new WeakMap<GatewayCatalogState, GatewayCatalogService>();

/** 当前模块复用自己的方法包装；跨重导入共用稳定状态与实际 GET。 */
export function getGatewayCatalogService(root: string, key: string, cacheFilePath: string): GatewayCatalogService {
	const registry = getGatewayCatalogRegistry();
	const path = resolve(cacheFilePath);
	const scope = gatewayModelCacheScope(root, key);
	let state = registry.slots.get(path);
	if (!state || state.scope !== scope || !state.valid) {
		if (state) {
			let previous = services.get(state);
			previous ??= createService(root, path, state);
			previous.invalidate();
		}
		state = { scope, valid: true, listeners: new Set(), recovery: {} };
		registry.slots.set(path, state);
	}
	let service = services.get(state);
	if (!service) services.set(state, service = createService(root, path, state));
	return service;
}
