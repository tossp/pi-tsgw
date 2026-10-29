import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogLabel, searchLabel } from "./status.ts";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL, gatewayModelCacheScope, saveGatewayModelCache } from "#tsgw/models/gateway-catalog";
import { withAgentDir, providerRequest } from "#tsgw/test-support.test";
import { fixture, modelResponse, nextFixtureId, waitUntil, withUi } from "./catalog-test-support.test.ts";

await withUi(async ({ pi, ctx, choices, statuses, updates, dialogs, notices, root, key,
	refreshCalls, restoreCalls, networkRefreshCalls }) => {
	let requests = 0;
	globalThis.fetch = async () => { requests++; return modelResponse(); };
	equal(restoreCalls(), 1, "启动恢复先读取本地快照");
	const callsBeforeManual = refreshCalls();
	choices.push(undefined);
	await pi.invokeCommand("tsgw", ctx);
	equal(requests, 0);
	choices.push(0);
	await pi.invokeCommand("tsgw", ctx);
	equal(refreshCalls(), callsBeforeManual + 1);
	equal(networkRefreshCalls(), 1, "只有手动刷新进入联网路径");
	equal(requests, 1);
	deepStrictEqual(notices.map(notice => notice.level), ["info"]);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network", storedAt: Date.now(), loading: false }, true, true));
	equal(updates.includes(catalogLabel({ count: 0, source: "cache", storedAt: Date.now(), loading: true }, true, true)), true);
	choices.push(1, undefined);
	await pi.invokeCommand("tsgw", ctx);
	equal(dialogs.length, 4);
	const diagnosis = dialogs.at(-1)!.options.join("\n");
	match(diagnosis, /\d{4}-\d{2}-\d{2}T/);
	equal(diagnosis.includes(key), false);
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


await withUi(async ({ pi, ctx, notices, statuses, key, refreshModels, refreshCalls, dir }) => {
	// PI_OFFLINE 等宿主默认无网络时，强制命令只得到本地结果且没有 errors。
	const beforeModels = ctx.modelRegistry.getAvailable().map(model => model.id);
	const cachePath = join(dir, "tsgw", "models-cache.json");
	const beforeCache = readFileSync(cachePath, "utf8");
	let offlineCalls = 0;
	ctx.modelRegistry.refresh = async (input = {}) => {
		offlineCalls++;
		await refreshModels({ allowNetwork: false, force: input.force,
			credential: { type: "api_key", key },
			signal: input.signal ?? new AbortController().signal });
		return { errors: new Map<string, Error>() };
	};
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(offlineCalls, 1, "离线命令仍需经宿主刷新映射 force");
	equal(notices.at(-1)?.level, "warning", "未实际联网时不得误报刷新成功");
	match(notices.at(-1)?.text ?? "", /未完成联网刷新/);
	equal((notices.at(-1)?.text ?? "").includes("已刷新"), false);
	deepStrictEqual(ctx.modelRegistry.getAvailable().map(model => model.id), beforeModels,
		"离线命令保留原目录");
	equal(readFileSync(cachePath, "utf8"), beforeCache, "离线命令不得改写缓存");
	equal(statuses.get("command:/tsgw")?.startsWith("⏳"), false, "离线命令结束后清理 loading");
});


await withUi(async ({ pi, ctx, notices, statuses, key, refreshModels }) => {
	// 旧宿主 void 不能报成功；若仍进入网络回调，内部的 force 意图不能被宿主遗漏吞掉。
	let requests = 0;
	globalThis.fetch = async () => { requests++; return modelResponse(); };
	const beforeModels = ctx.modelRegistry.getAvailable().map(model => model.id);
	const beforeNotices = notices.length;
	ctx.modelRegistry.refresh = async () => undefined;
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.length, beforeNotices + 1);
	equal(notices.at(-1)?.level, "warning", "旧宿主 void 不得误报刷新成功");
	match(notices.at(-1)?.text ?? "", /未完成联网刷新/);
	equal(requests, 0);

	ctx.modelRegistry.refresh = async (input = {}) => {
		await refreshModels({ allowNetwork: true, force: false,
			credential: { type: "api_key", key },
			signal: input.signal ?? new AbortController().signal });
		return { errors: new Map<string, Error>() };
	};
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.length, beforeNotices + 2);
	equal(notices.at(-1)?.level, "info", "内部仍有 force 意图，应提升本轮实际获取后才报成功");
	match(notices.at(-1)?.text ?? "", /已刷新/);
	equal(requests, 1, "即使宿主遗漏 force，已收到的内部意图仍要求真实联网");
	deepStrictEqual(ctx.modelRegistry.getAvailable().map(model => model.id), beforeModels);
	equal(statuses.get("command:/tsgw")?.startsWith("⏳"), false);
});


