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
	normalizeRoot,
	type ModelFilter,
} from "#tsgw/models/catalog";
import { catalogFailureMessage, createCatalogState } from "./catalog-state.ts";
import { createCatalogRecovery } from "./catalog-recovery.ts";
import { createCatalogCoordinator, type CatalogRefreshKind } from "./catalog-coordinator.ts";
import { applyModelOperations } from "#tsgw/models/operations";
import { registerSearch } from "#tsgw/search/index";
import { supportsClassifierModels, supportsImageModels } from "#tsgw/models/capabilities";
import { OPENAI_IMAGE_API as IMAGE_API } from "#tsgw/models/vendors/openai";
import { TYPESAFE_CLASSIFIER_API as CLASSIFIER_API } from "#tsgw/models/vendors/typesafe";
import { generateImages } from "#tsgw/models/adapter/images/adapter";
import { classify } from "#tsgw/models/adapter/classifiers/adapter";
import {
	catalogLabel,
	catalogDiagnostics,
	searchLabel,
	type CatalogStatus,
} from "./status.ts";
import type { ThinkingLevel, WebSearchMode } from "#tsgw/models/_tools";
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

/** 模型缓存文件：<agent-dir>/tsgw/models-cache.json。 */
function gatewayModelCachePath(): string {
	return join(getAgentDir(), "tsgw", "models-cache.json");
}

/** 初始化仅解析宿主保存的凭据，不请求网络。 */
function initialCatalogKey(): string | undefined {
	try {
		const credential = readStoredCredential(PROVIDER_ID);
		return credential?.type === "api_key" ? credential.key : undefined;
	} catch { return undefined; }
}

