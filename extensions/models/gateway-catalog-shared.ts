import type { FetchGatewayModelIdsResult, ModelCacheEntry } from "./gateway-catalog.ts";
import type { GatewayCatalogOutcome, GatewayCatalogSnapshot } from "./gateway-catalog-service.ts";
import type { GatewayCatalogRecoveryState } from "./gateway-catalog-recovery.ts";

export interface CatalogFetchTask {
	controller: AbortController;
	force: boolean;
	networkStarted: boolean;
	cacheSelected: boolean;
	waiters: number;
	promise: Promise<GatewayCatalogOutcome>;
}

export interface GatewayCatalogState {
	scope: string;
	valid: boolean;
	snapshot?: GatewayCatalogSnapshot;
	task?: CatalogFetchTask;
	listeners: Set<() => void>;
	recovery: GatewayCatalogRecoveryState;
}

interface CacheRequest {
	promise: Promise<FetchGatewayModelIdsResult>;
	revision: number;
	storedAt: number;
}

interface GatewayCatalogRegistry {
	/** 目录与额度共用的核心契约标记；仅不兼容变更时改变，执行方法与可选字段不参与。 */
	schema: 1;
	/** 每条规范化缓存路径只持有一个当前网关身份；会话退出不清空其他实例的数据。 */
	slots: Map<string, GatewayCatalogState>;
	cache: {
		entries: Map<string, ModelCacheEntry>;
		inFlight: Map<string, CacheRequest>;
		latest: Map<string, number>;
		latestDisk: Map<string, number>;
		revision: number;
	};
}

const REGISTRY = Symbol.for("pi-tsgw:gateway-catalog");

/** 跨重导入只保留数据与在途协调记录，服务方法由当前模块创建。 */
export function getGatewayCatalogRegistry(): GatewayCatalogRegistry {
	const globals = globalThis as typeof globalThis & { [REGISTRY]?: GatewayCatalogRegistry };
	const existing = globals[REGISTRY];
	if (existing && existing.schema !== 1)
		throw new Error("TSGW 共享数据契约不兼容，请重启宿主以统一状态。");
	return globals[REGISTRY] ??= {
		schema: 1,
		slots: new Map(),
		cache: { entries: new Map(), inFlight: new Map(), latest: new Map(), latestDisk: new Map(), revision: 0 },
	};
}
