import { deepStrictEqual, equal, match, strictEqual } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import registerTsgw from "../../index.ts";
import { FakePi, withAgentDir } from "#tsgw/test-support.test";
import { PROVIDER_ID } from "#tsgw/models/catalog";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL,
	gatewayModelCacheScope,
	saveGatewayModelCache,
} from "#tsgw/models/gateway-catalog";

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 1));
	}
	throw new Error(message);
}

function idsOf(models: Array<{ id: string }>): string[] {
	return models.map(model => model.id);
}

test("Qwen 接入参考仍受网关交集过滤，include 不能恢复已移除 ID", async () => {
	const previousFetch = globalThis.fetch;
	try {
		const root = `https://${randomUUID()}.invalid`;
		await withAgentDir({ tsgw: { baseUrl: root, includeModels: ["qwen3.7-plus", "qwen3.7-max"] } }, async dir => {
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key: "qwen-test-key" } }));
			let calls = 0;
			globalThis.fetch = async () => {
				calls++;
				return Response.json({ data: [{ id: "qwen3.7-max" }] });
			};
			const pi = new FakePi();
			await registerTsgw(pi);
			equal(calls, 0, "工厂只应用本地快照，不因 include 请求网关");
			const provider = pi.providers[0].config as { models: Array<{ id: string; api: string }> };
			deepStrictEqual(provider.models.map(({ id }) => id), [],
				"静态保留的 qwen3.7-plus 不在网关列表时不可由 include 增加；已删除 ID 也不能通过 include 恢复");
		});
	} finally { globalThis.fetch = previousFetch; }
});

test("分类启动目录：缓存交集与过滤生效，不额外联网；状态计数包含 classifier", async () => {
	const previousFetch = globalThis.fetch;
	try {
		const root = `https://${randomUUID()}.invalid`;
		await withAgentDir({ tsgw: { baseUrl: root, excludeModels: ["jev-*"], includeModels: ["jev-preview", "SemIf"] } }, async dir => {
			const key = "classifier-startup-test-key";
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
			saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"), gatewayModelCacheScope(root, key),
				["jev-latest", "jev-preview", "SemIf"], Date.now());
			let calls = 0;
			globalThis.fetch = async () => { calls++; throw new Error("分类启动缓存不应联网"); };
			const pi = new FakePi();
			await registerTsgw(pi);
			const provider = pi.providers[0].config as { models: Array<{ id: string; type?: string }> };
			deepStrictEqual(provider.models.map(({ id, type }) => ({ id, type })), [{ id: "jev-preview", type: "classifier" }]);
			equal(calls, 0);
			let label = "";
			const ctx = { hasUI: true, model: undefined, thinkingLevel: "off",
				modelRegistry: { getProviderAuthStatus: () => ({ configured: true }) },
				ui: { setStatus: (statusKey: string, text: string) => { if (statusKey === "command:/tsgw") label = text; } },
			};
			pi.invoke("session_start", { reason: "startup" }, ctx);
			try {
				match(label, /1/);
				equal(calls, 0, "新鲜缓存不启动后台网络恢复");
				equal(pi.activeTools.includes("tsgw_search"), false);
			} finally {
				pi.invoke("session_shutdown", {}, ctx);
			}
		});
	} finally { globalThis.fetch = previousFetch; }
});

for (const scenario of ["fresh", "expired", "wrong-key", "no-cache", "no-auth"] as const) {
	test(`工厂本地目录：${scenario} 均不联网`, async () => {
		const previousFetch = globalThis.fetch;
		try {
			const root = `https://${randomUUID()}.invalid`;
			await withAgentDir({ tsgw: { baseUrl: root } }, async dir => {
				const key = "factory-local-key";
				if (scenario !== "no-auth")
					writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
				if (scenario === "fresh" || scenario === "expired") {
					saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"),
						gatewayModelCacheScope(root, key), ["gpt-6-luna"],
						Date.now() - (scenario === "expired" ? TTL + 60_000 : 60_000));
				} else if (scenario === "wrong-key") {
					saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"),
						gatewayModelCacheScope(root, "other-key"), ["wrong-key-model"], Date.now());
				}
				let calls = 0;
				globalThis.fetch = async () => {
					calls++;
					throw new Error("工厂初始化不得联网");
				};
				const pi = new FakePi();
				await registerTsgw(pi);
				equal(calls, 0, `${scenario} 场景工厂初始化必须零网络`);
				const provider = pi.providers[0].config as { models: Array<{ id: string }> };
				deepStrictEqual(idsOf(provider.models),
					scenario === "fresh" || scenario === "expired" ? ["gpt-6-luna"] : [],
					"仅应用当前 baseUrl 与凭据作用域内已保存的本地快照");
			});
		} finally { globalThis.fetch = previousFetch; }
	});
}