await withUi(async ({ pi, ctx, notices, statuses, dir }) => {
	// 网络成功但缓存父路径被普通文件占用：命令仍应报告成功并应用新目录。
	const cachePath = join(dir, "tsgw", "models-cache.json");
	rmSync(join(dir, "tsgw"), { recursive: true, force: true });
	writeFileSync(join(dir, "tsgw"), "blocked-cache-parent");
	globalThis.fetch = async () => modelResponse(["gpt-6-sol", "glm-5.2"]);
	const beforeNotices = notices.length;
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.length, beforeNotices + 1);
	equal(notices.at(-1)?.level, "info", "写盘失败不得把成功联网误报为目录失败");
	match(notices.at(-1)?.text ?? "", /已刷新/);
	deepStrictEqual(ctx.modelRegistry.getAvailable().map(model => model.id).sort(),
		["gpt-6-sol", "glm-5.2"].sort(), "命令必须以网络结果更新 registry");
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network",
		storedAt: Date.now(), loading: false }, true, true));

	equal(cachePath.startsWith(dir), true, "仅操作临时夹具路径");
});


for (const lifecycleEvent of ["session_start", "session_shutdown"] as const) {
	await withUi(async ({ pi, ctx, key, statuses, updates, notices, refreshCalls,
		restoreCalls, dir }) => {
		const beforeModels = ctx.modelRegistry.getAvailable().map(model => model.id);
		const cachePath = join(dir, "tsgw", "models-cache.json");
		const beforeCache = readFileSync(cachePath, "utf8");
		let release!: (response: Response) => void;
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		let requestSignal: AbortSignal | undefined;
		globalThis.fetch = (_input, init) => {
			requestSignal = init?.signal ?? undefined;
			started();
			return new Promise<Response>((resolve) => { release = resolve; });
		};
		const command = pi.invokeCommand("tsgw-refresh", ctx);
		await requestStarted;
		equal(requestSignal?.aborted, false);
		equal(statuses.get("command:/tsgw")?.startsWith("⏳"), true, "强制请求期间显示 loading");

		const callsBeforeLifecycle = refreshCalls();
		const restoresBeforeLifecycle = restoreCalls();
		if (lifecycleEvent === "session_start") {
			pi.invoke("session_start", { reason: "new" }, ctx);
			await waitUntil(() => restoreCalls() === restoresBeforeLifecycle + 1,
				"替换会话未开始后台本地恢复");
			await new Promise<void>(resolve => setTimeout(resolve, 10));
		} else {
			pi.invoke("session_shutdown", {}, ctx);
		}
		equal(requestSignal?.aborted, true, `${lifecycleEvent} 必须中止旧命令请求`);
		equal(statuses.get("command:/tsgw")?.startsWith("⏳"), false,
			`${lifecycleEvent} 必须清理旧请求的 loading`);
		if (lifecycleEvent === "session_start") {
			equal(refreshCalls(), callsBeforeLifecycle + 1, "替换会话只执行本地 restore");
		}
		const updatesAtLifecycle = updates.length;
		const noticesAtLifecycle = notices.length;
		const statusAtLifecycle = statuses.get("command:/tsgw");
		release(modelResponse(["glm-5.2"]));
		await command;
		await new Promise<void>(resolve => setTimeout(resolve, 10));
		equal(readFileSync(cachePath, "utf8"), beforeCache, "旧请求迟到结果不得写盘");
		deepStrictEqual(ctx.modelRegistry.getAvailable().map(model => model.id), beforeModels,
			"旧请求迟到结果不得覆盖目录");
		equal(statuses.get("command:/tsgw"), statusAtLifecycle, "旧请求迟到结果不得发布状态");
		equal(updates.length, updatesAtLifecycle, "旧请求不得追加状态更新");
		equal(notices.length, noticesAtLifecycle, "旧命令不得追加刷新结果 Toast");
	}, "live", "cache");
}


