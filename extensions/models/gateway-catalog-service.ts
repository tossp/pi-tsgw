import { resolve } from "node:path";
import { createGatewayCatalogRecovery } from "./gateway-catalog-recovery.ts";
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

interface FetchTask {
	controller: AbortController;
	force: boolean;
	networkStarted: boolean;
	cacheSelected: boolean;
	waiters: number;
	promise: Promise<GatewayCatalogOutcome>;
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

/** 原始目录的共享服务，不保存 UI、过滤配置、宿主 context 或常驻明文密钥。 */
function createService(root: string, scope: string, cacheFilePath: string) {
	let valid = true;
	let snapshot: GatewayCatalogSnapshot | undefined;
	let task: FetchTask | undefined;
	const recovery = createGatewayCatalogRecovery({ onIdle: () => {
		if (task?.waiters === 0 && !task.cacheSelected) task.controller.abort();
	} });

	const check = (key: string): void => {
		if (!valid || gatewayModelCacheScope(root, key) !== scope) throw catalogCancelledError();
	};
	const read = (key: string): GatewayCatalogSnapshot | undefined => {
		check(key);
		const local = getCachedGatewayModelIds(root, key, { cacheFilePath });
		if (local && (!snapshot || local.storedAt > snapshot.storedAt))
			snapshot = { ids: [...local.ids], storedAt: local.storedAt, source: "cache" };
		return snapshot ? copy(snapshot) : undefined;
	};
	const currentOutcome = (networkAttempted: boolean, networkSucceeded: boolean,
		failed = false, retryable = true): GatewayCatalogOutcome => ({
		...(snapshot ? { snapshot: copy(snapshot) } : {}),
		networkAttempted, networkSucceeded, failed, retryable,
	});

	const api = {
		scope,
		valid: () => valid,
		read,
		fetching: () => !!task?.networkStarted && !task.controller.signal.aborted,
		refreshKind: () => task && !task.controller.signal.aborted ? (task.force ? "force" : "normal") : undefined,
		summary(minimumStoredAt = 0, applied = snapshot) {
			if (!valid || !applied) return undefined;
			const result = readGatewayModelCacheSummary(cacheFilePath, minimumStoredAt, scope, applied.ids);
			return result?.storedAt === applied.storedAt ? result : undefined;
		},
		invalidate() {
			valid = false;
			recovery.stop();
			task?.controller.abort();
			task = undefined;
			snapshot = undefined;
		},
		/** 后台通过仍活跃实例的宿主服务发起单次获取，联网许可和凭据仍交宿主。 */
		recoverUsing(run: (signal: AbortSignal) => Promise<GatewayCatalogOutcome>, signal?: AbortSignal): Promise<GatewayCatalogOutcome> {
			if (!valid) return Promise.reject(catalogCancelledError());
			return recovery.join(run, () => currentOutcome(false, false, true), signal).then(outcome => {
				if (!valid || signal?.aborted) throw catalogCancelledError();
				return outcome;
			});
		},
		peek: () => snapshot ? copy(snapshot) : undefined,
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
			if (task?.controller.signal.aborted) task = undefined;
			if (task?.cacheSelected && options.force) {
				// 缓存决定已经完成；这次 force 不能被旧缓存结果吞掉。
				return task.promise.then(() => api.request(key, options));
			}
			if (task) {
				task.force ||= options.force === true;
				return waitForTask(task, options.signal, () => valid, recovery.hasParticipants);
			}
			const controller = new AbortController();
			const active: FetchTask = { controller, force: options.force === true,
				networkStarted: false, cacheSelected: false, waiters: 0, promise: Promise.resolve(currentOutcome(false, false)) };
			task = active;
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
				if (!valid || task !== active || controller.signal.aborted) throw catalogCancelledError();
				if (!result.ok || result.stale) {
					read(key);
					const code = result.ok ? result.fallbackStatus : result.status;
					return currentOutcome(true, false, true, code !== 401 && code !== 403);
				}
				if (!snapshot || result.storedAt >= snapshot.storedAt)
					snapshot = { ids: [...result.ids], storedAt: result.storedAt, source: result.cached ? "cache" : "network" };
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
				if (task === active) task = undefined;
			});
			return waitForTask(active, options.signal, () => valid, recovery.hasParticipants);
		},
	};
	return api;
}

export type GatewayCatalogService = ReturnType<typeof createService>;

interface ServiceRegistry {
	version: 4;
	/** 每个 agent-dir 的唯一缓存路径一个当前槽，不按密钥维护多个目录。 */
	slots: Map<string, GatewayCatalogService>;
}

const REGISTRY = Symbol.for("pi-tsgw:gateway-catalog");

/** 跨工厂调用与 jiti 重导入复用；不同 agent-dir 仅作宿主存储边界隔离。 */
export function getGatewayCatalogService(root: string, key: string, cacheFilePath: string): GatewayCatalogService {
	const globals = globalThis as typeof globalThis & { [REGISTRY]?: ServiceRegistry };
	let registry = globals[REGISTRY];
	if (registry && registry.version !== 4) throw new Error("TSGW 目录共享状态版本不兼容，请重启宿主。");
	registry ??= globals[REGISTRY] = { version: 4, slots: new Map() };
	const path = resolve(cacheFilePath);
	const scope = gatewayModelCacheScope(root, key);
	let service = registry.slots.get(path);
	if (!service || service.scope !== scope || !service.valid()) {
		service?.invalidate();
		service = createService(root, scope, path);
		registry.slots.set(path, service);
	}
	return service;
}
