import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import type { ThinkingLevel, WebSearchMode } from "./models/_tools.ts";
import {
	DEFAULT_SEARCH_MODELS,
	registerTsSearch,
} from "./ts-search/ts-search.ts";

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
	if (apiKey) {
		try {
			const gateway = await getGatewayModelIds(root, apiKey, {
				cacheFilePath,
			});
			if (gateway.ok) gatewayIds = new Set(gateway.ids);
			else
				console.warn(
					`TSGW: gateway model list unavailable (${gateway.reason ?? "unknown"}); using static catalog.`,
				);
		} catch {
			console.warn(
				`TSGW: gateway model list load failed; using static catalog.`,
			);
		}
	}

	return {
		models: effectiveModelsForGateway(root, filter, gatewayIds),
		gatewayIds,
	};
}

export default async function registerTsgw(pi: ExtensionAPI): Promise<void> {
	const settings = readTsgwSettings();
	const root = rootForRuntime(settings.baseUrl);
	const tsSearchMode: WebSearchMode =
		settings.tsSearch === "cached" || settings.tsSearch === "live"
			? settings.tsSearch
			: "off";
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
	const { models, gatewayIds } = await resolveEffectiveModels(
		root,
		modelFilter,
		cacheFilePath,
	);
	let latestModels = models;
	pi.registerProvider(PROVIDER_ID, {
		name: "TSGW",
		baseUrl: `${root}/v1`,
		api: "openai-completions",
		apiKey: "$TSGW_API_KEY",
		models,
		async refreshModels(context) {
			if (!context.allowNetwork) return latestModels;
			context.signal.throwIfAborted();
			const credential = context.credential;
			if (credential?.type !== "api_key" || !credential.key)
				throw new Error("TSGW API key is unavailable for model refresh.");

			const gateway = await getGatewayModelIds(root, credential.key, {
				cacheFilePath,
				force: context.force === true,
				signal: context.signal,
			});
			context.signal.throwIfAborted();
			if (!gateway.ok)
				throw new Error(
					`TSGW gateway model refresh failed (${gateway.reason}).`,
				);
			if (gateway.stale)
				throw new Error(
					`TSGW gateway model refresh failed (${gateway.fallbackReason ?? "unknown"}); keeping the last successful catalog.`,
				);

			latestModels = effectiveModelsForGateway(
				root,
				modelFilter,
				new Set(gateway.ids),
			);
			return latestModels;
		},
	});

	pi.registerCommand("tsgw-refresh", {
		description: "Force-refresh the TSGW gateway model catalog",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			if (!ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID).configured) {
				ctx.ui.notify(
					"TSGW model refresh skipped: configure an API key with /login first.",
					"warning",
				);
				return;
			}
			const count = (): number =>
				ctx.modelRegistry
					.getAvailable()
					.filter((model) => model.provider === PROVIDER_ID).length;
			const before = count();
			try {
				// Pi 0.84+ returns cancellation/errors; older supported Pi versions
				// resolve void, so treat missing result metadata as success.
				const result = (await ctx.modelRegistry.refresh({
					providers: [PROVIDER_ID],
					force: true,
				})) as
					| {
							aborted?: boolean;
							errors?: ReadonlyMap<string, Error>;
					  }
					| undefined;
				const after = count();
				const error = result?.errors?.get(PROVIDER_ID);
				if (result?.aborted) {
					ctx.ui.notify(
						`TSGW model refresh cancelled (${before} → ${after}).`,
						"warning",
					);
				} else if (error) {
					ctx.ui.notify(
						`TSGW model refresh failed (${before} → ${after}): ${error.message}`,
						"error",
					);
				} else {
					ctx.ui.notify(
						`TSGW models refreshed (${before} → ${after}).`,
						"info",
					);
				}
			} catch (error) {
				ctx.ui.notify(
					`TSGW model refresh failed (${before} → ${count()}): ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	// ts_search 条件注册：固定白名单后端与可用模型列表有交集才注册，
	// 否则失活（避免注册一个无后端可用的死工具）。
	const availableIds =
		gatewayIds ?? new Set(modelsForRoot(root).map(({ id }) => id));
	if (DEFAULT_SEARCH_MODELS.some((id) => gatewayHasModel(availableIds, id))) {
		registerTsSearch(pi, { baseUrl: root });
	}

	pi.on("session_start", (_event, ctx) => {
		refreshRequestState(ctx);
	});
	pi.on("agent_start", (_event, ctx) => {
		refreshRequestState(ctx);
	});
	pi.on("model_select", (event) => {
		requestState = requestStateFor(
			event.model,
			requestState?.thinkingLevel ?? "off",
		);
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
