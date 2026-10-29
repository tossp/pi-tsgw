import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession, ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_ROOT } from "#tsgw/host-test-support.test";
import { getGatewayCatalogService } from "#tsgw/models/gateway-catalog-service";
import {
	DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL,
	gatewayModelCacheScope,
	saveGatewayModelCache,
} from "#tsgw/models/gateway-catalog";

type Sdk = typeof import("@earendil-works/pi-coding-agent");
type Runtime = import("@earendil-works/pi-coding-agent").ModelRuntime;

function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位源码入口");
		dir = parent;
	}
}

const cachePath = (sandbox: HostSandbox) => join(sandbox.agentDir, "tsgw", "models-cache.json");
const configure = (sandbox: HostSandbox, extra: Record<string, unknown> = {}) =>
	writeFileSync(join(sandbox.agentDir, "settings.json"),
		JSON.stringify({ tsgw: { baseUrl: TEST_ROOT, ...extra } }));
const authenticate = (sandbox: HostSandbox, key: string) =>
	writeFileSync(join(sandbox.agentDir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
const seed = (sandbox: HostSandbox, key: string, ids: string[], storedAt = Date.now()) =>
	saveGatewayModelCache(cachePath(sandbox), gatewayModelCacheScope(TEST_ROOT, key), ids, storedAt);

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<T>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate: () => boolean, label: string, ms = 5_000): Promise<void> {
	const started = Date.now();
	while (!predicate()) {
		if (Date.now() - started > ms) throw new Error(`等待${label}超时`);
		await new Promise(resolve => setTimeout(resolve, 20));
	}
}

/** 除专门的 dispose 语义测试外，先让扩展清理恢复定时器与挂起请求。 */
async function shutdownSession(session: AgentSession): Promise<void> {
	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	session.dispose();
}

/** 仅拦截合成 /v1/models；其余请求仍由 HostSandbox 的真实隔离守卫处理。 */
function interceptCatalog(sandbox: HostSandbox, key: string, hold = false) {
	const sandboxFetch = globalThis.fetch;
	const hits: string[] = [];
	const signals: AbortSignal[] = [];
	let calls = 0;
	let started!: () => void;
	const startedPromise = new Promise<void>(resolve => { started = resolve; });
	let released!: () => void;
	const releasedPromise = new Promise<void>(resolve => { released = resolve; });
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (request.url === `${TEST_ROOT}/v1/models`) {
			assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
			calls++;
			hits.push(request.url);
			signals.push(request.signal);
			started();
			if (hold) {
				await Promise.race([
					releasedPromise,
					new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true })),
				]);
				request.signal.throwIfAborted();
			}
			if (sandbox.catalogFails) return new Response("fixture unavailable", { status: 503 });
			return Response.json({ data: sandbox.catalogIds.map(id => ({ id })) });
		}
		return sandboxFetch(request);
	};
	return {
		hits, signals, calls: () => calls, started: startedPromise, release: released,
		restore: () => { globalThis.fetch = sandboxFetch; },
	};
}

async function openHost(sandbox: HostSandbox, sdk: Sdk, options: {
	key?: string; settings?: Record<string, unknown>; factories?: Array<(pi: ExtensionAPI) => void>;
	beforeBind?: (runtime: Runtime) => void | Promise<void>;
} = {}) {
	configure(sandbox, options.settings);
	if (options.key) authenticate(sandbox, options.key);
	const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [],
		compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
		cacheWarming: "off", transport: "sse" });
	const loader = new sdk.DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
		settingsManager, additionalExtensionPaths: [sourceEntry()], noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "隔离目录宿主回归，仅访问合成 fixture。",
		...(options.factories ? { extensionFactories: options.factories } : {}) });
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const runtime = await sdk.ModelRuntime.create({
		authPath: join(sandbox.agentDir, "auth.json"),
		modelsPath: join(sandbox.agentDir, "models.json"),
		modelsStorePath: join(sandbox.agentDir, "models-store.json"),
		refreshOnCreate: false, allowModelNetwork: false,
	});
	const errors: ExtensionError[] = [];
	const created = await sdk.createAgentSession({
		cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime,
		resourceLoader: loader, settingsManager,
		sessionManager: sdk.SessionManager.inMemory(sandbox.cwd),
		tools: ["read"], thinkingLevel: "off",
	});
	if (options.beforeBind) await options.beforeBind(runtime);
	await timeout(created.session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } }),
		3_000, "bindExtensions");
	return { loader, runtime, session: created.session, errors };
}

