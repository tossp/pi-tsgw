export const DEFAULT_GATEWAY_MODEL_TIMEOUT_MS = 5_000;
export const DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS = 5 * 60 * 1_000;

export type GatewayModelFailureReason =
	| "http"
	| "timeout"
	| "network"
	| "invalid-json"
	| "invalid-data"
	| "empty";

export type GatewayFetch = (
	input: string | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface FetchGatewayModelIdsOptions {
	timeoutMs?: number;
	fetcher?: GatewayFetch;
}

export type FetchGatewayModelIdsResult =
	| { ok: true; ids: string[] }
	| {
			ok: false;
			reason: GatewayModelFailureReason;
			status?: number;
			detail?: string;
	  };

export interface ModelCacheEntry {
	ids: string[];
	storedAt: number;
}

export interface ModelCache {
	get(): ModelCacheEntry | undefined;
	set(ids: readonly string[], now?: number): void;
	isFresh(now?: number): boolean;
}

export type GetGatewayModelIdsResult =
	| {
			ok: true;
			ids: string[];
			cached: boolean;
			stale: boolean;
			fallbackReason?: GatewayModelFailureReason;
	  }
	| Extract<FetchGatewayModelIdsResult, { ok: false }>;

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function modelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/v1/models`;
}

function uniqueModelIds(data: unknown[]): string[] {
	const ids = new Set<string>();
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const id = (item as { id?: unknown }).id;
		if (typeof id === "string" && id.trim()) ids.add(id.trim());
	}
	return Array.from(ids);
}

/** Load the OpenAI-compatible model list exposed by a gateway. */
export async function fetchGatewayModelIds(
	baseUrl: string,
	apiKey: string,
	opts: FetchGatewayModelIdsOptions = {},
): Promise<FetchGatewayModelIdsResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATEWAY_MODEL_TIMEOUT_MS;
	const fetcher = opts.fetcher ?? globalThis.fetch;
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, Math.max(0, timeoutMs));

	try {
		let response: Response;
		try {
			response = await fetcher(modelsUrl(baseUrl), {
				method: "GET",
				headers: { authorization: `Bearer ${apiKey}` },
				signal: controller.signal,
			});
		} catch (error) {
			return timedOut
				? { ok: false, reason: "timeout" }
				: { ok: false, reason: "network", detail: errorDetail(error) };
		}

		if (!response.ok) {
			return { ok: false, reason: "http", status: response.status };
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			return timedOut
				? { ok: false, reason: "timeout" }
				: { ok: false, reason: "invalid-json", detail: errorDetail(error) };
		}

		if (!payload || typeof payload !== "object")
			return { ok: false, reason: "invalid-data" };
		const data = (payload as { data?: unknown }).data;
		if (!Array.isArray(data)) return { ok: false, reason: "invalid-data" };
		const ids = uniqueModelIds(data);
		if (ids.length === 0) return { ok: false, reason: "empty" };
		return { ok: true, ids };
	} finally {
		clearTimeout(timeout);
	}
}

/** Create a defensive, in-memory TTL cache for a gateway model list. */
export function createModelCache(
	ttlMs = DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
): ModelCache {
	if (!Number.isFinite(ttlMs) || ttlMs < 0)
		throw new RangeError("ttlMs must be a non-negative finite number");
	let entry: ModelCacheEntry | undefined;

	return {
		get() {
			return entry ? { ids: [...entry.ids], storedAt: entry.storedAt } : undefined;
		},
		set(ids, now = Date.now()) {
			entry = { ids: [...ids], storedAt: now };
		},
		isFresh(now = Date.now()) {
			if (!entry) return false;
			return Math.max(0, now - entry.storedAt) < ttlMs;
		},
	};
}

const gatewayCaches = new Map<string, ModelCache>();
const inFlightRequests = new Map<string, Promise<FetchGatewayModelIdsResult>>();

function cacheFor(baseUrl: string): ModelCache {
	const key = baseUrl.replace(/\/+$/, "");
	let cache = gatewayCaches.get(key);
	if (!cache) {
		cache = createModelCache();
		gatewayCaches.set(key, cache);
	}
	return cache;
}

/**
 * Load gateway model IDs with a five-minute process cache.
 *
 * Fresh cache entries are returned without I/O. A failed refresh falls back
 * to a stale entry when available; otherwise the fetch failure is returned.
 */
export async function getGatewayModelIds(
	baseUrl: string,
	apiKey: string,
	opts: FetchGatewayModelIdsOptions = {},
	now = Date.now(),
): Promise<GetGatewayModelIdsResult> {
	const key = baseUrl.replace(/\/+$/, "");
	const cache = cacheFor(key);
	if (cache.isFresh(now)) {
		const entry = cache.get();
		if (entry)
			return { ok: true, ids: entry.ids, cached: true, stale: false };
	}

	let request = inFlightRequests.get(key);
	if (!request) {
		request = fetchGatewayModelIds(key, apiKey, opts);
		inFlightRequests.set(key, request);
	}

	let fetched: FetchGatewayModelIdsResult;
	try {
		fetched = await request;
	} finally {
		if (inFlightRequests.get(key) === request) inFlightRequests.delete(key);
	}

	if (fetched.ok) {
		cache.set(fetched.ids, now);
		return { ok: true, ids: [...fetched.ids], cached: false, stale: false };
	}

	const stale = cache.get();
	if (stale) {
		return {
			ok: true,
			ids: stale.ids,
			cached: true,
			stale: true,
			fallbackReason: fetched.reason,
		};
	}
	return fetched;
}
