import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	readStoredCredential,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	DEFAULT_ROOT,
	PROVIDER_ID,
	filterModels,
	modelsForRoot,
	normalizeRoot,
	type ModelFilter,
} from "./models/catalog.ts";
import { getGatewayModelIds } from "./models/gateway-catalog.ts";
import { applyModelOperations } from "./models/operations.ts";
import { builtinSearchSupport } from "./models/web-search.ts";
import {
	catalogLabel,
	catalogDiagnostics,
	searchLabel,
	type CatalogStatus,
} from "./status.ts";
import type { ThinkingLevel, WebSearchMode } from "./models/_tools.ts";

/**
 * The data needed by provider hooks, copied while the lifecycle context is
 * fresh. Keep this structural: stale runners may invoke those hooks later.
 */
interface RequestState {
	provider: string;
	modelId: string;
	api: string;
	baseUrl: string;
	thinkingLevel: ThinkingLevel;
}

interface RequestModel {
	provider: string;
	id: string;
	api: string;
	baseUrl: string;
}

/**
 * Extension configuration from the `tsgw` namespace of the Pi settings file
 * (settings.json). All plugin configuration lives here; the plugin reads no
 * environment variables (only Pi's own credential resolution handles keys).
 */
interface TsgwSettings {
	baseUrl?: string;
	tsSearch?: string;
	traceHeaders?: boolean;
	includeModels?: string[];
	excludeModels?: string[];
}

function readTsgwSettings(): TsgwSettings {
	try {
		const raw: unknown = JSON.parse(
			readFileSync(join(getAgentDir(), "settings.json"), "utf8"),
		);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw))
			return {};
		const tsgw = (raw as { tsgw?: unknown }).tsgw;
		if (tsgw === null || typeof tsgw !== "object" || Array.isArray(tsgw))
			return {};
		return tsgw as TsgwSettings;
	} catch {
		return {};
	}
}

function rootForRuntime(configured: string | undefined): string {
	try {
		return normalizeRoot(configured);
	} catch {
		console.error("TSGW: invalid baseUrl; using the default root.");
		return DEFAULT_ROOT;
	}
}

function hasHeader(
	headers: Record<string, string | null>,
	name: string,
): boolean {
	return Object.keys(headers).some(
		(key) => key.toLowerCase() === name.toLowerCase(),
	);
}

function requestStateFor(
	model: RequestModel | undefined,
	thinkingLevel: ThinkingLevel,
): RequestState | undefined {
	if (!model) return undefined;
	return {
		provider: model.provider,
		modelId: model.id,
		api: model.api,
		baseUrl: model.baseUrl,
		thinkingLevel,
	};
}

function isTsgwTraceTarget(state: RequestState, root: string): boolean {
	if (state.provider !== PROVIDER_ID) return false;
	try {
		// Only trace requests that target the configured gateway root, so a
		// model whose baseUrl was overridden elsewhere never gets trace headers.
		return new URL(state.baseUrl).hostname === new URL(root).hostname;
	} catch {
		return false;
	}
}

/** 网关 id 匹配：精确匹配，或允许带供应商前缀变体（google/gemini-3.5-flash 匹配 gemini-3.5-flash）。 */
function gatewayHasModel(gatewayIds: ReadonlySet<string>, id: string): boolean {
	if (gatewayIds.has(id)) return true;
	const suffix = `/${id}`;
	for (const gatewayId of gatewayIds)
		if (gatewayId.endsWith(suffix)) return true;
	return false;
}

/** 模型缓存文件：<agent-dir>/tsgw/models-cache.json。 */
function gatewayModelCachePath(): string {
	return join(getAgentDir(), "tsgw", "models-cache.json");
}

function effectiveModelsForGateway(
	root: string,
	filter: ModelFilter | undefined,
	gatewayIds: ReadonlySet<string> | undefined,
): ReturnType<typeof modelsForRoot> {
	const staticModels = modelsForRoot(root);
	const intersected = gatewayIds
		? staticModels.filter((model) => gatewayHasModel(gatewayIds, model.id))
		: staticModels;
	return filterModels(intersected, filter);
}

