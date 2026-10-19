import type { WebSearchMode } from "#tsgw/models/_tools";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS } from "#tsgw/models/gateway-catalog";

export interface CatalogStatus {
	count: number;
	source: "static" | "empty" | "cache" | "network";
	/** 默认统一使用 24 小时新鲜窗口。 */
	ttlMs?: number;
	/** 网关目录真实获取时间；从缓存读取时保留原值，不重置为读取时间。 */
	storedAt?: number;
	loading: boolean;
	/** 调用者提供的安全摘要，不应包含密钥或 URL。 */
	error?: string;
}

const SOURCE_LABELS = {
	static: "内置静态",
	empty: "无可用目录",
	cache: "缓存",
	network: "网关",
} as const;

function fetchedAt(state: CatalogStatus): number | undefined {
	const time = state.storedAt;
	if (
		(state.source === "static" || state.source === "empty") ||
		time === undefined ||
		!Number.isFinite(time) ||
		time < 0 ||
		Number.isNaN(new Date(time).getTime())
	) return undefined;
	return time;
}

function freshness(state: CatalogStatus, now: number): "新鲜" | "过期" | "未知" {
	const time = fetchedAt(state);
	if (time === undefined || !Number.isFinite(now)) return "未知";
	// 与目录缓存一致：时钟回拨不判过期，达到 TTL 则过期。
	return Math.max(0, now - time) < (state.ttlMs ?? DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS)
		? "新鲜"
		: "过期";
}

export function catalogLabel(
	state: CatalogStatus,
	credentialConfigured: boolean,
	rootConfigured: boolean,
	now = Date.now(),
): string {
	if (state.loading) return "⏳ TSGW";
	const suffix = `TSGW · ${state.count}`;
	if (state.error) return `🔴 ${suffix}`;
	if (!credentialConfigured || !rootConfigured) return `⚠️ ${suffix}`;
	if (freshness(state, now) !== "新鲜") return `🟡 ${suffix}`;
	return `🟢 ${suffix}`;
}

/** 纯展示：只接受配置是否存在，不读取配置，也不接收密钥或地址。 */
export function catalogDiagnostics(
	state: CatalogStatus,
	options: {
		credentialConfigured: boolean;
		rootConfigured: boolean;
		traceEnabled: boolean;
	},
	now = Date.now(),
): string {
	const time = fetchedAt(state);
	return [
		`目录数量：${state.count}`,
		`目录来源：${SOURCE_LABELS[state.source]}`,
		`目录加载：${state.loading ? "进行中" : "未进行"}`,
		`真实获取时间：${time === undefined ? "未知" : new Date(time).toISOString()}`,
		"（保留网关实际获取时间，不是本轮缓存读取时间）",
		`缓存状态：${freshness(state, now)}`,
		`错误：${state.error || "无"}`,
		`配置凭据：${options.credentialConfigured ? "存在" : "不存在"}`,
		`网关地址：${options.rootConfigured ? "已设置" : "未设置"}`,
		`追踪开关：${options.traceEnabled ? "开" : "关"}`,
		"仅表示目录状态，不代表模型推理健康；不展示密钥或 URL。",
	].join("\n");
}

/** 内置联网支持性：原生（gpt/grok）或代理（proxy-*，目录内支持模型代搜）。 */
export type SearchSupport = "gpt" | "grok" | "proxy-gpt" | "proxy-grok";

export function searchLabel(
	mode: WebSearchMode,
	support: SearchSupport | undefined,
): string {
	if (support === undefined) return "⚪ 内置联网：不支持";
	const proxy =
		support === "proxy-gpt" || support === "proxy-grok";
	// Grok 原生与 Grok 代理固定实时，不受 GPT 的 cached/live 会话模式影响。
	if (support === "grok" || support === "proxy-grok" || mode === "live")
		return proxy ? "🟢 内置联网：代理" : "🟢 内置联网：实时";
	return proxy ? "🟡 内置联网：代理缓存" : "🟡 内置联网：缓存";
}
