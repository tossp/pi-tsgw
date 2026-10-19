import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import { gatewayModelCacheScope, saveGatewayModelCache } from "#tsgw/models/gateway-catalog";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(done => { resolve = done; });
	return { promise, resolve };
}

function sourceEntry(): string {
	let path = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const manifest = join(path, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(path, "index.ts");
		const parent = dirname(path);
		assert.notEqual(parent, path);
		path = parent;
	}
}

function timeout<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([promise, new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}未到达`)), 5000);
	})]).finally(() => clearTimeout(timer));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`${label}未到达`);
		await new Promise(resolve => setImmediate(resolve));
	}
}

async function fixture(run: (context: Awaited<ReturnType<typeof open>>) => Promise<void>, offline = false) {
	const sandbox = new HostSandbox();
	let context: Awaited<ReturnType<typeof open>> | undefined;
	try {
		if (offline) process.env.PI_OFFLINE = "1";
		context = await open(sandbox);
		await run(context);
	} finally {
		if (context?.session) {
			await context.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			context.session.dispose();
		}
		sandbox.restore();
	}
}

async function open(sandbox: HostSandbox) {
	const sdk = await import("@earendil-works/pi-coding-agent");
	writeFileSync(join(sandbox.agentDir, "settings.json"), JSON.stringify({ tsgw: { baseUrl: TEST_ROOT } }));
	writeFileSync(join(sandbox.agentDir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key: TEST_KEY } }));
	saveGatewayModelCache(join(sandbox.agentDir, "tsgw", "models-cache.json"),
		gatewayModelCacheScope(TEST_ROOT, TEST_KEY), ["gpt-6-luna"], Date.now() - 1000);
	sandbox.catalogIds = ["gpt-6-sol"];
	const createServices = () => sdk.createAgentSessionServices({ cwd: sandbox.cwd, agentDir: sandbox.agentDir,
		settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [],
			compaction: { enabled: false }, cacheWarming: "off" }),
		resourceLoaderOptions: { additionalExtensionPaths: [sourceEntry()], noSkills: true,
			noPromptTemplates: true, noThemes: true, noContextFiles: true } });
	const services = await createServices();
	const runtime = services.modelRuntime;
	const { session } = await sdk.createAgentSessionFromServices({ services,
		sessionManager: sdk.SessionManager.inMemory(sandbox.cwd), tools: ["read"] });
	assert.equal(sandbox.catalogCalls, 0);
	assert.deepEqual(runtime.getModels("tsgw").map(model => model.id), ["gpt-6-luna"]);
	return { sandbox, runtime, createServices, session: session as AgentSession };
}

test("新鲜缓存不能吞掉没有并发后台任务的显式 force", async () => {
	await fixture(async ({ runtime, sandbox }) => {
		const result = await runtime.refresh({ providers: ["tsgw"], force: true });
		assert.equal(result.aborted, false);
		assert.equal(result.errors.size, 0);
		assert.equal(sandbox.catalogCalls, 1);
		assert.deepEqual(runtime.getModels("tsgw").map(model => model.id), ["gpt-6-sol"]);
	});
});

test("force 不能绕过显式 allowNetwork:false", async () => {
	await fixture(async ({ runtime, sandbox }) => {
		const result = await runtime.refresh({ providers: ["tsgw"], force: true, allowNetwork: false });
		assert.equal(result.errors.size, 0);
		assert.equal(sandbox.catalogCalls, 0);
	});
});

test("离线宿主默认 force 仍不请求网关", async () => {
	await fixture(async ({ runtime, sandbox }) => {
		await runtime.refresh({ providers: ["tsgw"], force: true });
		assert.equal(sandbox.catalogCalls, 0);
	}, true);
});

test("Pi Web 调用链：后台独立 runtime 强刷与会话首次绑定互不抢占", async () => {
	await fixture(async ({ runtime, sandbox, session, createServices }) => {
		// Pi Web 刷新按钮另建 services/runtime；不会复用聊天会话的 runtime。
		const background = await createServices();
		assert.notEqual(background.modelRuntime, runtime);
		saveGatewayModelCache(join(sandbox.agentDir, "tsgw", "models-cache.json"),
			gatewayModelCacheScope(TEST_ROOT, TEST_KEY), ["gpt-6-luna", "gpt-6-sol"], Date.now());
		const entered = deferred();
		const release = deferred();
		const originalFetch = globalThis.fetch;
		let signal: AbortSignal | undefined;
		let attempts = 0;
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			if (request.url === `${TEST_ROOT}/v1/models`) {
				attempts++;
				signal = request.signal;
				request.signal.throwIfAborted();
				entered.resolve();
				let abort!: () => void;
				try {
					await Promise.race([release.promise, new Promise<never>((_, reject) => {
						abort = () => reject(new Error("合成目录请求已取消"));
						request.signal.addEventListener("abort", abort, { once: true });
					})]);
					request.signal.throwIfAborted();
				} finally {
					request.signal.removeEventListener("abort", abort);
				}
			}
			return originalFetch(request);
		};
		const forced = background.modelRuntime.refresh({ providers: ["tsgw"], force: true });
		try {
			await timeout(entered.promise, "独立后台 runtime 的 GET");
			await timeout(session.bindExtensions({ mode: "print" }), "会话绑定");
			await waitFor(() => runtime.getModels("tsgw").length === 2, "会话登记更新后的磁盘缓存");
			assert.equal(attempts, 1);
			assert.equal(signal?.aborted, false, "会话的本地同步不得取消后台实例的 GET");
			release.resolve();
			const result = await timeout(forced, "后台 force 完成");
			assert.equal(result.aborted, false);
			assert.equal(result.errors.size, 0);
			assert.equal(sandbox.catalogCalls, 1);
			assert.deepEqual(background.modelRuntime.getModels("tsgw").map(model => model.id), ["gpt-6-sol"]);
			// 不承诺实时广播；会话下次本地检查吸收后台写入的新快照。
			const restored = await runtime.refresh({ providers: ["tsgw"], allowNetwork: false });
			assert.equal(restored.errors.size, 0);
			assert.deepEqual(runtime.getModels("tsgw").map(model => model.id), ["gpt-6-sol"]);
			assert.equal(sandbox.catalogCalls, 1);
			assert.deepEqual(sandbox.blocked, []);
		} finally {
			release.resolve();
			await forced.catch(() => {});
			globalThis.fetch = originalFetch;
		}
	});
});
