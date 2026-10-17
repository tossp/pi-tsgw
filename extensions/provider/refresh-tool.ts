import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PROVIDER_ID } from "../models/catalog.ts";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS, readGatewayModelCacheSummary } from "../models/gateway-catalog.ts";

/** 默认检查缓存时间；需要联网时复用宿主 provider 的强制刷新。 */
export function registerRefreshTool(pi: ExtensionAPI, cacheFilePath: string): void {
	pi.registerTool({
		name: "tsgw_refresh_models",
		label: "刷新 TSGW 模型目录",
		description: "获取 AIH 网关可用模型，默认复用 24 小时内的缓存；force=true 忽略有效期强制联网刷新。单次联网超时 5 秒，不发推理请求、不修改配置、不自动重试。返回缓存文件路径、网关模型数与获取时间；随后读取该文件的 ids 获取完整列表（含插件尚未登记的型号）。不自动登记未知型号。",
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
			const startedAt = Date.now();
			let details;
			let refreshed;
			try {
				caller?.throwIfAborted();
				if (!registry.getProviderAuthStatus(PROVIDER_ID).configured) throw new Error("缺少凭据");
				if (params.force !== true)
					details = readGatewayModelCacheSummary(cacheFilePath, startedAt - DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS + 1);
				if (!details) {
					refreshed = await registry.refresh({ providers: [PROVIDER_ID], force: true, signal: caller });
					caller?.throwIfAborted();
				}
			} catch {
				throw new Error(caller?.aborted ? "TSGW 模型刷新已取消。" : "TSGW 模型刷新失败；请检查宿主凭据、网关与网络。未输出原始错误。");
			}
			if (refreshed?.aborted) throw new Error("TSGW 模型刷新已取消。");
			if (refreshed?.errors?.has(PROVIDER_ID))
				throw new Error("TSGW 模型刷新失败，保留原目录；请检查宿主凭据、网关与网络。");
			details ??= readGatewayModelCacheSummary(cacheFilePath, startedAt);
			if (!details)
				throw new Error("未确认本次完整网关目录已写入缓存文件；不能将旧文件当作本次刷新结果。provider 可能已经更新。");
			return { content: [{ type: "text", text: JSON.stringify(details) }], details, structuredContent: details };
		},
	});
}
