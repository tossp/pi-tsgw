import { deepStrictEqual, equal, match } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import registerTsgw from "../../index.ts";
import { FakePi, withAgentDir } from "../test-support.test.ts";
import { gatewayModelCacheScope, saveGatewayModelCache, STARTUP_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "../models/gateway-catalog.ts";

test("启动目录：7 天缓存、无缓存仅重试一次、失败提示与恢复", async () => {
	const previousFetch = globalThis.fetch;
	try {
		for (const scenario of ["fresh", "stale", "no-cache", "retry-success", "no-auth"] as const) {
			const root = `https://${randomUUID()}.invalid`;
			await withAgentDir({ tsgw: { baseUrl: root } }, async dir => {
				const key = "startup-test-key";
				if (scenario !== "no-auth") writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
				const storedAt = Date.now() - TTL + (scenario === "fresh" ? 100_000 : -100_000);
				if (scenario === "fresh" || scenario === "stale")
					saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"), gatewayModelCacheScope(root, key), ["gpt-6-luna"], storedAt);
				let calls = 0;
				globalThis.fetch = async () => {
					calls++;
					return scenario === "retry-success" && calls === 2
						? Response.json({ data: [{ id: "gpt-6-luna" }, { id: "unknown-model" }] })
						: new Response("unavailable", { status: 503 });
				};
				const pi = new FakePi();
				await registerTsgw(pi);
				const provider = pi.providers[0].config as {
					models: Array<{ id: string }>;
					refreshModels: (ctx: { allowNetwork: boolean; force: boolean; credential: { type: "api_key"; key: string }; signal: AbortSignal }) => Promise<Array<{ id: string }>>;
				};
				const startupCalls = calls;
				const automatic = await provider.refreshModels({ allowNetwork: true, force: false,
					credential: { type: "api_key", key }, signal: new AbortController().signal });
				deepStrictEqual(automatic, provider.models);
				equal(calls, startupCalls, "宿主启动后后台自动同步不能追加第三次请求或缩短七天窗口");
				equal(calls, scenario === "fresh" || scenario === "no-auth" ? 0 : scenario === "stale" ? 1 : 2);
				const available = scenario === "fresh" || scenario === "stale" || scenario === "retry-success";
				deepStrictEqual(provider.models.map(model => model.id), available ? ["gpt-6-luna"] : []);
				const notices: string[] = [];
				const ctx = { hasUI: true, model: undefined, thinkingLevel: "off", modelRegistry: {
					getProviderAuthStatus: () => ({ configured: scenario !== "no-auth" }),
				}, ui: { setStatus: () => {}, notify: (text: string) => notices.push(text) } };
				pi.invoke("session_start", { reason: "startup" }, ctx);
				pi.invoke("session_start", { reason: "new" }, ctx);
				equal(notices.length, scenario === "fresh" || scenario === "retry-success" ? 0 : 1);
				if (scenario === "stale") match(notices[0], /刷新失败.*沿用缓存/);
				if (scenario === "no-cache") match(notices[0], /无可用模型.*强制刷新/);
				// 无模型启动后仍可通过真实 provider 回调恢复，不要求重新加载。
				if (scenario === "no-cache") {
					globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-6-luna" }] });
					const recovered = await provider.refreshModels({ allowNetwork: true, force: true,
						credential: { type: "api_key", key }, signal: new AbortController().signal });
					deepStrictEqual(recovered.map(model => model.id), ["gpt-6-luna"]);
				}
			});
		}
	} finally { globalThis.fetch = previousFetch; }
});
