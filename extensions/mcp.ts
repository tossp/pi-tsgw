import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TS_OHT_NAME = "ts_oht";
export const TS_OHT_URL = "https://xn--oht.cc/mcp";
export const TS_TOOL_NAME = "ts_tool";
export const TS_TOOL_URL = "https://mcp.tossp.com/mm/ts/mcp";

/** 仅设置会话默认值；文件覆盖、连接与 OAuth 由 Pi 管理。 */
export function registerTsgwMcp(pi: ExtensionAPI, configuredUrl?: unknown): void {
	if (typeof pi.registerMcpServer !== "function") {
		console.error("TSGW：当前 Pi 宿主无法注册 MCP 服务器；已跳过 ts_oht、ts_tool 注册。");
		return;
	}
	const value = configuredUrl === undefined ? TS_OHT_URL : configuredUrl;
	let ohtUrl: string | undefined;
	try {
		if (typeof value !== "string" || value.trim() !== value) throw new Error();
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
			throw new Error();
		ohtUrl = value;
	} catch {
		// 显式配置无效时，不得改用其他默认地址连接。
		// 常规日志中绝不包含 URL 或解析器错误。
		console.error("TSGW：mcpUrl 无效；已跳过 ts_oht 注册。");
	}
	// 保留精确 URL，因为 Pi 将 OAuth 绑定到服务器名称与 URL 的组合。
	// 独立登记：无效的 ts_oht 配置或单个登记失败不得阻止另一个服务和 provider。
	for (const [name, url] of [[TS_OHT_NAME, ohtUrl], [TS_TOOL_NAME, TS_TOOL_URL]] as const) {
		if (url === undefined) continue;
		try {
			pi.registerMcpServer(name, { url, exposure: "codemode" });
		} catch {
			// 不输出可能包含配置或凭据的宿主异常。
			console.error(`TSGW：宿主无法登记 ${name}；已跳过，请检查 Pi MCP 支持或同名扩展。`);
		}
	}
}
