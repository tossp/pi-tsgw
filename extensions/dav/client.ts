import type { DavKind } from "davkit/dav";
import type { DavAccountConfig } from "./config.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

export function supportsDavNode(version: string): boolean {
	return /^(\d+)\./.test(version) && Number(version.split(".")[0]) >= 24;
}

/** 每次调用独立客户端与取消信号；不缓存密码、不重试、不在注册阶段加载可选库。 */
export async function withDavAccount<T>(
	config: DavAccountConfig,
	signal: AbortSignal | undefined,
	handler: (context: DavReadContext) => Promise<T>,
	options: { discoveryKind?: DavKind; fetch?: typeof globalThis.fetch } = {},
): Promise<T> {
	if (!supportsDavNode(process.versions.node))
		throw new DavToolError("DAV_UNAVAILABLE", "DAV 业务调用需要 Node.js 24 或更新版本；其他插件能力不受影响。");
	signal?.throwIfAborted();
	const library = await loadLibrary();
	const base = new URL(config.url);
	// 根地址可能是管理门户，按标准协议入口发现；明确路径则按配置使用，不试探厂商私有路径。
	const entry = options.discoveryKind && base.pathname === "/"
		? new URL(`/.well-known/${options.discoveryKind === "calendar" ? "caldav" : "carddav"}`, base).href
		: config.url;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const makeClient = (baseUrl: string, observe?: (url: string, response: Response) => void) => new library.dav.DavClient({
		baseUrl, basicAuth: { username: config.user, password: config.password },
		fetch: async (url, init) => {
			const signals = [signal, init?.signal].filter((value): value is AbortSignal => !!value);
			const response = await fetchImpl(url, { ...init,
				signal: signals.length ? AbortSignal.any(signals) : undefined, redirect: "manual" });
			observe?.(String(url), response);
			return response;
		},
	});
	const client = makeClient(config.url);
	if (options.discoveryKind) client.discover = async kind => {
		let endpoint = entry;
		for (let redirects = 0; ; redirects++) {
			let next: string | undefined;
			let invalid = false;
			const discovery = makeClient(endpoint, (url, response) => {
				if (![301, 302, 307, 308].includes(response.status)) return;
				const location = response.headers.get("location");
				try {
					const target = location ? new URL(location, url) : undefined;
					if (!target || redirects >= 3 || target.origin !== base.origin || target.username || target.password || target.hash) invalid = true;
					else next = target.href;
				} catch { invalid = true; }
			});
			try { return await discovery.discover(kind); }
			catch (error) {
				if (invalid) throw new DavToolError("DISCOVERY_FAILED", "DAV 发现跳转无效、过多或跨源；未转发认证。");
				if (!next) throw error;
				// 由库重新执行发现，确保相对 href 以新入口解析；资源 GET/REPORT 不跟随跳转。
				endpoint = next;
			}
		}
	};
	try {
		const data = await handler({ client, ical: library.ical, vcard: library.vcard,
			...(config.timeZone === undefined ? {} : { timeZone: config.timeZone }) });
		signal?.throwIfAborted();
		return data;
	} catch (error) {
		if (signal?.aborted) throw new DavToolError("ABORTED", "DAV 读取已取消。");
		if (error instanceof DavToolError) throw error;
		if (error instanceof library.dav.DavError) {
			const code = error.status === 401 || error.status === 403 ? "DAV_AUTH_FAILED"
				: error.status === 404 ? "NOT_FOUND" : "DAV_FAILED";
			const status = error.status === null ? "连接或响应读取失败" : `HTTP ${error.status}`;
			throw new DavToolError(code, `DAV 请求失败（${status}），未自动重试；请核对服务入口、账户与权限。`);
		}
		if (error instanceof library.dav.DavProtocolError)
			throw new DavToolError("DAV_PROTOCOL", "服务器未返回有效 DAV 数据；请核对服务入口，不把网页响应视为认证成功。");
		throw error;
	}
}

async function loadLibrary() {
	try {
		const [dav, ical, vcard] = await Promise.all([import("davkit/dav"), import("davkit/ical"), import("davkit/vcard")]);
		return { dav, ical, vcard };
	} catch {
		throw new DavToolError("DAV_UNAVAILABLE", "DAV 可选依赖不可用；请按正常包管理流程安装包含 optional 依赖的插件，不会自动安装或切换旧 MCP。");
	}
}