for (const expired of [false, true]) {
	test(`refreshModels：${expired ? "过期" : "新鲜"}缓存需显式 session_start，非 force 先查本地`, async () => {
		const previousFetch = globalThis.fetch;
		try {
			const root = `https://${randomUUID()}.invalid`;
			await withAgentDir({ tsgw: { baseUrl: root } }, async dir => {
				const key = "callback-key";
				writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
				saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"), gatewayModelCacheScope(root, key),
					["gpt-6-luna"], Date.now() - (expired ? TTL + 60_000 : TTL - 60_000));
				let calls = 0;
				globalThis.fetch = async () => {
					calls++;
					return Response.json({ data: [{ id: "gpt-6-luna" }, { id: "glm-5.2" }] });
				};
				const pi = new FakePi();
				await registerTsgw(pi);
				const provider = pi.providers[0].config as {
					models: Array<{ id: string }>;
					refreshModels: (context: {
						allowNetwork: boolean;
						force?: boolean;
						credential: { type: "api_key"; key: string };
						signal: AbortSignal;
					}) => Promise<Array<{ id: string }>>;
				};
				const signal = new AbortController().signal;
				const beforeStart = await provider.refreshModels({
					allowNetwork: true,
					credential: { type: "api_key", key }, signal,
				});
				deepStrictEqual(idsOf(beforeStart), ["gpt-6-luna"]);
				equal(calls, 0, "session_start 前非 force 只能返回本地快照");

				const ctx = { hasUI: false, model: undefined, thinkingLevel: "off",
					modelRegistry: { getProviderAuthStatus: () => ({ configured: true }) },
				};
				pi.invoke("session_start", { reason: "startup" }, ctx);
				try {
					const localOnly = await provider.refreshModels({
						allowNetwork: false, force: true,
						credential: { type: "api_key", key }, signal,
					});
					deepStrictEqual(idsOf(localOnly), ["gpt-6-luna"]);
					equal(calls, 0, "allowNetwork:false 始终只读本地");

					const automatic = await provider.refreshModels({
						allowNetwork: true, force: false,
						credential: { type: "api_key", key }, signal,
					});
					if (expired) {
						equal(calls, 1, "非 force 发现缓存过期后必须联网");
						deepStrictEqual(idsOf(automatic).sort(), ["gpt-6-luna", "glm-5.2"].sort());
						const again = await provider.refreshModels({
							allowNetwork: true, force: false,
							credential: { type: "api_key", key }, signal,
						});
						deepStrictEqual(idsOf(again).sort(), ["gpt-6-luna", "glm-5.2"].sort());
						equal(calls, 1, "联网后的新缓存不再重复请求");
					} else {
						equal(calls, 0, "非 force 命中新鲜缓存时不联网");
						deepStrictEqual(idsOf(automatic), ["gpt-6-luna"]);
					}
				} finally {
					pi.invoke("session_shutdown", {}, ctx);
				}
			});
		} finally { globalThis.fetch = previousFetch; }
	});
}

