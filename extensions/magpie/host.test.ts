import { test } from "node:test";
import { deepStrictEqual, equal, ok, match } from "node:assert/strict";
import { join } from "node:path";
import type { AgentSession, ExtensionError, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import { modelsForRoot } from "#tsgw/models/catalog";
import { getGatewayCatalogService } from "#tsgw/models/gateway-catalog-service";
import { gatewayModelCacheScope, saveGatewayModelCache } from "#tsgw/models/gateway-catalog";
import { registerMagpie } from "./controller.ts";

test("真实 Pi SDK：正常任务最终完成才读取全局卡片，使用宿主认证且不绑定会话", { timeout: 60_000 }, async () => {
	const sandbox = new HostSandbox();
	let session: AgentSession | undefined;
	try {
		const sdk = await import("@earendil-works/pi-coding-agent");
		const file = join(sandbox.agentDir, "tsgw", "models-cache.json");
		saveGatewayModelCache(file, gatewayModelCacheScope(TEST_ROOT, TEST_KEY), ["deepseek-flash"], Date.now(), true);
		const catalog = getGatewayCatalogService(TEST_ROOT, TEST_KEY, file);
		await catalog.request(TEST_KEY, { allowNetwork: false });
		const intercepted = globalThis.fetch;
		const queries: URL[] = [];
		let read!: () => void;
		const firstRead = new Promise<void>(resolve => { read = resolve; });
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.origin === TEST_ROOT && url.pathname === "/v1/magpie/quotas/cards") {
				equal(request.method, "GET");
				equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
				queries.push(url);
				read();
				return Response.json({ object: "list", data: [{ provider: "codex", windows: [{ name: "week", used: 20 }] }] });
			}
			return intercepted(request);
		};
		const settings = sdk.SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse" });
		let extension!: ReturnType<typeof registerMagpie>;
		const loader = new sdk.DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
			settingsManager: settings, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "隔离 Magpie 状态回归。",
			extensionFactories: [pi => {
				pi.registerProvider("tsgw", { baseUrl: `${TEST_ROOT}/v1`, api: "openai-responses", apiKey: TEST_KEY,
					models: modelsForRoot(TEST_ROOT, { include: ["deepseek-flash"], exclude: ["*"] }) });
				extension = registerMagpie(pi, { root: TEST_ROOT, gateway: () => catalog, onChange: () => {} });
			}],
		});
		await loader.reload();
		deepStrictEqual(loader.getExtensions().errors, []);
		const runtime = await sdk.ModelRuntime.create({ authPath: join(sandbox.agentDir, "auth.json"),
			modelsPath: join(sandbox.agentDir, "models.json"), modelsStorePath: join(sandbox.agentDir, "models-store.json"),
			refreshOnCreate: false, allowModelNetwork: false });
		await runtime.setRuntimeApiKey("tsgw", TEST_KEY);
		const created = await sdk.createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
			modelRuntime: runtime, resourceLoader: loader, settingsManager: settings,
			sessionManager: sdk.SessionManager.inMemory(sandbox.cwd), tools: [], thinkingLevel: "off" });
		session = created.session;
		const errors: ExtensionError[] = [];
		const ui = { select: async () => undefined, notify: () => {}, setStatus: () => {} } as unknown as ExtensionUIContext;
		await session.bindExtensions({ mode: "rpc", uiContext: ui, onError: error => { errors.push(error); } });
		const model = runtime.getModel("tsgw", "deepseek-flash");
		ok(model);
		await session.setModel(model);
		equal(queries.length, 0);
		await session.prompt("合成普通用户任务");
		await firstRead;
		await new Promise<void>(resolve => setImmediate(resolve));
		equal(queries.length, 1);
		equal(queries[0].searchParams.has("session"), false);
		match(extension.label()!, /80%/);
		await session.prompt("同一会话60秒内的第二个任务");
		await new Promise<void>(resolve => setImmediate(resolve));
		equal(queries.length, 1);
		equal(sandbox.requests.length, 2);
		deepStrictEqual(sandbox.blocked, []);
		deepStrictEqual(errors, []);
		catalog.invalidate();
	} finally {
		if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
		sandbox.restore();
	}
});
