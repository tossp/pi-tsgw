import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const TS_OHT_NAME = "ts_oht";
export const TS_OHT_URL = "https://xn--oht.cc/mcp";

/** Session default only; Pi owns file overrides, connections and OAuth. */
export function registerTsgwMcp(pi: ExtensionAPI, configuredUrl?: unknown): void {
	const value = configuredUrl === undefined ? TS_OHT_URL : configuredUrl;
	try {
		if (typeof value !== "string" || value.trim() !== value) throw new Error();
		const url = new URL(value);
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
			throw new Error();
	} catch {
		// Invalid explicit configuration must not connect to a different default.
		// Never include URLs or parser errors in ordinary logs.
		console.error("TSGW: invalid mcpUrl; ts_oht registration skipped.");
		return;
	}
	if (typeof pi.registerMcpServer !== "function") {
		console.error("TSGW: this Pi host cannot register MCP servers; ts_oht registration skipped.");
		return;
	}
	// Preserve the exact URL because Pi binds OAuth to server name + URL.
	pi.registerMcpServer(TS_OHT_NAME, { url: value as string, exposure: "codemode" });
}
