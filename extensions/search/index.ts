import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveSearchDelegate } from "#tsgw/models/web-search";
import { registerSearchProxyTool } from "./proxy.ts";

interface SearchOptions {
	state: () => { provider: string } | undefined;
	models: () => ReadonlyArray<{ id: string; api?: string }>;
}

/** 搜索代理只保留会话生命周期状态；搜索模式由每次工具调用指定。 */
export function registerSearch(pi: ExtensionAPI, options: SearchOptions) {
	let stopped = false;
	const delegate = () => !stopped && options.state()?.provider === "tsgw"
		? resolveSearchDelegate(options.models()) : undefined;
	registerSearchProxyTool(pi, { delegate });
	return {
		reset: () => { stopped = false; },
		stop: () => { stopped = true; },
	};
}
