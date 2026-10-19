import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { effectiveModelsForGateway, type ModelFilter } from "#tsgw/models/catalog";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS } from "#tsgw/models/gateway-catalog";
import {
	catalogCancelledError,
	getGatewayCatalogService,
	type GatewayCatalogService,
	type GatewayCatalogSnapshot,
	type GatewayCatalogOutcome,
} from "#tsgw/models/gateway-catalog-service";
import type { CatalogStatus } from "./status.ts";

export interface CatalogRefreshContext {
	allowNetwork: boolean;
	force?: boolean;
	credential?: { type: string; key?: string };
	signal?: AbortSignal;
}

export interface CatalogSummary {
	cacheFilePath: string;
	count: number;
	storedAt: number;
}

export function catalogFailureMessage(hasCache: boolean): string {
	return hasCache
		? "TSGW 模型目录获取失败，正在沿用缓存。可运行 /tsgw-refresh 重试。"
		: "TSGW 模型目录获取失败，当前无可用模型。请运行 /tsgw-refresh 重试。";
}

/** 实例只管理投影与自身等待者；实际目录、GET 和取消引用计数由进程共享服务管理。 */
export function createCatalogState(options: {
	root: string;
	filter: ModelFilter;
	cacheFilePath: string;
	imagesEnabled: boolean;
	classifiersEnabled: boolean;
	initialKey?: string;
	onChange(): void;
}) {
	const { root, filter, cacheFilePath, imagesEnabled, classifiersEnabled } = options;
	let models: ProviderModelConfig[] = [];
	let status: CatalogStatus = { count: 0, source: "empty", loading: false };
	let snapshot: GatewayCatalogSnapshot | undefined;
	let service: GatewayCatalogService | undefined;
	let networkEnabled = false;
	let revision = 0;
	let retryable = true;
	let networkAttempted = false;
	let networkSucceeded = false;
	const waiting = new Set<AbortController>();

	const apply = (entry: GatewayCatalogSnapshot): void => {
		snapshot = entry;
		models = effectiveModelsForGateway(root, filter, new Set(entry.ids), imagesEnabled, classifiersEnabled);
		status = { count: models.length, source: entry.source, storedAt: entry.storedAt, loading: waiting.size > 0 };
	};
	if (options.initialKey) {
		service = getGatewayCatalogService(root, options.initialKey, cacheFilePath);
		const cached = service.read(options.initialKey);
		if (cached) apply({ ...cached, source: "cache" });
	}

	const invalidate = (): void => {
		revision++;
		for (const controller of waiting) controller.abort();
		waiting.clear();
		retryable = true;
		networkAttempted = false;
		networkSucceeded = false;
		if (status.loading) {
			status = { ...status, loading: false };
			options.onChange();
		}
	};

	return {
		models: () => models,
		status: () => status,
		outcome(failed = false): GatewayCatalogOutcome {
			return { ...(service?.peek() ? { snapshot: service.peek() } : {}),
				networkAttempted, networkSucceeded, failed, retryable };
		},
		matches(entry?: GatewayCatalogSnapshot): boolean {
			const current = snapshot;
			return !!entry && !!current && entry.storedAt === current.storedAt &&
				entry.ids.length === current.ids.length && entry.ids.every((id, index) => id === current.ids[index]);
		},
		recoverUsing(run: (signal: AbortSignal) => Promise<GatewayCatalogOutcome>, signal?: AbortSignal) {
			if (!service) return Promise.reject(catalogCancelledError());
			return service.recoverUsing(run, signal);
		},
		finishRecovery(outcome: GatewayCatalogOutcome): void {
			networkAttempted = outcome.networkAttempted;
			networkSucceeded = outcome.networkSucceeded;
			// 共享轮次已耗尽或认证失败后，不由实例再启动另一轮重试。
			retryable = !outcome.failed && outcome.retryable;
		},
		retryable: () => retryable,
		networkAttempted: () => networkAttempted,
		networkSucceeded: () => networkSucceeded,
		fetching: () => service?.fetching() ?? false,
		refreshKind: () => service?.refreshKind(),
		beginRefresh() { networkAttempted = service?.fetching() ?? false; networkSucceeded = false; },
		needsRefresh: () => !snapshot || Math.max(0, Date.now() - snapshot.storedAt) >= DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
		enableNetwork() { networkEnabled = true; },
		stop() { networkEnabled = false; invalidate(); },
		invalidate,
		fail() {
			status = { ...status, loading: waiting.size > 0, error: catalogFailureMessage(!!snapshot) };
			options.onChange();
			return status.error!;
		},
		summary(minimumStoredAt = 0): CatalogSummary | undefined {
			if (!snapshot) return undefined;
			const result = service?.summary(minimumStoredAt, snapshot);
			return result?.storedAt === snapshot.storedAt && result.count === snapshot.ids.length ? result : undefined;
		},
		async refresh(context: CatalogRefreshContext): Promise<ProviderModelConfig[]> {
			context.signal?.throwIfAborted();
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const canFetch = context.allowNetwork && (networkEnabled || context.force === true);
			if (!key) {
				if (!canFetch) return models;
				retryable = false;
				throw new Error("TSGW 模型目录获取失败：请先通过 /login 配置 API 密钥。");
			}
			const selected = getGatewayCatalogService(root, key, cacheFilePath);
			if (service !== selected) {
				invalidate();
				service = selected;
				snapshot = undefined;
				models = [];
				status = { count: 0, source: "empty", loading: false };
			}
			const current = revision;
			const controller = new AbortController();
			const abort = (): void => { controller.abort(); };
			context.signal?.addEventListener("abort", abort, { once: true });
			if (canFetch) {
				waiting.add(controller);
				status = { ...status, loading: true };
			}
			try {
				const pending = selected.request(key, { allowNetwork: canFetch, force: context.force, signal: controller.signal });
				options.onChange();
				const result = await pending;
				if (current !== revision || controller.signal.aborted) throw catalogCancelledError();
				if (result.snapshot && (!snapshot || result.snapshot.storedAt >= snapshot.storedAt)) apply(result.snapshot);
				// 本地阶段不清除另一个正在进行的联网阶段的结果。
				if (canFetch) {
					networkAttempted = result.networkAttempted;
					networkSucceeded = result.networkSucceeded;
					retryable = result.retryable;
				}
				if (result.failed) throw new Error(catalogFailureMessage(!!snapshot));
				return models;
			} catch {
				if (current === revision) status = { ...status,
					error: controller.signal.aborted ? (status.error ?? "获取已取消，保留原目录") : catalogFailureMessage(!!snapshot) };
				throw new Error(controller.signal.aborted ? "TSGW 模型目录获取已取消。" : catalogFailureMessage(!!snapshot));
			} finally {
				context.signal?.removeEventListener("abort", abort);
				waiting.delete(controller);
				if (current === revision) {
					status = { ...status, loading: waiting.size > 0 };
					options.onChange();
				}
			}
		},
	};
}

export type CatalogState = ReturnType<typeof createCatalogState>;
