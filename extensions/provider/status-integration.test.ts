import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import registerTsgw from "../../index.ts";
import { catalogLabel, searchLabel } from "./status.ts";
import { gatewayModelCacheScope, saveGatewayModelCache, DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "../models/gateway-catalog.ts";
import { FakePi, TSGW_SOL, withAgentDir, providerRequest } from "../test-support.test.ts";

type Refresh = (context: {
	allowNetwork: boolean;
	credential?: { type: string; key: string };
	force?: boolean;
	signal: AbortSignal;
}) => Promise<Array<{ id: string }>>;
let fixtureId = 0;

async function withUi(run: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>, search = "live") {
	const root = `https://status-${++fixtureId}.example.test`;
	await withAgentDir({ tsgw: { baseUrl: root, tsSearch: search } }, async (dir) => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("意外网络访问"); };
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
	const choices: Array<number | undefined> = [];
	let refreshCalls = 0;
	const ctx = {
		hasUI: true,
		model: { ...TSGW_SOL, baseUrl: `${root}/v1` },
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
				const choice = choices.shift();
				if (choice === undefined) return undefined;
				equal(choice >= 0 && choice < options.length, true);
				return options[choice];
			},
		},
	};
	pi.invoke("session_start", { reason: "startup" }, ctx);
	return { pi, ctx, root, dir, statuses, updates, notices, dialogs, choices,
		refreshModels: provider.refreshModels, refreshCalls: () => refreshCalls,
		setConfigured: (value: boolean) => { configured = value; } };
}

const modelResponse = (ids = ["gpt-6-sol", "glm-5.2"]) =>
	new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

await withUi(async ({ pi, ctx, statuses, choices, dialogs, notices, dir }) => {
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "static", loading: false }, true, true)); // 静态目录不代表网关健康。
	equal(statuses.get("command:/tsgw-search"), searchLabel("live", "gpt"));
	const before = readFileSync(join(dir, "settings.json"), "utf8");
	choices.push(0);
	await pi.invokeCommand("tsgw-search", ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "gpt"));
	const cached = providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> };
	equal(cached.tools[0].external_web_access, false);
	await pi.invokeCommand("tsgw-search", ctx, "live");
	const live = providerRequest(pi, {}) as typeof cached;
	equal(live.tools[0].external_web_access, true);
	await pi.invokeCommand("tsgw-search", ctx, "cached");
	equal((providerRequest(pi, {}) as typeof live).tools[0].external_web_access, false);
	for (const mode of ["invalid", "off"]) {
		const count = notices.length;
		await pi.invokeCommand("tsgw-search", ctx, mode);
		equal(notices.length, count + 1);
		equal(notices.at(-1)?.level, "warning");
		equal((providerRequest(pi, {}) as typeof live).tools[0].external_web_access, false);
	}
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "gpt"));
	choices.push(undefined);
	await pi.invokeCommand("tsgw-search", ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "gpt"));
	equal(readFileSync(join(dir, "settings.json"), "utf8"), before);
	deepStrictEqual(dialogs[0].options, [searchLabel("cached", "gpt"), searchLabel("live", "gpt")]);
	pi.invoke("session_start", { reason: "new" }, ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("live", "gpt"));
});

await withUi(async ({ pi, ctx, statuses, dialogs, notices, choices }) => {
	ctx.model = { ...ctx.model, id: "grok-4.5", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	// 已有 cached 配置映射到 Grok 实时搜索；不得宣称仅访问缓存。
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "grok"));
	for (const args of ["", "off", "cached", "live", "invalid"]) {
		await pi.invokeCommand("tsgw-search", ctx, args);
		equal(dialogs.length, 0);
		equal(notices.length, ["", "off", "cached", "live", "invalid"].indexOf(args) + 1);
		equal(notices.at(-1)!.level, "info");
		deepStrictEqual((providerRequest(pi, {}) as { search_parameters: unknown }).search_parameters, { mode: "on" });
	}
	ctx.model = { ...TSGW_SOL };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "gpt"));
	equal(pi.activeTools.includes("tsgw_search"), false);
	equal((providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> }).tools[0].external_web_access, false);
	await pi.invokeCommand("tsgw-search", ctx, "live");
	pi.invoke("session_start", { reason: "new" }, ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "gpt"));
	ctx.model = { ...ctx.model, id: "glm-5.2" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("cached", "proxy-gpt"));
	const dialogCount = dialogs.length;
	choices.push(0);
	await pi.invokeCommand("tsgw-search", ctx);
	equal(dialogs.length, dialogCount + 1);
	equal(pi.activeTools.includes("tsgw_search"), true);
	ctx.model = { ...ctx.model, provider: "other" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(statuses.has("command:/tsgw-search"), false);
	equal(pi.activeTools.includes("tsgw_search"), false);
	equal(pi.activeTools.includes("other_tool"), true);
	equal(statuses.has("command:/tsgw"), true);
}, "cached");

