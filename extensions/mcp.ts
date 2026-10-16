import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TS_OHT_NAME = "ts_oht";
export const TS_OHT_URL = "https://xn--oht.cc/mcp";

/** 仅设置会话默认值；文件覆盖、连接与 OAuth 由 Pi 管理。 */
export function registerTsgwMcp(pi: ExtensionAPI, configuredUrl?: unknown): void {
	const value = configuredUrl === undefined ? TS_OHT_URL : configuredUrl;
	try {
		if (typeof value !== "string" || value.trim() !== value) throw new Error();
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
			throw new Error();
	} catch {
		// 显式配置无效时，不得改用其他默认地址连接。
		// 常规日志中绝不包含 URL 或解析器错误。
		console.error("TSGW：mcpUrl 无效；已跳过 ts_oht 注册。");
		return;
	}
	if (typeof pi.registerMcpServer !== "function") {
		console.error("TSGW：当前 Pi 宿主无法注册 MCP 服务器；已跳过 ts_oht 注册。");
		return;
	}
	// 保留精确 URL，因为 Pi 将 OAuth 绑定到服务器名称与 URL 的组合。
	pi.registerMcpServer(TS_OHT_NAME, { url: value as string, exposure: "codemode" });
}