test("session_start 前显式 force 可联网，兼容无会话 CLI", async () => {
	const previousFetch = globalThis.fetch;
	try {
		const root = `https://${randomUUID()}.invalid`;
		await withAgentDir({ tsgw: { baseUrl: root } }, async dir => {
			const key = "presession-force-key";
			writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
			saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"), gatewayModelCacheScope(root, key),
				["gpt-6-luna"], Date.now() - 60_000);
			let calls = 0;
			globalThis.fetch = async () => {
				calls++;
				return Response.json({ data: [{ id: "gpt-6-luna" }, { id: "glm-5.2" }] });
			};
			const pi = new FakePi();
			await registerTsgw(pi);
			const provider = pi.providers[0].config as {
				refreshModels: (context: {
					allowNetwork: boolean;
					force?: boolean;
					credential: { type: "api_key"; key: string };
					signal: AbortSignal;
				}) => Promise<Array<{ id: string }>>;
			};
			const signal = new AbortController().signal;
			const local = await provider.refreshModels({
				allowNetwork: true, credential: { type: "api_key", key }, signal,
			});
			deepStrictEqual(idsOf(local), ["gpt-6-luna"]);
			equal(calls, 0, "未显式 force 时预 session 不联网");

			const forced = await provider.refreshModels({
				allowNetwork: true, force: true, credential: { type: "api_key", key }, signal,
			});
			deepStrictEqual(idsOf(forced).sort(), ["gpt-6-luna", "glm-5.2"].sort());
			equal(calls, 1, "预 session 显式 force 绕过新鲜缓存并联网");

			const cached = await provider.refreshModels({
				allowNetwork: true, credential: { type: "api_key", key }, signal,
			});
			deepStrictEqual(idsOf(cached).sort(), ["gpt-6-luna", "glm-5.2"].sort());
			equal(calls, 1, "强制刷新写入的新鲜缓存不再重复请求");
		});
	} finally { globalThis.fetch = previousFetch; }
});

test("session_start 先本地 restore 再后台联网；退出取消进行中的恢复请求", async () => {
	const root = `https://${randomUUID()}.invalid`;
	await withAgentDir({ tsgw: { baseUrl: root } }, async dir => {
		const key = "recovery-key";
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
		const pi = new FakePi();
		await registerTsgw(pi);
		type RecoveryOptions = { providers: string[]; force: boolean; allowNetwork?: boolean; signal: AbortSignal };
		let restoreCalls = 0;
		let refreshCalls = 0;
		let aborted = false;
		let restoreOptions: RecoveryOptions | undefined;
		let refreshOptions: RecoveryOptions | undefined;
		const ctx = {
			hasUI: false,
			model: undefined,
			thinkingLevel: "off",
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: true }),
				refresh(options: RecoveryOptions) {
					if (options.allowNetwork === false) {
						restoreCalls++;
						restoreOptions = options;
						return Promise.resolve({ errors: new Map() });
					}
					refreshCalls++;
					refreshOptions = options;
					return new Promise<{ aborted: boolean }>(resolve => {
						const done = (): void => { aborted = true; resolve({ aborted: true }); };
						if (options.signal.aborted) done();
						else options.signal.addEventListener("abort", done, { once: true });
					});
				},
			},
		};
		try {
			const returned = pi.invoke("session_start", { reason: "startup" }, ctx);
			strictEqual(returned, undefined, "session_start 不得返回后台恢复 Promise");
			equal(restoreCalls + refreshCalls, 0, "恢复请求必须让 session_start 先返回");
			await waitFor(() => restoreCalls === 1, "后台本地 restore 没有在非阻塞窗口内启动");
			deepStrictEqual(restoreOptions?.providers, [PROVIDER_ID]);
			equal(restoreOptions?.force, false, "后台 restore 使用 force:false");
			equal(restoreOptions?.allowNetwork, false, "后台 restore 必须禁止联网");
			equal(restoreOptions?.signal instanceof AbortSignal, true);
			await waitFor(() => refreshCalls === 1, "restore 后没有启动后台联网恢复");
			deepStrictEqual(refreshOptions?.providers, [PROVIDER_ID]);
			equal(refreshOptions?.force, false, "后台恢复使用 force:false");
			equal(refreshOptions?.allowNetwork, undefined, "联网恢复交给宿主默认联网许可");
			equal(refreshOptions?.signal instanceof AbortSignal, true);
			pi.invoke("session_shutdown", {}, ctx);
			equal(aborted, true, "退出必须取消进行中的恢复请求");
			await new Promise<void>(resolve => setTimeout(resolve, 10));
			equal(restoreCalls, 1, "退出后不得重复本地 restore");
			equal(refreshCalls, 1, "退出后不得再次发起恢复请求");
		} finally {
			pi.invoke("session_shutdown", {}, ctx);
		}
	});
});
