import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import registerTsgw from "./index.ts";
import { saveGatewayModelCache, DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "./models/gateway-catalog.ts";
import { FakePi, TSGW_TERRA, withAgentDir, providerRequest } from "./test-support.test.ts";

type Refresh = (context: {
	allowNetwork: boolean;
	credential?: { type: string; key: string };
	force?: boolean;
	signal: AbortSignal;
}) => Promise<Array<{ id: string }>>;
let fixtureId = 0;

async function withUi(run: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>, search = "off") {
	const root = `https://status-${++fixtureId}.example.test`;
	await withAgentDir({ tsgw: { baseUrl: root, tsSearch: search } }, async (dir) => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("unexpected network access"); };
		try { await run(await fixture(root, dir)); }
		finally { globalThis.fetch = previousFetch; }
	});
}

async function fixture(root: string, dir: string) {
	const pi = new FakePi();
	await registerTsgw(pi);
	const provider = pi.providers[0].config as { models: Array<{ id: string }>; refreshModels: Refresh };
	let models = provider.models;
	let configured = true;
	const statuses = new Map<string, string>();
	const updates: string[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const dialogs: Array<{ title: string; options: string[] }> = [];
	const choices: Array<string | undefined> = [];
	let refreshCalls = 0;
	const ctx = {
		hasUI: true,
		model: { ...TSGW_TERRA, baseUrl: `${root}/v1` },
		thinkingLevel: "high",
		waitForIdle: async () => {},
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured }),
			getAvailable: () => models.map((model) => ({ ...model, provider: "tsgw" })),
			refresh: async () => {
				refreshCalls++;
				try {
					models = await provider.refreshModels({ allowNetwork: true, force: true,
						credential: { type: "api_key", key: "secret-test-key" }, signal: new AbortController().signal });
					return { errors: new Map<string, Error>() };
				} catch (error) { return { errors: new Map([["tsgw", error as Error]]) }; }
			},
		},
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else { statuses.set(key, text); updates.push(text); }
			},
			notify: (text: string, level: string) => { notices.push({ text, level }); },
			select: async (title: string, options: string[]) => {
				dialogs.push({ title, options });
				return choices.shift();
			},
		},
	};
	pi.invoke("session_start", { reason: "startup" }, ctx);
	return { pi, ctx, root, dir, statuses, updates, notices, dialogs, choices,
		refreshModels: provider.refreshModels, refreshCalls: () => refreshCalls,
		setConfigured: (value: boolean) => { configured = value; } };
}

const modelResponse = (ids = ["gpt-5.6-terra", "glm-5.2"]) =>
	new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

await withUi(async ({ pi, ctx, statuses, choices, dialogs, notices, dir }) => {
	match(statuses.get("command:/tsgw")!, /^🟡 TSGW/); // Static is not a healthy gateway.
	equal(statuses.get("command:/tsgw-search"), "⚪ 内置联网：关");
	const before = readFileSync(join(dir, "settings.json"), "utf8");
	choices.push("🟢 内置联网：实时");
	await pi.invokeCommand("tsgw-search", ctx);
	equal(statuses.get("command:/tsgw-search"), "🟢 内置联网：实时");
	const live = providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> };
	equal(live.tools[0].external_web_access, true);
	await pi.invokeCommand("tsgw-search", ctx, "cached");
	equal((providerRequest(pi, {}) as typeof live).tools[0].external_web_access, false);
	await pi.invokeCommand("tsgw-search", ctx, "invalid");
	equal(notices.at(-1)?.level, "warning");
	equal(statuses.get("command:/tsgw-search"), "🟡 内置联网：缓存");
	choices.push(undefined);
	await pi.invokeCommand("tsgw-search", ctx);
	equal(statuses.get("command:/tsgw-search"), "🟡 内置联网：缓存");
	equal(readFileSync(join(dir, "settings.json"), "utf8"), before);
	equal(dialogs[0].title, "内置联网（仅本会话）");
	pi.invoke("session_start", { reason: "new" }, ctx);
	equal(statuses.get("command:/tsgw-search"), "⚪ 内置联网：关");
});