await withUi(async ({ pi, ctx, choices, statuses, updates, dialogs, notices, root, refreshCalls }) => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return modelResponse(); };
	choices.push(undefined);
	await pi.invokeCommand("tsgw", ctx);
	equal(requests, 0);
	choices.push(0);
	await pi.invokeCommand("tsgw", ctx);
	equal(refreshCalls(), 1);
	equal(requests, 1);
	deepStrictEqual(notices.map(notice => notice.level), ["info"]);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network", storedAt: Date.now(), loading: false }, true, true));
	equal(updates.includes(catalogLabel({ count: 0, source: "static", loading: true }, true, true)), true);
	choices.push(1, undefined);
	await pi.invokeCommand("tsgw", ctx);
	equal(dialogs.length, 4);
	const diagnosis = dialogs.at(-1)!.options.join("\n");
	match(diagnosis, /\d{4}-\d{2}-\d{2}T/);
	equal(diagnosis.includes("secret-test-key"), false);
	equal(diagnosis.includes(root), false);
	equal(requests, 1); // 诊断仅在本地进行，绝不发起探测。
	globalThis.fetch = async () => new Response("unavailable", { status: 503 });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network", storedAt: Date.now(), loading: false, error: "fixture-error" }, true, true));
	equal(notices.at(-1)?.level, "error");
	globalThis.fetch = async () => modelResponse(["glm-5.2"]);
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
});

await withUi(async ({ pi, ctx, statuses, setConfigured, refreshCalls, notices }) => {
	setConfigured(false);
	pi.invoke("agent_start", {}, ctx);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "static", loading: false }, false, true));
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(refreshCalls(), 0);
	equal(notices.at(-1)?.level, "warning");
	// 同时验证注册表层级的失败与取消（不经提供方回调）。
	setConfigured(true);
	ctx.modelRegistry.refresh = async () => ({ errors: new Map([["tsgw", new Error("secret-test-key")]]) });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.at(-1)?.text.includes("secret-test-key"), false);
	equal(notices.at(-1)?.level, "error");
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "static", loading: false, error: "fixture-error" }, true, true));
	ctx.modelRegistry.refresh = async () => ({ errors: new Map(), aborted: true });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.at(-1)?.level, "warning");
	equal(notices.length, 3);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "static", loading: false, error: "fixture-cancelled" }, true, true));
});

