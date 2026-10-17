import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
	getAgentDir,
	readStoredCredential,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	DEFAULT_ROOT,
	PROVIDER_ID,
	filterModels,
	modelsForRoot,
	normalizeRoot,
	type ModelFilter,
} from "../models/catalog.ts";
import { getGatewayModelIds, STARTUP_GATEWAY_MODEL_CACHE_TTL_MS } from "../models/gateway-catalog.ts";
import { applyModelOperations } from "../models/operations.ts";
import { registerSearch } from "../search/index.ts";
import { IMAGE_API, imageModelsForRoot, supportsImageModels } from "../images/models.ts";
import { generateImages } from "../images/adapter.ts";
import {
	catalogLabel,
	catalogDiagnostics,
	searchLabel,
	type CatalogStatus,
} from "./status.ts";
import type { ThinkingLevel, WebSearchMode } from "../models/_tools.ts";
import type { TsgwSettings } from "./config.ts";
import { registerRefreshTool } from "./refresh-tool.ts";

/**
 * 在生命周期上下文仍有效时，复制供应商钩子所需的数据。
 * 保持结构化类型：过期的执行器可能稍后才调用这些钩子。
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

function rootForRuntime(configured: string | undefined): string {
	try {
		return normalizeRoot(configured);
	} catch {
		console.error("TSGW：baseUrl 无效；使用默认根地址。");
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
		// 仅追踪发往已配置网关根地址的请求，避免为在其他位置
		// 覆盖了 baseUrl 的模型添加追踪请求头。
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
	imagesEnabled: boolean,
): ProviderModelConfig[] {
	const staticModels: ProviderModelConfig[] = [
		...modelsForRoot(root),
		...(imagesEnabled ? imageModelsForRoot(root) : []),
	];
	const intersected = gatewayIds
		? staticModels.filter((model) => gatewayHasModel(gatewayIds, model.id))
		: [];
	return filterModels(intersected, filter);
}

/**
 * 三层模型过滤：静态目录 ∩ 网关实际列表 ∩ 用户黑白名单。
 * 无网关目录时不登记模型，避免将静态登记误认为网关可用。
 */
async function resolveEffectiveModels(
	root: string,
	filter: ModelFilter | undefined,
	cacheFilePath: string,
	imagesEnabled: boolean,
): Promise<{
	models: ProviderModelConfig[];
	gatewayIds: ReadonlySet<string> | undefined;
	catalog: CatalogStatus;
}> {
	// 凭据解析失败不阻塞插件加载，但不登记未经网关确认的模型。
	let apiKey = "";
	try {
		const credential = readStoredCredential(PROVIDER_ID);
		apiKey = credential?.type === "api_key" ? (credential.key ?? "") : "";
	} catch {
		apiKey = "";
	}

	let gatewayIds: ReadonlySet<string> | undefined;
	let catalog: CatalogStatus = { count: 0, source: "empty", loading: false,
		ttlMs: STARTUP_GATEWAY_MODEL_CACHE_TTL_MS,
		error: "模型目录获取失败，当前无可用模型；请配置凭据后择机强制刷新。" };
	if (apiKey) {
		try {
			const gateway = await getGatewayModelIds(root, apiKey, {
				cacheFilePath,
				ttlMs: STARTUP_GATEWAY_MODEL_CACHE_TTL_MS,
				retryWithoutCache: true,
			});
			if (gateway.ok) {
				gatewayIds = new Set(gateway.ids);
				catalog = {
					...catalog,
					source: gateway.cached ? "cache" : "network",
					storedAt: gateway.storedAt,
					error: gateway.stale
						? "模型目录刷新失败，已沿用缓存，请择机强制刷新。" : undefined,
				};
			} else catalog.error = "模型目录获取失败，当前无可用模型，请择机强制刷新。";
		} catch {
			catalog.error = "模型目录获取失败，当前无可用模型，请择机强制刷新。";
		}
	}
	if (catalog.error) console.warn(`TSGW: ${catalog.error}`);
	const models = effectiveModelsForGateway(root, filter, gatewayIds, imagesEnabled);
	return { models, gatewayIds, catalog: { ...catalog, count: models.length } };
}