/**
 * 三层模型过滤：静态目录 ∩ 网关实际列表 ∩ 用户黑白名单。
 * 网关列表拉取失败/无凭据时跳过网关层（回退静态目录）。
 */
async function resolveEffectiveModels(
	root: string,
	filter: ModelFilter | undefined,
	cacheFilePath: string,
): Promise<{
	models: ReturnType<typeof modelsForRoot>;
	gatewayIds: ReadonlySet<string> | undefined;
	catalog: CatalogStatus;
}> {
	// 凭据解析失败不阻塞：无凭据时直接跳过网关层。
	let apiKey = "";
	try {
		const credential = readStoredCredential(PROVIDER_ID);
		apiKey = credential?.type === "api_key" ? (credential.key ?? "") : "";
	} catch {
		apiKey = "";
	}

	let gatewayIds: ReadonlySet<string> | undefined;
	let catalog: CatalogStatus = { count: 0, source: "static", loading: false };
	if (apiKey) {
		try {
			const gateway = await getGatewayModelIds(root, apiKey, {
				cacheFilePath,
			});
			if (gateway.ok) {
				gatewayIds = new Set(gateway.ids);
				catalog = {
					...catalog,
					source: gateway.cached ? "cache" : "network",
					storedAt: gateway.storedAt,
					error: gateway.stale
						? `刷新失败（${gateway.fallbackReason ?? "unknown"}），沿用旧目录` : undefined,
				};
			} else catalog.error = `目录获取失败（${gateway.reason}），使用内置目录`;
		} catch {
			catalog.error = "目录获取失败，使用内置目录";
		}
	}
	if (catalog.error) console.warn(`TSGW: ${catalog.error}`);
	const models = effectiveModelsForGateway(root, filter, gatewayIds);
	return { models, gatewayIds, catalog: { ...catalog, count: models.length } };
}

