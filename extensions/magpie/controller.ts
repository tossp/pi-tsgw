import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeRoot, PROVIDER_ID } from "#tsgw/models/catalog";
import { gatewayModelCacheScope } from "#tsgw/models/gateway-catalog";
import type { GatewayCatalogService } from "#tsgw/models/gateway-catalog-service";
import { getMagpieService, type MagpieRequest, type MagpieService } from "./service.ts";
import { chooseRefresh, showStatus, showCards, unchangedReadTimes } from "./ui.ts";
import { quotaSummary } from "./summary.ts";

const STATUS = "查看 Magpie 状态";
const CARDS = "查看 Magpie 额度";
const RELOAD = "重新读取卡片";
const REFRESH = "刷新上游额度";

export function registerMagpie(pi: ExtensionAPI, options: {
	root: string;
	gateway: () => GatewayCatalogService | undefined;
	onChange: () => void;
}) {
	let lifetime = new AbortController();
	let subscribed: MagpieService | undefined;
	let unsubscribe: (() => void) | undefined;
	let watched: GatewayCatalogService | undefined;
	let stopCatalog: (() => void) | undefined;
	let hidden: GatewayCatalogService | undefined;
	let userRun = false;
	let availableUI = false;
	const clear = (catalog: GatewayCatalogService) => { hidden = catalog; options.onChange(); };
	const release = () => {
		unsubscribe?.(); unsubscribe = undefined; subscribed = undefined;
		stopCatalog?.(); stopCatalog = undefined; watched = undefined;
	};
	function currentService(): MagpieService | undefined {
		const catalog = options.gateway();
		if (!availableUI || lifetime.signal.aborted || !catalog?.valid() || hidden === catalog) {
			release();
			return;
		}
		if (watched !== catalog) {
			release();
			watched = catalog;
			stopCatalog = catalog.subscribe(options.onChange);
		}
		if (!catalog.isMagpie()) {
			unsubscribe?.(); unsubscribe = undefined; subscribed = undefined;
			return;
		}
		const service = getMagpieService(catalog);
		if (subscribed !== service) {
			unsubscribe?.();
			subscribed = service;
			unsubscribe = service.subscribe(options.onChange);
		}
		return service;
	}

	async function connect(registry: ExtensionContext["modelRegistry"], signal: AbortSignal):
		Promise<{ service: MagpieService; request: MagpieRequest } | undefined> {
		const catalog = options.gateway();
		if (!catalog?.isMagpie() || !catalog.valid() || signal.aborted) return;
		if (typeof registry.getProviderAuth !== "function") {
			clear(catalog);
			throw new Error("当前宿主未提供 Magpie 查询所需的认证接口。请使用支持 getProviderAuth 的 Pi 版本。");
		}
		let auth;
		try { auth = (await registry.getProviderAuth(PROVIDER_ID))?.auth; }
		catch { clear(catalog); throw new Error("Magpie 认证解析失败，请检查宿主登录状态。"); }
		if (signal.aborted || !catalog.valid() || !catalog.isMagpie()) return;
		if (!auth?.apiKey) { clear(catalog); throw new Error("Magpie 查询需要已配置的 TSGW 密钥，请先通过 /login 配置。"); }
		let root: string;
		try { root = normalizeRoot(auth.baseUrl ?? options.root); }
		catch { clear(catalog); throw new Error("宿主提供的 Magpie 地址不可用。"); }
		if (root !== options.root || gatewayModelCacheScope(root, auth.apiKey) !== catalog.scope) {
			clear(catalog);
			throw new Error("TSGW 地址或凭据已变化，请先刷新模型目录确认当前网关身份。");
		}
		const headers = new Headers({ Authorization: `Bearer ${auth.apiKey}`, Accept: "application/json" });
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (value === null) headers.delete(name);
			else if (value !== undefined) headers.set(name, value);
		}
		hidden = undefined;
		const service = currentService();
		if (!service) return;
		return { service, request: { root, headers } };
	}

	pi.on("session_start", (_event, ctx) => {
		lifetime.abort();
		lifetime = new AbortController();
		userRun = false;
		availableUI = ctx.hasUI;
	});
	pi.on("session_shutdown", () => { lifetime.abort(); userRun = false; availableUI = false; release(); });
	pi.on("before_agent_start", (event) => { userRun = event.messageType === "user"; });
	pi.on("model_select", () => {
		lifetime.abort();
		lifetime = new AbortController();
		options.onChange();
	});
	// agent_end 之后宿主可能继续重试；settled 才表示本次任务不会自动续跑。
	pi.on("agent_settled", (event, ctx) => {
		const normal = userRun;
		userRun = false;
		if (!normal || event.aborted || !availableUI || ctx.model?.provider !== PROVIDER_ID || !options.gateway()?.isMagpie()) return;
		try { if (normalizeRoot(ctx.model.baseUrl) !== options.root) return; } catch { return; }
		const registry = ctx.modelRegistry;
		const signal = lifetime.signal;
		void connect(registry, signal).then(async connection => {
			if (!connection) return;
			await connection.service.readCards(connection.request, { automatic: true, signal });
			if (!signal.aborted) options.onChange();
		}).catch(() => { if (!signal.aborted) options.onChange(); });
	});

	return {
		choices: () => options.gateway()?.isMagpie() ? [STATUS, CARDS, RELOAD, REFRESH] : [],
		label(): string | undefined {
			const service = currentService();
			if (!service) return;
			const snapshot = service.cards();
			if (!snapshot.data) return;
			const summary = quotaSummary(snapshot.data);
			if (!summary) return;
			return snapshot.error ? `${summary}（旧）` : summary;
		},
		async handle(choice: string, ctx: ExtensionCommandContext): Promise<void> {
			if (![STATUS, CARDS, RELOAD, REFRESH].includes(choice) || !ctx.hasUI) return;
			const ui = ctx.ui;
			const id = ctx.sessionManager.getSessionId();
			const registry = ctx.modelRegistry;
			const signal = lifetime.signal;
			try {
				const connection = await connect(registry, signal);
				if (!connection) return;
				const { service, request } = connection;
				if (choice === STATUS) {
					const snapshot = await service.readStatus(id, request, { force: true, signal });
					if (signal.aborted || !service.valid()) return;
					options.onChange();
					await showStatus(ui, snapshot, signal);
					return;
				}
				let snapshot = await service.readCards(request, { force: choice === RELOAD, signal });
				if (signal.aborted || !service.valid()) return;
				if (choice === REFRESH) {
					if (snapshot.status === 401 || snapshot.status === 403) {
						ui.notify(snapshot.error!, "error");
						return;
					}
					const selection = await chooseRefresh(ui, snapshot.data ?? [], signal);
					if (!selection || signal.aborted || !service.valid()) return;
					const before = snapshot.data;
					snapshot = await service.refreshCards(request, selection.target, signal);
					if (signal.aborted || !service.valid()) return;
					if (!snapshot.error) ui.notify(unchangedReadTimes(before, snapshot.data)
						? "刷新请求已返回，读数时间未变化或未提供。" : "刷新请求已返回，请核对各卡片读数时间。", "info");
				}
				await showCards(ui, snapshot, signal);
			} catch (error) {
				if (!signal.aborted) ui.notify(error instanceof Error ? error.message : "Magpie 操作失败。", "error");
			}
		},
	};
}