const modelIds = (runtime: Runtime) =>
	runtime.getModels("tsgw").map(model => model.id).sort();

let sdkPromise: Promise<Sdk> | undefined;
async function sdkFor(): Promise<Sdk> {
	sdkPromise ??= import("@earendil-works/pi-coding-agent");
	return sdkPromise;
}

async function withSandbox(run: (sandbox: HostSandbox) => Promise<void>): Promise<void> {
	const sandbox = new HostSandbox();
	try { await run(sandbox); } finally { sandbox.restore(); }
}

test("Pi 1.2 真实宿主：目录加载、命令刷新与退出语义", { timeout: 120_000 }, async t => {
	await t.test("两个真实会话和一个后台 runtime 共享 GET，退出一个会话不取消其余登记", async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			const key = `multi-runtime-${randomUUID()}`;
			const catalog = interceptCatalog(sandbox, key, true);
			const sessions: AgentSession[] = [];
			try {
				const first = await openHost(sandbox, sdk, { key });
				sessions.push(first.session);
				await timeout(catalog.started, 3000, "首个实例后台 GET");
				const second = await openHost(sandbox, sdk, { key });
				sessions.push(second.session);
				const background = await sdk.createAgentSessionServices({ cwd: sandbox.cwd,
					agentDir: sandbox.agentDir,
					settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
					resourceLoaderOptions: { additionalExtensionPaths: [sourceEntry()], noSkills: true,
						noPromptTemplates: true, noThemes: true, noContextFiles: true } });
				const external = background.modelRuntime.refresh({ providers: ["tsgw"], force: true });
				await waitFor(() => getGatewayCatalogService(TEST_ROOT, key, cachePath(sandbox)).refreshKind() === "force",
					"后台 runtime 的 force 进入共享 GET");
				// 正常进入真实 runtime 的 provider，不修改/伪造宿主 publication。
				await waitFor(() => {
					const label = second.runtime.getProviderAuthStatus("tsgw");
					return label.configured;
				}, "第二实例的宿主认证快照");
				await shutdownSession(first.session);
				sessions.shift();
				assert.equal(catalog.calls(), 1);
				assert.equal(catalog.signals[0].aborted, false);
				sandbox.catalogIds = ["gpt-6-sol", "jev-latest", "gpt-image-2.5-flare", "unknown"];
				catalog.release();
				const result = await timeout(external, 3000, "后台 runtime 强制刷新");
				assert.equal(result.aborted, false);
				assert.equal(result.errors.size, 0, [...result.errors.values()].map(error => error.message).join("; "));
				const mixedIds = (runtime: Runtime) => runtime.getAllModels("tsgw").map(model => model.id).sort();
				await waitFor(() => mixedIds(second.runtime).length === 3, "第二会话独立登记");
				const expected = ["gpt-6-sol", "gpt-image-2.5-flare", "jev-latest"];
				assert.deepEqual(mixedIds(second.runtime), expected);
				assert.deepEqual(mixedIds(background.modelRuntime), expected);
				assert.deepEqual(second.runtime.getAvailableSnapshot().filter(m => m.provider === "tsgw")
					.map(m => m.id), ["gpt-6-sol"], "聊天选择器同步且不混入图片/分类模型");
				assert.equal(catalog.calls(), 1);
				assert.deepEqual(first.errors, []);
				assert.deepEqual(second.errors, []);
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				for (const session of sessions) await shutdownSession(session);
				catalog.restore();
			}
		});
	});
	await t.test("带凭据无缓存：加载/绑定零网络，挂起请求不阻塞，放行后 registry 更新；dispose 不发 shutdown", async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			assert.match(sdk.VERSION, /^1\.2\./, "此回归的已验证基线是 Pi 1.2 SDK");
			const key = `no-cache-${randomUUID()}`;
			const catalog = interceptCatalog(sandbox, key, true);
			let shutdowns = 0;
			const recorder = (pi: ExtensionAPI) => {
				pi.on("session_shutdown", () => { shutdowns++; });
			};
			let session: AgentSession | undefined;
			try {
				configure(sandbox, { excludeModels: ["unknown-*"] });
				authenticate(sandbox, key);
				const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [] });
				const loader = new sdk.DefaultResourceLoader({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
					settingsManager, additionalExtensionPaths: [sourceEntry()], noSkills: true,
					noPromptTemplates: true, noThemes: true, noContextFiles: true,
					extensionFactories: [recorder] });
				await loader.reload();
				assert.deepEqual(loader.getExtensions().errors, []);
				assert.equal(catalog.calls(), 0, "loader.reload 只读存储凭据，不应联网");
				const runtime = await sdk.ModelRuntime.create({
					authPath: join(sandbox.agentDir, "auth.json"),
					modelsPath: join(sandbox.agentDir, "models.json"),
					modelsStorePath: join(sandbox.agentDir, "models-store.json"),
					refreshOnCreate: false, allowModelNetwork: false,
				});
				// 不人工预填充：真实 refreshOnCreate:false 运行时应由 session_start 的恢复流程读取凭据。
				const errors: ExtensionError[] = [];
				const created = await sdk.createAgentSession({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
					modelRuntime: runtime, resourceLoader: loader, settingsManager,
					sessionManager: sdk.SessionManager.inMemory(sandbox.cwd),
					tools: ["read"], thinkingLevel: "off" });
				session = created.session;
				const before = Date.now();
				await timeout(session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } }),
					3_000, "bindExtensions");
				assert.ok(Date.now() - before < 3_000);
				await timeout(catalog.started, 3_000, "后台 /v1/models 启动");
				assert.deepEqual(errors, [], "session_start 不得因 auth snapshot 未填充而误报");
				assert.equal(catalog.hits.length, 1, "后台恢复只发起一次目录请求");
				assert.deepEqual(modelIds(runtime), [], "挂起期间不阻塞会话，也没有伪造模型");
				sandbox.catalogIds = ["gpt-6-sol", "deepseek-flash", "not-in-static-catalog"];
				catalog.release();
				await waitFor(() => modelIds(runtime).length === 2, "后台目录应用到 registry");
				assert.deepEqual(modelIds(runtime), ["deepseek-flash", "gpt-6-sol"]);
				const cached = JSON.parse(readFileSync(cachePath(sandbox), "utf8")) as { ids: string[] };
				assert.deepEqual(cached.ids, ["gpt-6-sol", "deepseek-flash", "not-in-static-catalog"]);
				assert.equal(catalog.calls(), 1);
				session.dispose();
				session = undefined;
				await new Promise(resolve => setTimeout(resolve, 20));
				assert.equal(shutdowns, 0, "核对：AgentSession.dispose 不发出 session_shutdown");
				assert.deepEqual(errors, []);
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				// dispose-only 例外：本测试专门核对 dispose 不发出 session_shutdown，故不显式 emit。
				session?.dispose();
				catalog.restore();
			}
		});
	});

	await t.test("allowNetwork:false 从磁盘恢复且不取消共享获取；新鲜非 force 不联网",  async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			const key = `restore-${randomUUID()}`;
			const catalog = interceptCatalog(sandbox, key, true);
			let session: AgentSession | undefined;
			try {
				seed(sandbox, key, ["gpt-6-sol"], Date.now() - TTL - 60_000);
				const host = await openHost(sandbox, sdk, { key });
				session = host.session;
				const { runtime, errors } = host;
				await waitFor(() => modelIds(runtime).length === 1, "过期缓存恢复");
				assert.deepEqual(modelIds(runtime), ["gpt-6-sol"]);
				await timeout(catalog.started, 3_000, "后台过期缓存恢复请求");
				const hits = catalog.hits.length;
				const restored = await runtime.refresh({ providers: ["tsgw"], allowNetwork: false, force: true });
				assert.deepEqual([...restored.errors], []);
				assert.equal(catalog.hits.length, hits, "allowNetwork:false 即使 force 也只读本地缓存");
				assert.deepEqual(modelIds(runtime), ["gpt-6-sol"]);
				assert.equal(catalog.signals[0].aborted, false,
					"宿主取消旧 publication 不等于取消插件仍在等待的实际 GET");
				sandbox.catalogIds = ["gpt-6-sol", "synthetic-completed-catalog"];
				catalog.release();
				await waitFor(() => JSON.parse(readFileSync(cachePath(sandbox), "utf8")).ids
					.includes("synthetic-completed-catalog"), "共享 GET 完成并写入缓存");
				seed(sandbox, key, ["deepseek-flash", "glm-5.2"], Date.now() + 1_000);
				const before = modelIds(runtime);
				const fresh = await runtime.refresh({ providers: ["tsgw"], allowNetwork: true, force: false });
				assert.deepEqual([...fresh.errors], []);
				assert.equal(catalog.hits.length, hits, "新鲜缓存非 force 不联网");
				assert.deepEqual(before, ["gpt-6-sol"]);
				assert.deepEqual(modelIds(runtime), ["deepseek-flash", "glm-5.2"],
					"宿主刷新前后的模型必须同步");
				assert.deepEqual(errors, []);
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				if (session) await shutdownSession(session);
				catalog.restore();
			}
		});
	});

	await t.test("新鲜缓存 session_start 吸收绑定前的新磁盘目录，不联网且 registry 同步", async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			const key = `fresh-${randomUUID()}`;
			seed(sandbox, key, ["gpt-6-sol"]);
			const catalog = interceptCatalog(sandbox, key);
			let session: AgentSession | undefined;
			let before: string[] = [];
			try {
				const host = await openHost(sandbox, sdk, { key, beforeBind: async runtime => {
					// 先让注册后的本地刷新落定，再写入新文件，确保更新只能来自 session_start 恢复。
					await waitFor(() => modelIds(runtime).length === 1, "启动时新鲜缓存应用到 registry");
					before = modelIds(runtime);
					seed(sandbox, key, ["deepseek-flash", "glm-5.2"], Date.now() + 1_000);
				} });
				session = host.session;
				await waitFor(() => modelIds(host.runtime).length === 2, "session_start 吸收绑定前新磁盘");
				assert.deepEqual(before, ["gpt-6-sol"], "绑定前仍为启动时的新鲜缓存");
				assert.deepEqual(modelIds(host.runtime), ["deepseek-flash", "glm-5.2"],
					"session_start 恢复前后的模型必须同步到新磁盘");
				assert.deepEqual(host.errors, []);
				assert.equal(catalog.calls(), 0, "新鲜缓存启动不得联网");
				await new Promise(resolve => setTimeout(resolve, 150));
				assert.equal(catalog.calls(), 0, "session_start 后也不得补发网络请求");
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				if (session) await shutdownSession(session);
				catalog.restore();
			}
		});
	});

	await t.test("退出取消：session_shutdown 中止挂起的目录请求", async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			const key = `shutdown-${randomUUID()}`;
			const catalog = interceptCatalog(sandbox, key, true);
			let session: AgentSession | undefined;
			try {
				const host = await openHost(sandbox, sdk, { key });
				session = host.session;
				const { errors } = host;
				await timeout(catalog.started, 3_000, "挂起目录请求");
				const pending = catalog.signals[0];
				assert.equal(pending.aborted, false);
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				await waitFor(() => pending.aborted, "session_shutdown 取消挂起请求");
				assert.deepEqual(errors, []);
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				if (session) await shutdownSession(session);
				catalog.restore();
			}
		});
	});

	await t.test("真实宿主不再注册模型可调用刷新工具；/tsgw-refresh 命令仍经宿主 provider 刷新目录", async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			const key = `command-${randomUUID()}`;
			seed(sandbox, key, ["gpt-6-sol"]);
			const catalog = interceptCatalog(sandbox, key);
			let session: AgentSession | undefined;
			try {
				const host = await openHost(sandbox, sdk, { key });
				session = host.session;
				const { runtime, errors } = host;
				await waitFor(() => modelIds(runtime).length === 1 &&
					runtime.getProviderAuthStatus("tsgw").configured, "session_start 恢复新鲜缓存与凭据快照");
				assert.deepEqual(modelIds(runtime), ["gpt-6-sol"]);
				assert.equal(catalog.calls(), 0, "新鲜缓存启动不得联网");
				assert.equal(session.extensionRunner.getToolDefinition("tsgw_refresh_models"), undefined,
					"真实宿主不得再注册模型可调用的 tsgw_refresh_models");
				assert.equal(session.extensionRunner.getAllRegisteredTools()
					.some(tool => tool.definition.name === "tsgw_refresh_models"), false,
					"工具清单中不得残留 tsgw_refresh_models");

				const command = session.extensionRunner.getCommand("tsgw-refresh");
				assert.ok(command, "真实宿主必须保留 /tsgw-refresh 命令");
				sandbox.catalogIds = ["glm-5.2", "deepseek-flash"];
				await command.handler("", session.extensionRunner.createCommandContext());
				assert.equal(catalog.calls(), 1, "命令刷新必须经宿主 provider 发起一次目录 GET");
				assert.deepEqual(modelIds(runtime), ["deepseek-flash", "glm-5.2"],
					"命令刷新必须把网络目录应用到真实 registry");
				const cached = JSON.parse(readFileSync(cachePath(sandbox), "utf8")) as { ids: string[] };
				assert.deepEqual(cached.ids, ["glm-5.2", "deepseek-flash"]);
				assert.deepEqual(errors, []);
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				if (session) await shutdownSession(session);
				catalog.restore();
			}
		});
	});

	await t.test("PI_OFFLINE 尊重宿主默认无网络：启动、强制刷新与后台恢复均不请求 /v1/models", async () => {
		await withSandbox(async sandbox => {
			const sdk = await sdkFor();
			process.env.PI_OFFLINE = "1";
			const key = `offline-${randomUUID()}`;
			const catalog = interceptCatalog(sandbox, key);
			let session: AgentSession | undefined;
			try {
				const host = await openHost(sandbox, sdk, { key });
				session = host.session;
				const { runtime, errors } = host;
				await new Promise(resolve => setTimeout(resolve, 150));
				assert.equal(catalog.calls(), 0, "离线启动不得联网");
				const refreshed = await runtime.refresh({ providers: ["tsgw"], force: true });
				assert.deepEqual([...refreshed.errors], []);
				assert.equal(catalog.calls(), 0, "PI_OFFLINE 下宿主默认 allowNetwork=false");
				assert.deepEqual(modelIds(runtime), []);
				assert.deepEqual(errors, []);
				assert.deepEqual(sandbox.blocked, []);
			} finally {
				if (session) await shutdownSession(session);
				catalog.restore();
				delete process.env.PI_OFFLINE;
			}
		});
	});
});