export default async function registerTsgw(pi: ExtensionAPI): Promise<void> {
	const settings = readTsgwSettings();
	const root = rootForRuntime(settings.baseUrl);
	const defaultSearchMode: WebSearchMode =
		settings.tsSearch === "cached" || settings.tsSearch === "live"
			? settings.tsSearch
			: "live";
	let tsSearchMode = defaultSearchMode;
	const traceEnabled = settings.traceHeaders === true;
	const modelFilter: ModelFilter = {
		include: settings.includeModels,
		exclude: settings.excludeModels,
	};
	const cacheFilePath = gatewayModelCachePath();
	let requestState: RequestState | undefined;

	const refreshRequestState = (ctx: {
		model: RequestModel | undefined;
		thinkingLevel?: ThinkingLevel;
	}): void => {
		requestState = requestStateFor(ctx.model, ctx.thinkingLevel ?? "off");
	};

	// 三层模型过滤：静态目录 ∩ 网关实际列表 ∩ 用户黑白名单。
	const initial = await resolveEffectiveModels(
		root,
		modelFilter,
		cacheFilePath,
	);
	const { models } = initial;
	let latestModels = models;
	let catalog = initial.catalog;
	let credentialConfigured = false;
	let publishStatus: (() => void) | undefined;
	let refreshRevision = 0;
	let lifecycleRevision = 0;
	const rootConfigured = root !== DEFAULT_ROOT;
	const searchSupport = () => requestState?.provider === PROVIDER_ID
		? builtinSearchSupport(requestState.modelId, requestState.api) : undefined;
	// Retain only the UI sink, never a lifecycle context; disconnect on shutdown.
	const bindStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) {
			publishStatus = undefined;
			return;
		}
		credentialConfigured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
		const ui = ctx.ui;
		publishStatus = () => {
			ui.setStatus("command:/tsgw",
				catalogLabel(catalog, credentialConfigured, rootConfigured));
			ui.setStatus("command:/tsgw-search",
				requestState?.provider === PROVIDER_ID
					? searchLabel(tsSearchMode, searchSupport()) : undefined);
		};
		publishStatus();
	};
	pi.registerProvider(PROVIDER_ID, {
		name: "TSGW",
		baseUrl: `${root}/v1`,
		api: "openai-completions",
		apiKey: "$TSGW_API_KEY",
		models,
		async refreshModels(context) {
			if (!context.allowNetwork) return latestModels;
			context.signal.throwIfAborted();
			const revision = ++refreshRevision;
			catalog = { ...catalog, loading: true };
			publishStatus?.();
			try {
				const credential = context.credential;
				credentialConfigured = credential?.type === "api_key" && !!credential.key;
				if (credential?.type !== "api_key" || !credential.key)
					throw new Error("TSGW API key is unavailable for model refresh.");
				const gateway = await getGatewayModelIds(root, credential.key, {
					cacheFilePath,
					force: context.force === true,
					signal: context.signal,
				});
				context.signal.throwIfAborted();
				if (!gateway.ok)
					throw new Error(`TSGW gateway model refresh failed (${gateway.reason}).`);
				if (gateway.stale)
					throw new Error("TSGW refresh failed; keeping the last successful catalog.");
				if (revision === refreshRevision) {
					latestModels = effectiveModelsForGateway(root, modelFilter, new Set(gateway.ids));
					catalog = {
						count: latestModels.length,
						source: gateway.cached ? "cache" : "network",
						storedAt: gateway.storedAt,
						loading: false,
					};
				}
				return latestModels;
			} catch (error) {
				if (revision === refreshRevision) catalog = {
					...catalog,
					loading: false,
					error: context.signal.aborted
						? "刷新已取消，保留原目录" : "刷新失败，保留原目录；请检查凭据、网关与网络",
				};
				throw error;
			} finally {
				if (revision === refreshRevision) publishStatus?.();
			}
		},
	});

	let refreshPending = false;
	const refreshCatalog = async (ctx: ExtensionCommandContext): Promise<void> => {
		if (refreshPending) return;
		refreshPending = true;
		const lifecycle = lifecycleRevision;
		let revision = refreshRevision;
		// Provider callbacks own their state; only diagnose failures before one starts.
		const recordFailure = (message: string): void => {
			if (revision === refreshRevision && !catalog.loading) {
				catalog.error = message;
				publishStatus?.();
			}
		};
		try {
			await ctx.waitForIdle();
			if (lifecycle !== lifecycleRevision) return;
			bindStatus(ctx);
			if (!ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured) {
				ctx.ui.notify("TSGW model refresh skipped: configure an API key with /login first.", "warning");
				return;
			}
			const count = () => ctx.modelRegistry.getAvailable()
				.filter((model) => model.provider === PROVIDER_ID).length;
			const before = count();
			revision = refreshRevision;
			// Older Pi versions return void instead of cancellation/error metadata.
			const result = (await ctx.modelRegistry.refresh({
				providers: [PROVIDER_ID], force: true,
			})) as { aborted?: boolean; errors?: ReadonlyMap<string, Error> } | undefined;
			if (lifecycle !== lifecycleRevision) return;
			const after = count();
			if (result?.aborted) {
				recordFailure("刷新已取消，保留原目录");
				ctx.ui.notify(`TSGW model refresh cancelled (${before} → ${after}).`, "warning");
			} else if (result?.errors?.has(PROVIDER_ID)) {
				recordFailure("刷新失败，保留原目录；请检查凭据、网关与网络");
				ctx.ui.notify(`TSGW model refresh failed (${before} → ${after}).`, "error");
			} else {
				ctx.ui.notify(`TSGW models refreshed (${before} → ${after}).`, "info");
			}
		} catch {
			if (lifecycle !== lifecycleRevision) return;
			recordFailure("刷新失败，保留原目录；请检查凭据、网关与网络");
			ctx.ui.notify("TSGW model refresh failed; keeping the previous catalog.", "error");
		} finally {
			if (lifecycle === lifecycleRevision) refreshPending = false;
		}
	};
	pi.registerCommand("tsgw-refresh", {
		description: "Force-refresh the TSGW gateway model catalog",
		handler: async (_args, ctx) => refreshCatalog(ctx),
	});
	pi.registerCommand("tsgw", {
		description: "TSGW model catalog and configuration diagnostics",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const lifecycle = lifecycleRevision;
			bindStatus(ctx);
			const choice = await ctx.ui.select("TSGW", ["刷新模型目录", "查看状态与诊断"]);
			if (lifecycle !== lifecycleRevision) return;
			if (choice === "刷新模型目录") await refreshCatalog(ctx);
			if (choice === "查看状态与诊断") {
				bindStatus(ctx);
				const diagnostics = catalogDiagnostics(catalog,
					{ credentialConfigured, rootConfigured, traceEnabled });
				await ctx.ui.select("TSGW 状态与诊断（选择任一行关闭）", diagnostics.split("\n"));
			}
		},
	});
	pi.registerCommand("tsgw-search", {
		description: "Change built-in web search for this session only",
		handler: async (args, ctx) => {
			const lifecycle = lifecycleRevision;
			await ctx.waitForIdle();
			if (lifecycle !== lifecycleRevision) return;
			refreshRequestState(ctx);
			bindStatus(ctx);
			const support = searchSupport();
			if (!support) {
				ctx.ui.notify("当前模型不支持插件内置联网。", "info");
				return;
			}
			if (support === "grok") {
				ctx.ui.notify("当前 Grok 模型内置联网固定为实时；不修改 GPT 会话模式。", "info");
				return;
			}
			const modes: WebSearchMode[] = ["cached", "live"];
			const labels = modes.map((mode) => searchLabel(mode, support));
			const input = args.trim();
			const choice = input || (ctx.hasUI
				? await ctx.ui.select("内置联网（仅本会话）", labels) : undefined);
			if (!choice || lifecycle !== lifecycleRevision) return;
			if (searchSupport() !== support) {
				ctx.ui.notify("模型支持性已变化，请重新选择内置联网模式。", "warning");
				return;
			}
			const mode = modes.find((mode, index) => mode === choice || labels[index] === choice);
			if (!mode) {
				ctx.ui.notify("不支持的模式；GPT 仅支持 cached/live，Grok 固定实时。", "warning");
				return;
			}
			tsSearchMode = mode;
			publishStatus?.();
			ctx.ui.notify(`${searchLabel(mode, support)}；仅本会话生效。`, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		lifecycleRevision++;
		refreshPending = false;
		tsSearchMode = defaultSearchMode;
		refreshRequestState(ctx);
		bindStatus(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		refreshRequestState(ctx);
		bindStatus(ctx);
	});
	pi.on("session_shutdown", () => {
		lifecycleRevision++;
		refreshPending = false;
		publishStatus = undefined;
	});
	pi.on("model_select", (event, ctx) => {
		requestState = requestStateFor(
			event.model,
			requestState?.thinkingLevel ?? "off",
		);
		if (ctx) bindStatus(ctx);
	});
	pi.on("thinking_level_select", (event) => {
		if (requestState)
			requestState = { ...requestState, thinkingLevel: event.level };
	});

	pi.on("before_provider_request", (event) => {
		const state = requestState;
		if (!state) return;
		const context = {
			provider: state.provider,
			modelId: state.modelId,
			api: state.api,
			thinkingLevel: state.thinkingLevel,
			tsSearchMode: tsSearchMode,
		};
		// 模型模块统一完成请求改写：厂商思维链策略 + 内置查询工具注入。
		return applyModelOperations(event.payload, context);
	});

	if (!traceEnabled) return;
	const threadId = randomUUID();
	let traceId = randomUUID();
	pi.on("agent_start", () => {
		traceId = randomUUID();
	});
	pi.on("before_provider_headers", (event) => {
		const state = requestState;
		if (!state || !isTsgwTraceTarget(state, root)) return;
		if (!hasHeader(event.headers, "AH-Thread-Id"))
			event.headers["AH-Thread-Id"] = threadId;
		if (!hasHeader(event.headers, "AH-Trace-Id"))
			event.headers["AH-Trace-Id"] = traceId;
	});
}