await withUi(async ({ pi, ctx, statuses, setConfigured, refreshCalls, notices }) => {
	setConfigured(false);
	pi.invoke("agent_start", {}, ctx);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "cache", storedAt: Date.now(), loading: false }, false, true));
	const callsBeforeMissingAuth = refreshCalls();
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(refreshCalls(), callsBeforeMissingAuth, "缺凭据命令在宿主刷新前结束");
	equal(notices.at(-1)?.level, "error");
	// 同时验证注册表层级的失败与取消（不经提供方回调）。
	setConfigured(true);
	ctx.modelRegistry.refresh = async () => ({ errors: new Map([["tsgw", new Error("secret-test-key")]]) });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.at(-1)?.text.includes("secret-test-key"), false);
	equal(notices.at(-1)?.level, "error");
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "cache", storedAt: Date.now(), loading: false, error: "fixture-error" }, true, true));
	ctx.modelRegistry.refresh = async () => ({ errors: new Map(), aborted: true });
	await pi.invokeCommand("tsgw-refresh", ctx);
	equal(notices.at(-1)?.level, "warning");
	equal(notices.length, 3);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "cache", storedAt: Date.now(), loading: false, error: "fixture-cancelled" }, true, true));
});


await withUi(async ({ pi, ctx, key, statuses, refreshModels }) => {
	// 后台刷新后，代理激活状态随生效目录变化。
	ctx.model = { ...ctx.model, id: "glm-5.2", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(pi.activeTools.includes("tsgw_search"), true);
	globalThis.fetch = async () => modelResponse(["glm-5.2"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: new AbortController().signal });
	equal(pi.activeTools.includes("tsgw_search"), false);
	globalThis.fetch = async () => modelResponse(["gpt-6-luna"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: new AbortController().signal });
	equal(pi.activeTools.includes("tsgw_search"), true);
	ctx.hasUI = false;
	const setStatus = ctx.ui.setStatus;
	ctx.ui.setStatus = () => { throw new Error("无界面刷新访问了 UI"); };
	pi.invoke("agent_start", {}, ctx);
	globalThis.fetch = async () => modelResponse(["glm-5.2"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: new AbortController().signal });
	equal(pi.activeTools.includes("tsgw_search"), false);
	// 后台 /model 刷新即使不使用该命令也会更新状态。
	ctx.ui.setStatus = setStatus;
	ctx.hasUI = true;
	pi.invoke("agent_start", {}, ctx);
	globalThis.fetch = async () => modelResponse();
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: new AbortController().signal });
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 2, source: "network", storedAt: Date.now(), loading: false }, true, true));
	let resolveFetch!: (response: Response) => void;
	globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
	const pending = refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: new AbortController().signal });
	await Promise.resolve(); // 等实际 GET 启动后验证退出取消，不依赖 sleep。
	pi.invoke("session_shutdown", {}, ctx);
	ctx.ui.setStatus = () => { throw new Error("访问了失效的 UI 接收端"); };
	resolveFetch(modelResponse());
	await rejects(pending, /已取消/);
	// 关闭时必须保留请求快照，但断开 UI 接收端；迟到结果不得复活刷新。
	equal(typeof providerRequest(pi, {}), "object");
});


await withUi(async ({ refreshModels, key, statuses }) => {
	const resolvers: Array<(response: Response) => void> = [];
	globalThis.fetch = () => new Promise((resolve) => { resolvers.push(resolve); });
	const older = new AbortController();
	const first = refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: older.signal });
	const second = refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
		force: true, signal: new AbortController().signal });
	await Promise.resolve();
	equal(resolvers.length, 1, "两个外部回调必须共享同一个实际 GET");
	const canceled = rejects(first, /已取消/);
	older.abort();
	await canceled;
	resolvers[0](modelResponse(["glm-5.2"]));
	await second;
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
});