export async function registerTsgwProvider(
	pi: ExtensionAPI, settings: TsgwSettings,
): Promise<void> {
	const root = rootForRuntime(settings.baseUrl);
	const imagesEnabled = supportsImageModels(VERSION);
	const defaultSearchMode: WebSearchMode =
		settings.tsSearch === "cached" || settings.tsSearch === "live"
			? settings.tsSearch
			: "live";
	const traceEnabled = settings.traceHeaders === true;
	const modelFilter: ModelFilter = {
		include: settings.includeModels,
		exclude: settings.excludeModels,
	};
	const cacheFilePath = gatewayModelCachePath();
	registerRefreshTool(pi, cacheFilePath);
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
		imagesEnabled,
	);
	const { models } = initial;
	let latestModels = models;
	let catalog = initial.catalog;
	let startupNotice = initial.catalog.error;
	let credentialConfigured = false;
	let publishStatus: (() => void) | undefined;
	let refreshRevision = 0;
	let lifecycleRevision = 0;
	const rootConfigured = root !== DEFAULT_ROOT;
	const search = registerSearch(pi, {
		defaultMode: defaultSearchMode,
		state: () => requestState,
		models: () => latestModels.filter(model => model.type === undefined || model.type === "chat"),
		revision: () => lifecycleRevision,
		refreshState: refreshRequestState,
		bindStatus: ctx => bindStatus(ctx),
		publishStatus: () => publishStatus?.(),
	});
	// 仅保留界面输出端，绝不保留生命周期上下文；关闭时断开。
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
					? searchLabel(search.mode(), search.support()) : undefined);
		};
		publishStatus();
	};
	pi.registerProvider(PROVIDER_ID, {
		name: "TSGW",
		baseUrl: `${root}/v1`,
		api: "openai-completions",
		apiKey: "$TSGW_API_KEY",
		models,
		...(imagesEnabled ? { images: { [IMAGE_API]: { generateImages } } } : {}),
		async refreshModels(context) {
			// 启动获取已完成；宿主的额外自动同步不再追加联网请求。
			// 工具检查 24 小时窗口，必要时与命令一样显式传入 force。
			if (!context.allowNetwork || context.force !== true) return latestModels;
			context.signal.throwIfAborted();
			const revision = ++refreshRevision;
			catalog = { ...catalog, loading: true };
			publishStatus?.();
			try {
				const credential = context.credential;
				credentialConfigured = credential?.type === "api_key" && !!credential.key;
				if (credential?.type !== "api_key" || !credential.key)
					throw new Error("刷新模型所需的 TSGW API 密钥不可用。");
				const gateway = await getGatewayModelIds(root, credential.key, {
					cacheFilePath,
					force: context.force === true,
					signal: context.signal,
				});
				context.signal.throwIfAborted();
				if (!gateway.ok || gateway.stale)
					throw new Error("TSGW 刷新失败；保留上次成功获取的目录。");
				if (revision === refreshRevision) {
					startupNotice = undefined;
					latestModels = effectiveModelsForGateway(root, modelFilter, new Set(gateway.ids), imagesEnabled);
					search.sync();
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
		// 供应商回调管理自身状态；仅诊断回调开始前的失败。
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
				ctx.ui.notify("已跳过 TSGW 模型刷新：请先通过 /login 配置 API 密钥。", "warning");
				return;
			}
			const count = () => typeof ctx.modelRegistry.getModelsOfType === "function"
				? ctx.modelRegistry.getModelsOfType("chat", PROVIDER_ID).length +
					ctx.modelRegistry.getModelsOfType("image", PROVIDER_ID).length
				: ctx.modelRegistry.getAvailable().filter((model) => model.provider === PROVIDER_ID).length;
			const before = count();
			revision = refreshRevision;
			// 较旧的 Pi 版本返回 void，而非取消/错误元数据。
			const result = (await ctx.modelRegistry.refresh({
				providers: [PROVIDER_ID], force: true,
			})) as { aborted?: boolean; errors?: ReadonlyMap<string, Error> } | undefined;
			if (lifecycle !== lifecycleRevision) return;
			const after = count();
			if (result?.aborted) {
				recordFailure("刷新已取消，保留原目录");
				ctx.ui.notify(`TSGW 模型刷新已取消（${before} → ${after}）。`, "warning");
			} else if (result?.errors?.has(PROVIDER_ID)) {
				recordFailure("刷新失败，保留原目录；请检查凭据、网关与网络");
				ctx.ui.notify(`TSGW 模型刷新失败（${before} → ${after}）。`, "error");
			} else {
				ctx.ui.notify(`TSGW 模型已刷新（${before} → ${after}）。`, "info");
			}
		} catch {
			if (lifecycle !== lifecycleRevision) return;
			recordFailure("刷新失败，保留原目录；请检查凭据、网关与网络");
			ctx.ui.notify("TSGW 模型刷新失败；保留原目录。", "error");
		} finally {
			if (lifecycle === lifecycleRevision) refreshPending = false;
		}
	};
	pi.registerCommand("tsgw-refresh", {
		description: "强制刷新 TSGW 网关模型目录",
		handler: async (_args, ctx) => refreshCatalog(ctx),
	});
	pi.registerCommand("tsgw", {
		description: "TSGW 模型目录与配置诊断",
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
	pi.on("session_start", (_event, ctx) => {
		lifecycleRevision++;
		refreshPending = false;
		search.reset();
		refreshRequestState(ctx);
		search.sync();
		bindStatus(ctx);
		if (startupNotice && ctx.hasUI) {
			ctx.ui.notify(startupNotice, "warning");
			startupNotice = undefined;
		}
	});
	pi.on("agent_start", (_event, ctx) => {
		refreshRequestState(ctx);
		search.sync();
		bindStatus(ctx);
	});
	pi.on("session_shutdown", () => {
		search.stop();
		lifecycleRevision++;
		refreshPending = false;
		publishStatus = undefined;
	});
	pi.on("model_select", (event, ctx) => {
		requestState = requestStateFor(
			event.model,
			requestState?.thinkingLevel ?? "off",
		);
		search.sync();
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
			tsSearchMode: search.mode(),
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
