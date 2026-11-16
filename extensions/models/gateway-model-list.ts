import type { FetchGatewayModelIdsResult } from "./gateway-catalog.ts";

/** 只用目录项的 Magpie 特征做简单识别，不承担网关身份认证。 */
export function parseGatewayModelList(payload: unknown): FetchGatewayModelIdsResult {
	if (!payload || typeof payload !== "object")
		return { ok: false, reason: "invalid-data" };
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data)) return { ok: false, reason: "invalid-data" };
	const ids = new Set<string>();
	let magpie: true | undefined;
	for (const item of data) {
		if (!item || typeof item !== "object") continue;
		const { id, magpie_label: label } = item as { id?: unknown; magpie_label?: unknown };
		if (typeof id !== "string" || !id.trim()) continue;
		ids.add(id.trim());
		if (typeof label === "string") magpie = true;
	}
	if (!ids.size) return { ok: false, reason: "empty" };
	return { ok: true, ids: [...ids], ...(magpie ? { magpie } : {}) };
}
