import { deepStrictEqual, equal, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogLabel, searchLabel } from "./status.ts";
import { TSGW_SOL, providerRequest } from "#tsgw/test-support.test";
import { modelResponse, waitUntil, withUi } from "./catalog-test-support.test.ts";

await withUi(async ({ pi, ctx, statuses, notices, choices, dialogs, setConfigured,
	refreshCalls, restoreCalls, networkRefreshCalls }) => {
	deepStrictEqual(ctx.modelRegistry.getAvailable(), [], "无凭据启动不得产生静态目录");
	const failed = { count: 0, source: "empty" as const, loading: false, error: "目录获取失败" };
	equal(statuses.get("command:/tsgw"), catalogLabel(failed, false, true));
	equal(restoreCalls(), 1, "每轮启动先执行仅本地 restore");
	equal(networkRefreshCalls(), 0, "缺凭据不得发起联网刷新");
	equal(notices.length, 1);
	equal(notices[0].level, "error", "目录失败 Toast 使用错误级别");
	match(notices[0].text, /无可用模型/);
	const callsBeforeRestart = refreshCalls();
	pi.invoke("session_start", { reason: "new" }, ctx);
	await waitUntil(() => notices.length === 2, "替换会话未在本地 restore 后报告目录失败");
	await new Promise<void>(resolve => setTimeout(resolve, 10));
	equal(notices.length, 2, "每轮缺少凭据只报告一次目录失败");
	equal(notices.every(notice => notice.level === "error"), true, "目录失败 Toast 均为红色");
	equal(refreshCalls(), callsBeforeRestart + 1);
	equal(restoreCalls(), 2, "替换会话同样先执行仅本地 restore");
	equal(networkRefreshCalls(), 0, "缺凭据每轮都不得联网");
	ctx.model = { ...ctx.model, id: "glm-5.2", api: "openai-completions" };
	pi.invoke("model_select", { model: ctx.model }, ctx);
	equal(pi.activeTools.includes("tsgw_search"), false, "空目录不能静态恢复搜索委托");
	equal(statuses.get("command:/tsgw-search"), searchLabel("live", undefined));
	choices.push(1, undefined);
	await pi.invokeCommand("tsgw", ctx);
	const diagnosis = dialogs.at(-1)!.options.join("\n");
	match(diagnosis, /目录来源：无可用目录/);
	match(diagnosis, /真实获取时间：未知/);
	setConfigured(false);
	pi.invoke("agent_start", {}, ctx);
	equal(statuses.get("command:/tsgw"), catalogLabel(failed, false, true),
		"status.error 的红色优先于缺少凭据警告");
}, "live", "empty");


await withUi(async ({ pi, ctx, statuses, choices, dialogs, notices, dir }) => {
	equal(statuses.get("command:/tsgw"), catalogLabel({ count: ctx.modelRegistry.getAvailable().length, source: "cache", storedAt: Date.now(), loading: false }, true, true)); // 缓存目录不代表推理健康。
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


await withUi(async ({ pi, ctx, key, notices, statuses, refreshModels }) => {
	// 生效目录滤除 GPT 委托模型后，Grok 代理固定为实时，
	// 绝不修改会话的 GPT cached/live 偏好。
	globalThis.fetch = async () => modelResponse(["grok-4.5"]);
	await refreshModels({ allowNetwork: true, credential: { type: "api_key", key },
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


console.log("status-integration.test.ts：全部断言通过");