await withUi(async ({ pi, ctx, statuses, choices, dialogs }) => {
	ctx.model = { ...ctx.model, id: "grok-4.5", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	// Existing cached setting maps to live Grok search; don't advertise cache-only access.
	equal(statuses.get("command:/tsgw-search"), "🟢 内置联网：实时");
	choices.push(undefined);
	await pi.invokeCommand("tsgw-search", ctx);
	deepStrictEqual(dialogs.at(-1)?.options, ["⚪ 内置联网：关", "🟢 内置联网：实时"]);
	await pi.invokeCommand("tsgw-search", ctx, "off");
	equal((providerRequest(pi, {}) as { search_parameters?: unknown }).search_parameters, undefined);
	ctx.model = { ...ctx.model, id: "glm-5.2" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(statuses.get("command:/tsgw-search"), "⚪ 内置联网：不支持");
	const dialogCount = dialogs.length;
	await pi.invokeCommand("tsgw-search", ctx);
	equal(dialogs.length, dialogCount);
	ctx.model = { ...ctx.model, provider: "other" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(statuses.has("command:/tsgw-search"), false);
	equal(statuses.has("command:/tsgw"), true);
}, "cached");

await withUi(async ({ pi, ctx, choices, statuses, updates, dialogs, notices, root, refreshCalls }) => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return modelResponse(); };
	choices.push(undefined);
	await pi.invokeCommand("tsgw", ctx);
	equal(requests, 0);
	choices.push("刷新模型目录");
	await pi.invokeCommand("tsgw", ctx);
	equal(refreshCalls(), 1);
	equal(requests, 1);
	equal(statuses.get("command:/tsgw"), "🟢 TSGW · 2");
	equal(updates.includes("⏳ TSGW"), true);
	choices.push("查看状态与诊断", undefined);
	await pi.invokeCommand("tsgw", ctx);
	const diagnosis = dialogs.at(-1)!.options.join("\n");
	match(diagnosis, /网关/);
	match(diagnosis, /\d{4}-\d{2}-\d{2}T/);
	equal(diagnosis.includes("secret-test-key"), false);
	equal(diagnosis.includes(root), false);
	equal(requests, 1); // Diagnosis is local, never a probe.
	globalThis.fetch = async () => new Response("unavailable", { status: 503 });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(statuses.get("command:/tsgw"), "🟡 TSGW · 2");
	equal(notices.at(-1)?.level, "error");
	globalThis.fetch = async () => modelResponse(["glm-5.2"]);
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(statuses.get("command:/tsgw"), "🟢 TSGW · 1");
});

await withUi(async ({ pi, ctx, statuses, setConfigured, refreshCalls, notices }) => {
	setConfigured(false);
	pi.invoke("agent_start", {}, ctx);
	match(statuses.get("command:/tsgw")!, /^⚠️/);
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(refreshCalls(), 0);
	equal(notices.at(-1)?.level, "warning");
	// Also exercise registry-level failure/cancellation (without a provider callback).
	setConfigured(true);
	ctx.modelRegistry.refresh = async () => ({ errors: new Map([["tsgw", new Error("secret-test-key")]]) });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.at(-1)?.text.includes("secret-test-key"), false);
	match(statuses.get("command:/tsgw")!, /^🟡/);
	ctx.modelRegistry.refresh = async () => ({ errors: new Map(), aborted: true });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.at(-1)?.level, "warning");
	match(notices.at(-1)!.text, /cancelled/);
});

await withUi(async ({ pi, ctx, notices }) => {
	// A model can change in another client while the mode picker is open.
	ctx.ui.select = async () => {
		ctx.model = { ...ctx.model, id: "grok-4.5", api: "openai-completions" };
		pi.invoke("model_select", { model: ctx.model }, ctx);
		return "🟡 内置联网：缓存";
	};
	await pi.invokeCommand("tsgw-search", ctx);
	match(notices.at(-1)!.text, /支持性已变化/);
	equal((providerRequest(pi, {}) as { search_parameters?: unknown }).search_parameters, undefined);
	// Headless commands can use explicit arguments without touching UI rendering.
	ctx.hasUI = false;
	ctx.model = { ...TSGW_TERRA };
	ctx.ui.select = async () => { throw new Error("headless dialog"); };
	ctx.ui.setStatus = () => { throw new Error("headless status"); };
	pi.invoke("agent_start", {}, ctx);
	await pi.invokeCommand("tsgw-search", ctx, "live");
	equal((providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> })
		.tools[0].external_web_access, true);
});

