import type { GatewayCatalogService } from "#tsgw/models/gateway-catalog-service";
import { parseCards, parseStatusline, type MagpieCard, type MagpieStatusline } from "./data.ts";

export interface MagpieRequest {
	root: string;
	headers: Headers;
}
export interface MagpieSnapshot<T> {
	data?: T;
	fetchedAt?: number;
	error?: string;
	status?: number;
}
export interface RefreshTarget { provider: string; user?: string }
interface Task<T> {
	controller: AbortController;
	waiters: number;
	promise: Promise<MagpieSnapshot<T>>;
}
interface Resource<T> {
	snapshot: MagpieSnapshot<T>;
	attemptedAt?: number;
	blocked?: boolean;
	task?: Task<T>;
}
const TTL = 60_000;
const resource = <T>(): Resource<T> => ({ snapshot: {} });

/** 只共享同一目录作用域的内存读数，不保存宿主上下文或常驻明文凭据。 */
export function createMagpieService(catalog: Pick<GatewayCatalogService, "valid" | "isMagpie">,
	fetcher: typeof fetch = (...args) => globalThis.fetch(...args), now = Date.now) {
	const cards = resource<MagpieCard[]>();
	const listeners = new Set<() => void>();
	const sessions = new Map<string, Resource<MagpieStatusline>>();
	let statusBlocked = false;
	let refresh: { target?: RefreshTarget; task: Task<MagpieCard[]> } | undefined;
	let cardsRevision = 0;
	const valid = () => catalog.valid() && catalog.isMagpie();
	const session = (id: string) => {
		let state = sessions.get(id);
		if (!state) sessions.set(id, state = resource());
		return state;
	};

	function start<T>(state: Resource<T>, request: MagpieRequest, path: string,
		parse: (value: unknown) => T, method: "GET" | "POST", canCommit = () => true): Task<T> {
		const controller = new AbortController();
		const task: Task<T> = { controller, waiters: 0, promise: Promise.resolve(state.snapshot) };
		state.attemptedAt = now();
		task.promise = (async () => {
			let timedOut = false;
			const timer = setTimeout(() => { timedOut = true; controller.abort(); }, method === "POST" ? 35_000 : 5_000);
			let status: number | undefined;
			let result: MagpieSnapshot<T>;
			try {
				const response = await fetcher(`${request.root}/v1/magpie/${path}`, {
					method, headers: request.headers, signal: controller.signal, redirect: "error",
				});
				status = response.status;
				if (!response.ok) throw new Error();
				const data = parse(await response.json());
				result = { data, fetchedAt: now() };
			} catch {
				const hidden = status === 401 || status === 403;
				result = { ...(hidden ? {} : state.snapshot), status,
					error: status && status >= 200 && status < 300 ? "Magpie 返回的数据无法解析，保留已有读数。"
						: status ? `Magpie 查询失败（HTTP ${status}）。` : "Magpie 查询失败或超时，保留已有读数。" };
			} finally { clearTimeout(timer); }
			if (!valid()) return {};
			if ((controller.signal.aborted && !timedOut) || !canCommit()) return state.snapshot;
			state.snapshot = result;
			state.blocked = status === 401 || status === 403 || status === 404 || status === 405;
			if (state === cards) for (const listener of listeners) listener();
			return result;
		})().finally(() => { if (state.task === task) state.task = undefined; });
		state.task = task;
		return task;
	}

	return {
		valid,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		status: (id: string): MagpieSnapshot<MagpieStatusline> => valid() ? session(id).snapshot : {},
		cards: (): MagpieSnapshot<MagpieCard[]> => valid() ? cards.snapshot : {},
		async readStatus(id: string, request: MagpieRequest,
			options: { force?: boolean; automatic?: boolean; signal?: AbortSignal } = {}): Promise<MagpieSnapshot<MagpieStatusline>> {
			if (!valid() || options.signal?.aborted) return {};
			const state = session(id);
			if (state.task?.controller.signal.aborted) state.task = undefined;
			if (state.task) return wait(state.task, options.signal);
			if (options.automatic && (statusBlocked ||
				(state.attemptedAt !== undefined && now() - state.attemptedAt < TTL))) return state.snapshot;
			if (!options.force && state.snapshot.fetchedAt !== undefined && now() - state.snapshot.fetchedAt < TTL)
				return state.snapshot;
			const task = start(state, request, `statusline?format=json&session=${encodeURIComponent(id)}`, parseStatusline, "GET");
			const result = await wait(task, options.signal);
			statusBlocked = state.blocked === true;
			if (result.status === 401 || result.status === 403)
				for (const other of sessions.values()) other.snapshot = { error: result.error, status: result.status };
			return result;
		},
		readCards(request: MagpieRequest, options: { force?: boolean; automatic?: boolean; signal?: AbortSignal } = {}): Promise<MagpieSnapshot<MagpieCard[]>> {
			if (!valid() || options.signal?.aborted) return Promise.resolve({});
			if (refresh?.task.controller.signal.aborted) refresh = undefined;
			if (cards.task?.controller.signal.aborted) cards.task = undefined;
			if (refresh) return wait(refresh.task, options.signal);
			if (cards.task) return wait(cards.task, options.signal);
			if (options.automatic && (cards.blocked ||
				(cards.attemptedAt !== undefined && now() - cards.attemptedAt < TTL))) return Promise.resolve(cards.snapshot);
			if (!options.force && cards.snapshot.fetchedAt !== undefined && now() - cards.snapshot.fetchedAt < TTL)
				return Promise.resolve(cards.snapshot);
			const revision = cardsRevision;
			return wait(start(cards, request, "quotas/cards", parseCards, "GET", () => revision === cardsRevision), options.signal);
		},
		refreshCards(request: MagpieRequest, target?: RefreshTarget, signal?: AbortSignal): Promise<MagpieSnapshot<MagpieCard[]>> {
			if (!valid() || signal?.aborted) return Promise.resolve({});
			if (refresh?.task.controller.signal.aborted) refresh = undefined;
			if (refresh) {
				const current = refresh.target;
				if (!current || (target && current.provider === target.provider &&
					(!current.user || current.user.toLowerCase() === target.user?.toLowerCase()))) return wait(refresh.task, signal);
				return Promise.resolve({ ...cards.snapshot, error: "另一范围的额度刷新正在进行，请完成后再操作。" });
			}
			cardsRevision++;
			const query = new URLSearchParams();
			if (target) {
				query.set("provider", target.provider);
				if (target.user) query.set("user", target.user);
			}
			const task = start(cards, request, `quotas/refresh${query.size ? `?${query}` : ""}`, parseCards, "POST");
			refresh = { target, task };
			void task.promise.finally(() => { if (refresh?.task === task) refresh = undefined; });
			return wait(task, signal);
		},
	};
}

function wait<T>(task: Task<T>, signal?: AbortSignal): Promise<MagpieSnapshot<T>> {
	task.waiters++;
	return new Promise((resolve) => {
		let done = false;
		const finish = (result: MagpieSnapshot<T>) => {
			if (done) return;
			done = true;
			signal?.removeEventListener("abort", abort);
			task.waiters--;
			resolve(result);
		};
		const abort = () => {
			finish({});
			if (task.waiters === 0) task.controller.abort();
		};
		task.promise.then(finish, () => finish({ error: "Magpie 查询失败。" }));
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

export type MagpieService = ReturnType<typeof createMagpieService>;
const SHARED = Symbol.for("pi-tsgw:magpie-state");
/** 用目录服务对象本身作为作用域，沿用其跨工厂和凭据切换失效语义。 */
export function getMagpieService(catalog: GatewayCatalogService): MagpieService {
	const globals = globalThis as typeof globalThis & { [SHARED]?: WeakMap<GatewayCatalogService, MagpieService> };
	const services = globals[SHARED] ??= new WeakMap();
	let service = services.get(catalog);
	if (!service) services.set(catalog, service = createMagpieService(catalog));
	return service;
}