export async function registerTsgwProvider(
	pi: ExtensionAPI, settings: TsgwSettings,
): Promise<void> {
	const root = rootForRuntime(settings.baseUrl);
	const imagesEnabled = supportsImageModels(VERSION);
	const classifiersEnabled = supportsClassifierModels(VERSION);
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
	let requestState: RequestState | undefined;

	const refreshRequestState = (ctx: {
		model: RequestModel | undefined;
		thinkingLevel?: ThinkingLevel;
	}): void => {
		requestState = requestStateFor(ctx.model, ctx.thinkingLevel ?? "off");
	};

	let latestModels: ProviderModelConfig[] = [];
	let catalog: CatalogStatus = { count: 0, source: "empty", loading: false };
	let notify: ((message: string) => void) | undefined;
	let credentialConfigured = false;
	let publishStatus: (() => void) | undefined;
	let refreshRevision = 0;
	let lifecycleRevision = 0;
	let sessionActive = false;
	const rootConfigured = root !== DEFAULT_ROOT;
	const directory = createCatalogState({ root, filter: modelFilter, cacheFilePath,
		imagesEnabled, classifiersEnabled, initialKey: initialCatalogKey(),
		onChange: () => {
			latestModels = directory.models();
			catalog = directory.status();
			// 只加载 provider 的后台 runtime 没有 AgentSession，不能调用工具动作 API。
			if (sessionActive) search.sync();
			publishStatus?.();
		},
	});
	latestModels = directory.models();
	catalog = directory.status();
	const coordinator = createCatalogCoordinator({
		begin: () => directory.beginRefresh(),
		inspect: () => ({ networkAttempted: directory.networkAttempted(),
			networkSucceeded: directory.networkSucceeded(), summary: directory.summary() }),
		canShareNetwork: directory.fetching,
	});
	// 入口只提交刷新意图；宿主回调负责执行，绝不能从回调再次进入 request。
	const requestRefresh = (registry: ExtensionContext["modelRegistry"], kind: CatalogRefreshKind,
		signal?: AbortSignal) => coordinator.request(kind, taskSignal => registry.refresh({
			providers: [PROVIDER_ID], force: kind === "force",
			...(kind === "restore" ? { allowNetwork: false } : {}), signal: taskSignal,
		}), signal);
	const recovery = createCatalogRecovery({
		needsRefresh: directory.needsRefresh,
		retryable: directory.retryable,
		networkAttempted: directory.networkAttempted,
		onFailure: () => {
			const message = directory.fail();
			if (notify) notify(message);
			else console.warn(message);
		},
	});
	const stopRefreshes = (): void => {
		recovery.stop();
		coordinator.stop();
		directory.invalidate();
	};
	registerRefreshTool(pi, {
		refresh: (registry, force, signal) => requestRefresh(registry, force ? "force" : "normal", signal),
	});
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
			notify = undefined;
			return;
		}
		credentialConfigured = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured;
		const ui = ctx.ui;
		notify = message => ui.notify(message, "error");
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
		models: latestModels,
		...(imagesEnabled ? { images: { [IMAGE_API]: { generateImages } } } : {}),
		...(classifiersEnabled ? { classifiers: { [CLASSIFIER_API]: { classify } } } : {}),
		async refreshModels(context) {
			refreshRevision++;
			if (context.credential) credentialConfigured = context.credential.type === "api_key" && !!context.credential.key;
			return coordinator.provider(context, effective => directory.refresh(effective));
		},
	});

	const refreshCatalog = async (ctx: ExtensionCommandContext): Promise<void> => {
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
				directory.fail();
				ctx.ui.notify("TSGW 模型目录获取失败：请先通过 /login 配置 API 密钥。", "error");
				return;
			}
			const count = () => typeof ctx.modelRegistry.getModelsOfType === "function"
				? ctx.modelRegistry.getModelsOfType("chat", PROVIDER_ID).length +
					ctx.modelRegistry.getModelsOfType("image", PROVIDER_ID).length +
					ctx.modelRegistry.getModelsOfType("classifier", PROVIDER_ID).length
				: ctx.modelRegistry.getAvailable().filter((model) => model.provider === PROVIDER_ID).length;
			const before = count();
			revision = refreshRevision;
			const result = await requestRefresh(ctx.modelRegistry, "force");
			if (lifecycle !== lifecycleRevision) return;
			const after = count();
			if (result.aborted) {
				recordFailure("刷新已取消，保留原目录");
				ctx.ui.notify(`TSGW 模型刷新已取消（${before} → ${after}）。`, "warning");
			} else if (result?.errors?.has(PROVIDER_ID)) {
				recordFailure("刷新失败，保留原目录；请检查凭据、网关与网络");
				ctx.ui.notify(catalogFailureMessage(catalog.source !== "empty"), "error");
			} else if (!result.networkSucceeded) {
				ctx.ui.notify("TSGW 未完成联网刷新：宿主禁止联网或未执行刷新；保留现有目录。", "warning");
			} else {
				ctx.ui.notify(`TSGW 模型已刷新（${before} → ${after}）。`, "info");
			}
		} catch {
			if (lifecycle !== lifecycleRevision) return;
			recordFailure("刷新失败，保留原目录；请检查凭据、网关与网络");
			ctx.ui.notify(catalogFailureMessage(catalog.source !== "empty"), "error");
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
		stopRefreshes();
		lifecycleRevision++;
		sessionActive = true;
		search.reset();
		refreshRequestState(ctx);
		search.sync();
		bindStatus(ctx);
		directory.enableNetwork();
		// 只捕获宿主服务；session_start 不返回后台恢复的 Promise。
		const registry = ctx.modelRegistry;
		if (registry && typeof registry.refresh === "function") recovery.start({
			configured: () => registry.getProviderAuthStatus(PROVIDER_ID).configured,
			restore: signal => requestRefresh(registry, "restore", signal),
			refresh: async signal => {
				const outcome = await directory.recoverUsing(async sharedSignal => {
					const result = await requestRefresh(registry, "normal", sharedSignal);
					const failed = !!result.aborted || !!result.errors?.has(PROVIDER_ID) ||
						(directory.networkAttempted() && directory.needsRefresh());
					return directory.outcome(failed);
				}, signal);
				signal.throwIfAborted();
				// 另一实例负责实际获取时，本实例仍通过宿主独立登记，不共享 registry/UI。
				if (!outcome.failed && outcome.snapshot && !directory.matches(outcome.snapshot)) {
					const applied = await requestRefresh(registry, "restore", signal);
					if (applied.aborted || applied.errors?.has(PROVIDER_ID)) return applied;
				}
				directory.finishRecovery(outcome);
				return outcome.failed ? { errors: new Map([[PROVIDER_ID, new Error(catalogFailureMessage(!!outcome.snapshot))]]) } : {};
			},
		});
	});
	pi.on("agent_start", (_event, ctx) => {
		refreshRequestState(ctx);
		search.sync();
		bindStatus(ctx);
	});
	pi.on("session_shutdown", () => {
		sessionActive = false;
		stopRefreshes();
		directory.stop();
		search.stop();
		lifecycleRevision++;
		publishStatus = undefined;
		notify = undefined;
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