await withUi(async ({ pi, ctx, notices, statuses, refreshModels }) => {
	// 生效目录滤除 GPT 委托模型后，Grok 代理固定为实时，
	// 绝不修改会话的 GPT cached/live 偏好。
	globalThis.fetch = async () => modelResponse(["grok-4.20"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	ctx.model = { ...ctx.model, id: "glm-5.2", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(statuses.get("command:/tsgw-search"), searchLabel("live", "proxy-grok"));
	const before = providerRequest(pi, {});
	await pi.invokeCommand("tsgw-search", ctx, "cached");
	equal(notices.length, 1);
	equal(notices.at(-1)!.level, "info");
	deepStrictEqual(providerRequest(pi, {}), before);
	equal(pi.activeTools.includes("tsgw_search"), true);
});

await withUi(async ({ pi, ctx, notices }) => {
	// 模式选择器打开期间，其他客户端可能切换模型。
	ctx.ui.select = async (_title, options) => {
		ctx.model = { ...ctx.model, id: "grok-4.5", api: "openai-completions" };
		pi.invoke("model_select", { model: ctx.model }, ctx);
		return options[0];
	};
	await pi.invokeCommand("tsgw-search", ctx);
	equal(notices.length, 1);
	equal(notices.at(-1)!.level, "warning");
	deepStrictEqual((providerRequest(pi, {}) as { search_parameters: unknown }).search_parameters, { mode: "on" });
	// 无界面命令可使用显式参数，不触及 UI 渲染。
	ctx.hasUI = false;
	ctx.model = { ...TSGW_SOL };
	ctx.ui.select = async () => { throw new Error("无界面模式下调用了对话框"); };
	ctx.ui.setStatus = () => { throw new Error("无界面模式下渲染了状态"); };
	pi.invoke("agent_start", {}, ctx);
	await pi.invokeCommand("tsgw-search", ctx, "live");
	equal((providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> })
		.tools[0].external_web_access, true);
});

await withUi(async ({ pi, ctx, statuses, refreshModels }) => {
	// 后台刷新后，代理激活状态随生效目录变化。
	ctx.model = { ...ctx.model, id: "glm-5.2", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(pi.activeTools.includes("tsgw_search"), true);
	globalThis.fetch = async () => modelResponse(["glm-5.2"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	equal(pi.activeTools.includes("tsgw_search"), false);
	globalThis.fetch = async () => modelResponse(["gpt-6-luna"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	equal(pi.activeTools.includes("tsgw_search"), true);
	ctx.hasUI = false;
	const setStatus = ctx.ui.setStatus;
	ctx.ui.setStatus = () => { throw new Error("无界面刷新访问了 UI"); };
	pi.invoke("agent_start", {}, ctx);
	globalThis.fetch = async () => modelResponse(["glm-5.2"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	equal(pi.activeTools.includes("tsgw_search"), false);
	// 后台 /model 刷新即使不使用该命令也会更新状态。
	ctx.ui.setStatus = setStatus;
	ctx.hasUI = true;
	pi.invoke("agent_start", {}, ctx);
	globalThis.fetch = async () => modelResponse();
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network", storedAt: Date.now(), loading: false }, true, true));
	let resolveFetch!: (response: Response) => void;
	globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
	const pending = refreshModels({ allowNetwork: true, credential: { type: "api_key", key: "test" },
		force: true, signal: new AbortController().signal });
	pi.invoke("session_shutdown", {}, ctx);
	ctx.ui.setStatus = () => { throw new Error("访问了失效的 UI 接收端"); };
	resolveFetch(modelResponse());
	await pending;
	// 关闭时必须保留请求快照，但断开 UI 接收端。
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
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
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
			equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
		} else {
			resolvers[0](modelResponse());
			await command;
			equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network", loading: true }, true, true));
			resolvers[1](modelResponse(["glm-5.2"]));
			await newer;
			equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
		}
	});
}

for (const commandName of ["tsgw-refresh", "tsgw-search", "tsgw"]) {
	await withUi(async ({ pi, ctx }) => {
		let stale = false;
		const guarded = new Proxy(ctx, { get(target, property, receiver) {
			if (stale) throw new Error(`访问失效上下文：${String(property)}`);
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
			ctx.ui.select = (_title, options) => new Promise((resolve) => {
				release = () => resolve(options[commandName === "tsgw" ? 0 : 1]);
				started();
			});
		}
		const pending = pi.invokeCommand(commandName, guarded);
		await pendingStarted;
		pi.invoke("session_shutdown", {}, ctx);
		stale = true;
		release();
		await pending;
		// 迟到的选择器结果不得修改旧实例的搜索快照。
		equal((providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> })
			.tools[0].external_web_access, false);
	}, "cached");
}

await withUi(async ({ pi, ctx, statuses, notices }) => {
	// 上一会话的选择器不能覆盖已恢复的默认值。
	await pi.invokeCommand("tsgw-search", ctx, "cached");
	ctx.ui.select = async (_title, options) => {
		pi.invoke("session_start", { reason: "new" }, ctx);
		return options[0];
	};
	const count = notices.length;
	await pi.invokeCommand("tsgw-search", ctx);
	equal(notices.length, count);
	equal(statuses.get("command:/tsgw-search"), searchLabel("live", "gpt"));
	equal((providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> })
		.tools[0].external_web_access, true);
});

for (const stale of [false, true]) {
	const root = `https://bootstrap-${++fixtureId}.example.test`;
	await withAgentDir({ tsgw: { baseUrl: root } }, async (dir) => {
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key: "test-bootstrap-key" } }));
		const storedAt = Date.now() - (stale ? TTL * 2 : 1000);
		saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"),
			gatewayModelCacheScope(root, "test-bootstrap-key"), ["gpt-6-sol"], storedAt);
		const previous = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; return new Response("unavailable", { status: 503 }); };
		try {
			const { pi, ctx, statuses, choices, dialogs } = await fixture(root, dir);
			equal(calls, stale ? 1 : 0);
			equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "cache", storedAt, loading: false }, true, true));
			choices.push(1, undefined);
			await pi.invokeCommand("tsgw", ctx);
			equal(dialogs.at(-1)!.options.some(line => line.includes(new Date(storedAt).toISOString())), true);
		} finally { globalThis.fetch = previous; }
	});
}

console.log("status-integration.test.ts：全部断言通过");
