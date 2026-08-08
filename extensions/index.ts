import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
	DEFAULT_ROOT,
	PROVIDER_ID,
	modelsForRoot,
	normalizeRoot,
	type ModelFilter,
} from "./models/catalog.ts";
import { applyModelOperations } from "./models/operations.ts";
import type { ThinkingLevel, WebSearchMode } from "./models/_tools.ts";
import { registerTsSearch } from "./ts-search/ts-search.ts";

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
	let requestState: RequestState | undefined;

	const refreshRequestState = (ctx: {
		model: RequestModel | undefined;
		thinkingLevel?: ThinkingLevel;
	}): void => {
		requestState = requestStateFor(ctx.model, ctx.thinkingLevel ?? "off");
	};

	const models = modelsForRoot(root, modelFilter);
	pi.registerProvider(PROVIDER_ID, {
		name: "TSGW",
		baseUrl: `${root}/v1`,
		api: "openai-completions",
		apiKey: "$TSGW_API_KEY",
		models,
	});
	registerTsSearch(pi, {
		baseUrl: root,
		searchModels: models
			.map(({ id }) => id)
			.filter((id) => id.startsWith("gpt-") || id.startsWith("grok-")),
	});

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
