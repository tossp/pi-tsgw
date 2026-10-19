import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PROVIDER_ID } from "#tsgw/models/catalog";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS } from "#tsgw/models/gateway-catalog";
import type { CatalogRefreshOutcome } from "./catalog-coordinator.ts";

/** 工具只向统一目录服务提交一次刷新；缓存校验与目录应用均由协调器完成。 */
export function registerRefreshTool(pi: ExtensionAPI, catalog: {
	refresh(
		registry: ExtensionContext["modelRegistry"],
		force: boolean,
		signal?: AbortSignal,
	): Promise<CatalogRefreshOutcome>;
}): void {
	pi.registerTool({
		name: "tsgw_refresh_models",
		label: "刷新 TSGW 模型目录",
		description: "获取 AIH 网关可用模型并同步当前目录，默认复用 24 小时内的缓存；force=true 忽略有效期强制联网刷新。并发刷新会自动合并到同一任务，单个调用方取消不会中止其他调用方。单次联网超时 5 秒，不发推理请求、不修改配置、不自动重试。返回缓存文件路径、网关模型数与获取时间；随后读取该文件的 ids 获取完整列表（含插件尚未登记的型号）。不自动登记未知型号。",
		parameters: Type.Object({
			force: Type.Optional(Type.Boolean({ description: "忽略缓存有效期强制联网刷新，默认 false。" })),
		}),
		outputSchema: Type.Object({
			cacheFilePath: Type.String(), count: Type.Integer(), storedAt: Type.Number(),
		}),
		exposure: "codemode",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async execute(_id, params, signal, _onUpdate, ctx) {
			const caller = signal && ctx.signal && signal !== ctx.signal
				? AbortSignal.any([signal, ctx.signal]) : signal ?? ctx.signal;
			const registry = ctx.modelRegistry;
			const force = params.force === true;
			const startedAt = Date.now();
			let outcome: CatalogRefreshOutcome;
			try {
				caller?.throwIfAborted();
				if (!registry.getProviderAuthStatus(PROVIDER_ID).configured) throw new Error("缺少凭据");
				// 每个调用方只提交自己的合并信号；并发合并与取消隔离由协调器保证。
				outcome = await catalog.refresh(registry, force, caller);
				caller?.throwIfAborted();
			} catch {
				throw new Error(caller?.aborted ? "TSGW 模型刷新已取消。" : "TSGW 模型目录获取失败；请检查宿主凭据、网关与网络。未输出原始错误。");
			}
			// 即使协调器复用了其他调用方的成功结果，本调用方已取消也不能报告成功。
			if (caller?.aborted || outcome.aborted) throw new Error("TSGW 模型刷新已取消。");
			if (outcome.errors?.has(PROVIDER_ID))
				throw new Error("TSGW 模型目录获取失败，保留原目录；请检查宿主凭据、网关与网络。");
			if (force && outcome.networkSucceeded !== true)
				throw new Error("TSGW 未完成强制联网刷新；不能将旧缓存当作本次刷新结果。");
			const details = outcome.summary;
			if (!details)
				throw new Error("未确认当前完整网关目录已写入缓存文件；不能将旧文件当作本次刷新结果。provider 可能已经更新。");
			// 普通请求要求相对本次开始时间仍新鲜；force 可复用先启动且仍未结束的任务。
			if (!force && details.storedAt < startedAt - DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS + 1)
				throw new Error("未确认当前完整网关目录已写入缓存文件；不能将旧文件当作本次刷新结果。provider 可能已经更新。");
			return { content: [{ type: "text", text: JSON.stringify(details) }], details, structuredContent: { ...details } };
		},
	});
}
