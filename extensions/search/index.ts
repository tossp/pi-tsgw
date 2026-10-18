import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { builtinSearchSupport, resolveSearchDelegate } from "#tsgw/models/web-search";
import type { WebSearchMode } from "#tsgw/models/_tools";
import { searchLabel, type SearchSupport } from "#tsgw/provider/status";
import { registerSearchProxyTool, SEARCH_PROXY_TOOL } from "./proxy.ts";

interface SearchOptions {
	defaultMode: WebSearchMode;
	state: () => { provider: string; modelId: string; api: string } | undefined;
	models: () => ReadonlyArray<{ id: string; api?: string }>;
	revision: () => number;
	refreshState: (ctx: ExtensionContext) => void;
	bindStatus: (ctx: ExtensionContext) => void;
	publishStatus: () => void;
}

interface SearchController {
	mode(): WebSearchMode;
	support(): SearchSupport | undefined;
	sync(): void;
	reset(): void;
	stop(): void;
}

/** 会话搜索控制；不保留生命周期上下文，也不处理凭据。 */
export function registerSearch(pi: ExtensionAPI, options: SearchOptions): SearchController {
	let mode = options.defaultMode;
	let stopped = false;
	const nativeSupport = () => {
		const state = options.state();
		return state?.provider === "tsgw"
			? builtinSearchSupport(state.modelId, state.api) : undefined;
	};
	const delegate = () => !stopped && options.state()?.provider === "tsgw" && !nativeSupport()
		? resolveSearchDelegate(options.models()) : undefined;
	const support = (): SearchSupport | undefined => {
		const native = nativeSupport();
		if (native) return native;
		const target = delegate();
		return target ? (target.kind === "gpt" ? "proxy-gpt" : "proxy-grok") : undefined;
	};
	registerSearchProxyTool(pi, { delegate, mode: () => mode });
	const sync = () => {
		if (stopped) return;
		const active = pi.getActiveTools();
		const enabled = delegate() !== undefined;
		if (active.includes(SEARCH_PROXY_TOOL) === enabled) return;
		pi.setActiveTools(enabled ? [...active, SEARCH_PROXY_TOOL]
			: active.filter(name => name !== SEARCH_PROXY_TOOL));
	};
	pi.registerCommand("tsgw-search", {
		description: "更改原生或代理内置联网搜索设置，仅对当前会话生效",
		handler: async (args, ctx) => {
			const revision = options.revision();
			await ctx.waitForIdle();
			if (revision !== options.revision()) return;
			options.refreshState(ctx);
			sync();
			options.bindStatus(ctx);
			const current = support();
			const target = delegate()?.modelId;
			if (!current) {
				ctx.ui.notify("当前模型不支持插件内置联网，且无可用代理模型。", "info");
				return;
			}
			if (current === "grok" || current === "proxy-grok") {
				ctx.ui.notify(target ? `内置联网由 ${target} 代理，固定为实时；不修改 GPT 会话模式。`
					: "当前 Grok 模型内置联网固定为实时；不修改 GPT 会话模式。", "info");
				return;
			}
			const modes: WebSearchMode[] = ["cached", "live"];
			const labels = modes.map(value => searchLabel(value, current));
			const choice = args.trim() || (ctx.hasUI
				? await ctx.ui.select("内置联网（仅本会话）", labels) : undefined);
			if (!choice || revision !== options.revision()) return;
			if (support() !== current || delegate()?.modelId !== target) {
				ctx.ui.notify("模型支持性已变化，请重新选择内置联网模式。", "warning");
				return;
			}
			const selected = modes.find((value, index) => value === choice || labels[index] === choice);
			if (!selected) {
				ctx.ui.notify("不支持的模式；GPT 仅支持 cached/live，Grok 固定实时。", "warning");
				return;
			}
			mode = selected;
			options.publishStatus();
			ctx.ui.notify(`${searchLabel(mode, current)}${target ? `（${target}）` : ""}；仅本会话生效。`, "info");
		},
	});
	return {
		mode: () => mode, support, sync,
		reset: () => { mode = options.defaultMode; stopped = false; },
		stop: () => { stopped = true; },
	};
}