for (const succeeds of [false, true]) {
	await withUi(async ({ pi, ctx, refreshModels, key, statuses, notices }) => {
		const before = ctx.modelRegistry.getAvailable().map(model => model.id);
		const resolvers: Array<(value: Response) => void> = [];
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => { started = resolve; });
		globalThis.fetch = () => new Promise((resolve) => { resolvers.push(resolve); started(); });
		const command = pi.invokeCommand("tsgw-refresh", ctx);
		await requestStarted;
		const newer = refreshModels({ allowNetwork: true, force: true,
			credential: { type: "api_key", key }, signal: new AbortController().signal });
		await Promise.resolve();
		equal(resolvers.length, 1, "命令和外部回调只共享一项实际获取，不再有两个结果抢写");
		if (succeeds) {
			resolvers[0](modelResponse(["glm-5.2"]));
			await Promise.all([command, newer]);
			equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
			equal(notices.at(-1)?.level, "info");
		} else {
			const failed = rejects(newer, /目录获取失败/);
			resolvers[0](new Response("unavailable", { status: 503 }));
			await Promise.all([command, failed]);
			deepStrictEqual(ctx.modelRegistry.getAvailable().map(model => model.id), before);
			equal(notices.at(-1)?.level, "error");
			equal(statuses.get("command:/tsgw")?.startsWith("⏳"), false);
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
	const root = `https://bootstrap-${nextFixtureId()}.example.test`;
	await withAgentDir({ tsgw: { baseUrl: root } }, async (dir) => {
		const key = "test-bootstrap-key";
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
		const storedAt = Date.now() - (stale ? TTL + 60_000 : TTL - 60_000);
		saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"),
			gatewayModelCacheScope(root, key), ["gpt-6-sol"], storedAt);
		const previous = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; return new Response("unavailable", { status: 503 }); };
		let current: Awaited<ReturnType<typeof fixture>> | undefined;
		try {
			current = await fixture(root, dir, { key, configured: true });
			const { pi, ctx, statuses, choices, dialogs, notices } = current;
			if (stale) await waitUntil(() => calls >= 1, "过期缓存的后台恢复没有启动");
			else await new Promise<void>(resolve => setTimeout(resolve, 10));
			equal(calls, stale ? 1 : 0, "24 小时内缓存不联网；过期先尝试一次并保留旧缓存");
			deepStrictEqual(ctx.modelRegistry.getAvailable().map(model => model.id), ["gpt-6-sol"]);
			equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "cache", storedAt,
				ttlMs: TTL, loading: false, error: stale ? "fixture-error" : undefined }, true, true));
			const noticeCount = notices.length;
			pi.invoke("session_start", { reason: "new" }, ctx);
			equal(notices.length, noticeCount, "启动恢复重试不追加即时 Toast");
			choices.push(1, undefined);
			await pi.invokeCommand("tsgw", ctx);
			equal(dialogs.at(-1)!.options.some(line => line.includes(new Date(storedAt).toISOString())), true);
		} finally {
			if (current) current.pi.invoke("session_shutdown", {}, current.ctx);
			globalThis.fetch = previous;
		}
	});
}


await withUi(async ({ pi, ctx, statuses, notices }) => {
	// 新宿主按操作类型读取：刷新提示和目录状态必须包含 classifier，而非仅聊天/图片。
	Object.assign(ctx.modelRegistry, { getModelsOfType: (type: string, provider: string) =>
		ctx.modelRegistry.getAvailable().filter(model => provider === "tsgw" && (model.type ?? "chat") === type) });
	const before = ctx.modelRegistry.getAvailable().length;
	globalThis.fetch = async () => modelResponse(["gpt-6-sol", "gpt-image-2.5-flare", "jev-latest", "jev-preview"]);
	await pi.invokeCommand("tsgw-refresh", ctx);
	deepStrictEqual(ctx.modelRegistry.getAvailable().filter(model => model.type === "classifier")
		.map(model => model.id), ["jev-latest", "jev-preview"]);
	match(notices.at(-1)!.text, new RegExp(`${before} → 4`));
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 4, source: "network", storedAt: Date.now(), loading: false }, true, true));
	ctx.model = { ...ctx.model, id: "glm-5.2", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(pi.activeTools.includes("tsgw_search"), true, "有 GPT 候选时先确认代理已激活");
	globalThis.fetch = async () => modelResponse(["jev-preview"]);
	await pi.invokeCommand("tsgw-refresh", ctx);
	match(notices.at(-1)!.text, /4 → 1/);
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: 1, source: "network", storedAt: Date.now(), loading: false }, true, true));
	// 只余 classifier 时撤下已激活的代理；不能把分类器当聊天候选。
	equal(pi.activeTools.includes("tsgw_search"), false);
});


console.log("catalog-lifecycle.test.ts：全部断言通过");
