import { createHash, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_GATEWAY_MODEL_TIMEOUT_MS = 5_000;
export const DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS = 5 * 60 * 1_000;

export type GatewayModelFailureReason =
	| "http"
	| "timeout"
	| "aborted"
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
	signal?: AbortSignal;
}

export interface GetGatewayModelIdsOptions extends FetchGatewayModelIdsOptions {
	cacheFilePath?: string;
	force?: boolean;
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

export interface LoadedGatewayModelCache {
	ids: string[];
	fresh: boolean;
}

export type GetGatewayModelIdsResult =
	| {
			ok: true;
			ids: string[];
			cached: boolean;
			stale: boolean;
			storedAt: number;
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

/** 加载网关提供的 OpenAI 兼容模型列表。 */
export async function fetchGatewayModelIds(
	baseUrl: string,
	apiKey: string,
	opts: FetchGatewayModelIdsOptions = {},
): Promise<FetchGatewayModelIdsResult> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GATEWAY_MODEL_TIMEOUT_MS;
	const fetcher = opts.fetcher ?? globalThis.fetch;
	if (opts.signal?.aborted) return { ok: false, reason: "aborted" };

	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = (): void => controller.abort(opts.signal?.reason);
	opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(
		() => {
			timedOut = true;
			controller.abort();
		},
		Math.max(0, timeoutMs),
	);

	try {
		let response: Response;
		try {
			response = await fetcher(modelsUrl(baseUrl), {
				method: "GET",
				headers: { authorization: `Bearer ${apiKey}` },
				signal: controller.signal,
			});
		} catch (error) {
			if (timedOut) return { ok: false, reason: "timeout" };
			if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
			return { ok: false, reason: "network", detail: errorDetail(error) };
		}

		if (timedOut) return { ok: false, reason: "timeout" };
		if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
		if (!response.ok) {
			return { ok: false, reason: "http", status: response.status };
		}

		let payload: unknown;
		try {
			payload = await response.json();
		} catch (error) {
			if (timedOut) return { ok: false, reason: "timeout" };
			if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
			return { ok: false, reason: "invalid-json", detail: errorDetail(error) };
		}

		if (timedOut) return { ok: false, reason: "timeout" };
		if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
		if (!payload || typeof payload !== "object")
			return { ok: false, reason: "invalid-data" };
		const data = (payload as { data?: unknown }).data;
		if (!Array.isArray(data)) return { ok: false, reason: "invalid-data" };
		const ids = uniqueModelIds(data);
		if (ids.length === 0) return { ok: false, reason: "empty" };
		return { ok: true, ids };
	} finally {
		clearTimeout(timeout);
		opts.signal?.removeEventListener("abort", abortFromCaller);
	}
}

/** 为网关模型列表创建带有效期和防御性复制的内存缓存。 */
export function createModelCache(
	ttlMs = DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
): ModelCache {
	if (!Number.isFinite(ttlMs) || ttlMs < 0)
		throw new RangeError("ttlMs 必须是非负有限数值");
	let entry: ModelCacheEntry | undefined;

	return {
		get() {
			return entry
				? { ids: [...entry.ids], storedAt: entry.storedAt }
				: undefined;
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

/** 对两个身份组成部分一起计算哈希；缓存键和文件中不保存明文凭据。 */
export function gatewayModelCacheScope(baseUrl: string, apiKey: string): string {
	return createHash("sha256")
		.update(JSON.stringify([baseUrl.replace(/\/+$/, ""), apiKey]))
		.digest("hex");
}

function readGatewayModelCacheEntry(
	filePath: string,
	scope: string,
): ModelCacheEntry | undefined {
	try {
		const payload: unknown = JSON.parse(readFileSync(filePath, "utf8"));
		if (!payload || typeof payload !== "object") return undefined;
		const { storedAt, ids, scope: storedScope } = payload as {
			scope?: unknown;
			storedAt?: unknown;
			ids?: unknown;
		};
		if (
			!scope || storedScope !== scope ||
			typeof storedAt !== "number" ||
			!Number.isFinite(storedAt) ||
			storedAt < 0 ||
			!Array.isArray(ids) ||
			!ids.every((id) => typeof id === "string" && id.trim())
		)
			return undefined;
		return {
			storedAt,
			ids: Array.from(new Set(ids.map((id) => id.trim()))),
		};
	} catch {
		return undefined;
	}
}

function isCacheEntryFresh(
	entry: ModelCacheEntry,
	now: number,
	ttlMs: number,
): boolean {
	return Math.max(0, now - entry.storedAt) < ttlMs;
}

/** 原子持久化网关模型 ID；写入失败不影响主流程。 */
export function saveGatewayModelCache(
	filePath: string,
	scope: string,
	ids: readonly string[],
	now = Date.now(),
): void {
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		mkdirSync(dirname(filePath), { recursive: true });
		writeFileSync(
			temporaryPath,
			JSON.stringify({ scope, storedAt: now, ids: [...ids] }),
			{ encoding: "utf8", mode: 0o600 },
		);
		renameSync(temporaryPath, filePath);
	} catch {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// 临时文件可能尚未创建。
		}
	}
}

/** 加载持久化的网关模型列表；忽略缺失或无效的文件。 */
export function loadGatewayModelCache(
	filePath: string,
	scope: string,
	now = Date.now(),
	ttlMs = DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS,
): LoadedGatewayModelCache | undefined {
	if (!Number.isFinite(ttlMs) || ttlMs < 0)
		throw new RangeError("ttlMs 必须是非负有限数值");
	const entry = readGatewayModelCacheEntry(filePath, scope);
	if (!entry) return undefined;
	return {
		ids: [...entry.ids],
		fresh: isCacheEntryFresh(entry, now, ttlMs),
	};
}

const gatewayCaches = new Map<string, ModelCache>();
interface PendingRequest {
	promise: Promise<FetchGatewayModelIdsResult>;
	revision: number;
	storedAt: number;
}
const inFlightRequests = new Map<string, PendingRequest>();
const latestRequests = new Map<string, number>();
// 每个规范化路径仅有一个磁盘缓存槽，与内存缓存作用域相互独立。
const latestDiskRequests = new Map<string, number>();
let revision = 0;

function cacheFor(key: string): ModelCache {
	let cache = gatewayCaches.get(key);
	if (!cache) {
		cache = createModelCache();
		gatewayCaches.set(key, cache);
	}
	return cache;
}

/**
 * 加载网关模型 ID，使用有效期为五分钟的进程内缓存。
 *
 * 缓存未过期时直接返回，不进行输入输出。刷新失败时，若有过期缓存则回退使用；
 * 否则返回获取失败的结果。
 */
export async function getGatewayModelIds(
	baseUrl: string,
	apiKey: string,
	opts: GetGatewayModelIdsOptions = {},
	now = Date.now(),
): Promise<GetGatewayModelIdsResult> {
	if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
	const key = gatewayModelCacheScope(baseUrl, apiKey);
	const cache = cacheFor(key);
	if (!opts.force && cache.isFresh(now)) {
		const entry = cache.get();
		if (entry)
			return {
				ok: true,
				ids: entry.ids,
				cached: true,
				stale: false,
				storedAt: entry.storedAt,
			};
	}

	const diskEntry = opts.cacheFilePath
		? readGatewayModelCacheEntry(opts.cacheFilePath, key)
		: undefined;
	if (
		!opts.force &&
		diskEntry &&
		isCacheEntryFresh(diskEntry, now, DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS)
	) {
		cache.set(diskEntry.ids, diskEntry.storedAt);
		return {
			ok: true,
			ids: [...diskEntry.ids],
			storedAt: diskEntry.storedAt,
			cached: true,
			stale: false,
		};
	}

	const requestKey = `${key}\0${opts.force ? "force" : "normal"}`;
	// 共享请求无法安全地继承某个调用者的 AbortSignal：较新的调用者仍在等待时，
	// Pi 可能已替换该次刷新。只有不带信号的调用共享进行中的请求；
	// 可取消的调用独立发起获取请求。
	const shareRequest = opts.signal === undefined;
	let request = shareRequest ? inFlightRequests.get(requestKey) : undefined;
	if (!request) {
		const requestRevision = ++revision;
		latestRequests.set(key, requestRevision);
		request = {
			revision: requestRevision,
			storedAt: now,
			promise: fetchGatewayModelIds(baseUrl, apiKey, {
				fetcher: opts.fetcher,
				timeoutMs: opts.timeoutMs,
				signal: opts.signal,
			}),
		};
		if (shareRequest) inFlightRequests.set(requestKey, request);
	}

	const diskPath = opts.cacheFilePath ? resolve(opts.cacheFilePath) : undefined;
	if (diskPath) {
		// 登记每个订阅者的路径，包括目标路径不同的共享请求。
		// 加入较旧请求时，不得回退较新的版本屏障。
		latestDiskRequests.set(diskPath, Math.max(
			latestDiskRequests.get(diskPath) ?? 0, request.revision,
		));
	}

	let fetched: FetchGatewayModelIdsResult;
	try {
		fetched = await request.promise;
	} finally {
		if (shareRequest && inFlightRequests.get(requestKey) === request)
			inFlightRequests.delete(requestKey);
	}

	// 取消后绝不回退或写入，即使获取器忽略了取消信号。
	if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
	if (fetched.ok) {
		// 以后启动的请求为准，即使较新的请求失败或取消。
		// 被取代的成功请求仍向调用者返回结果，但不写入缓存。
		if (latestRequests.get(key) === request.revision) {
			cache.set(fetched.ids, request.storedAt);
			if (diskPath && latestDiskRequests.get(diskPath) === request.revision)
				saveGatewayModelCache(diskPath, key, fetched.ids, request.storedAt);
		}
		return {
			ok: true,
			ids: [...fetched.ids],
			cached: false,
			stale: false,
			storedAt: request.storedAt,
		};
	}

	const memoryEntry = cache.get();
	const stale =
		memoryEntry && diskEntry
			? memoryEntry.storedAt >= diskEntry.storedAt
				? memoryEntry
				: diskEntry
			: (memoryEntry ?? diskEntry);
	if (stale) {
		return {
			ok: true,
			ids: stale.ids,
			storedAt: stale.storedAt,
			cached: true,
			stale: true,
			fallbackReason: fetched.reason,
		};
	}
	return fetched;
}