await withUi(async ({ pi, ctx, statuses, refreshModels }) => {
	// Background /model refreshes also update the status without using the command.
	globalThis.fetch = async () => modelResponse();
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	equal(statuses.get("command:/tsgw"), "🟢 TSGW · 2");
	let resolveFetch!: (response: Response) => void;
	globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
	const pending = refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	pi.invoke("session_shutdown", {}, ctx);
	ctx.ui.setStatus = () => { throw new Error("stale UI sink accessed"); };
	resolveFetch(modelResponse());
	await pending;
	// Shutdown must preserve request snapshots, but disconnect UI sinks.
	equal(typeof providerRequest(pi, {}), "object");
});

await withUi(async ({ refreshModels, statuses }) => {
	const resolvers: Array<(response: Response) => void> = [];
	globalThis.fetch = () => new Promise((resolve) => { resolvers.push(resolve); });
	const older = new AbortController();
	const first = refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: older.signal });
	const second = refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	resolvers[1](modelResponse(["glm-5.2"]));
	await second;
	older.abort();
	resolvers[0](modelResponse());
	await rejects(first);
	equal(statuses.get("command:/tsgw"), "🟢 TSGW · 1");
});

for (const newerFinishesFirst of [false, true]) {
	await withUi(async ({ pi, ctx, refreshModels, statuses }) => {
		const resolvers: Array<(value: Response) => void> = [];
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		globalThis.fetch = () => new Promise((resolve) => { resolvers.push(resolve); started(); });
		const command = pi.invokeCommand("tsgw-refresh", ctx);
		await requestStarted;
		const newer = refreshModels({ allowNetwork: true, force: true,
			credential: { type: "api_key", key: "test" }, signal: new AbortController().signal });
		if (newerFinishesFirst) {
			resolvers[1](modelResponse(["glm-5.2"]));
			await newer;
			resolvers[0](new Response("unavailable", { status: 503 }));
			await command;
			equal(statuses.get("command:/tsgw"), "🟢 TSGW · 1");
		} else {
			resolvers[0](modelResponse());
			await command;
			equal(statuses.get("command:/tsgw"), "⏳ TSGW");
			resolvers[1](modelResponse(["glm-5.2"]));
			await newer;
			equal(statuses.get("command:/tsgw"), "🟢 TSGW · 1");
		}
	});
}

for (const commandName of ["tsgw-refresh", "tsgw-search", "tsgw"]) {
	await withUi(async ({ pi, ctx }) => {
		let stale = false;
		const guarded = new Proxy(ctx, { get(target, property, receiver) {
			if (stale) throw new Error(`stale context access: ${String(property)}`);
			return Reflect.get(target, property, receiver);
		} });
		let started!: () => void;
		const pendingStarted = new Promise<void>((resolve) => { started = resolve; });
		let release!: () => void;
		if (commandName === "tsgw-refresh") {
			globalThis.fetch = () => new Promise((resolve) => {
				release = () => resolve(modelResponse()); started();
			});
		} else {
			ctx.ui.select = () => new Promise((resolve) => {
				release = () => resolve(commandName === "tsgw" ? "刷新模型目录" : "🟢 内置联网：实时");
				started();
			});
		}
		const pending = pi.invokeCommand(commandName, guarded);
		await pendingStarted;
		pi.invoke("session_shutdown", {}, ctx);
		stale = true;
		release();
		await pending;
		// Late picker completions must not mutate the old instance's search snapshot.
		equal((providerRequest(pi, {}) as { tools?: unknown }).tools, undefined);
	});
}

for (const stale of [false, true]) {
	const root = `https://bootstrap-${++fixtureId}.example.test`;
	await withAgentDir({ tsgw: { baseUrl: root } }, async (dir) => {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key: "test-bootstrap-key" } }));
		const storedAt = Date.now() - (stale ? TTL * 2 : 1000);
		saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"), ["gpt-5.6-terra"], storedAt);
		const previous = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; return new Response("unavailable", { status: 503 }); };
		try {
			const { pi, ctx, statuses, choices, dialogs } = await fixture(root, dir);
			equal(calls, stale ? 1 : 0);
			equal(statuses.get("command:/tsgw"), `${stale ? "🟡" : "🟢"} TSGW · 1`);
			choices.push("查看状态与诊断", undefined);
			await pi.invokeCommand("tsgw", ctx);
			equal(dialogs.at(-1)!.options.includes(`真实获取时间：${new Date(storedAt).toISOString()}`), true);
		} finally { globalThis.fetch = previous; }
	});
}

console.log("status-integration.test.ts: all assertions passed");
