import { deepStrictEqual, equal, match } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogLabel } from "./status.ts";
import { TSGW_SOL, providerRequest } from "#tsgw/test-support.test";
import { waitUntil, withUi, imageIdsOf } from "./catalog-test-support.test.ts";
import { OPENAI_IMAGE_MODEL_IDS } from "#tsgw/models/vendors/openai";

await withUi(async ({ pi, ctx, statuses, notices, choices, dialogs, setConfigured,
	refreshCalls, restoreCalls, networkRefreshCalls }) => {
	deepStrictEqual(imageIdsOf(ctx.modelRegistry.getAvailable()), [...OPENAI_IMAGE_MODEL_IDS],
		"无凭据且无缓存启动只登记固定图片，不产生网关目录");
	deepStrictEqual(ctx.modelRegistry.getAvailable().filter(model => model.type !== "image"), [],
		"聊天与分类目录仍完全依赖网关");
	const failed = { count: ctx.modelRegistry.getAvailable().length, source: "empty" as const,
		loading: false, error: "目录获取失败" };
	equal(statuses.get("command:/tsgw"), catalogLabel(failed, false, true));
	equal(restoreCalls(), 1, "每轮启动先执行仅本地 restore");
	equal(networkRefreshCalls(), 0, "缺凭据不得发起联网刷新");
	equal(notices.length, 1);
	equal(notices[0].level, "error", "目录失败 Toast 使用错误级别");
	match(notices[0].text, /模型目录获取失败/);
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
	equal(pi.activeTools.includes("tsgw_search"), false, "目录缺席不能静态恢复搜索委托");
	equal(statuses.has("command:/tsgw-search"), false);
	choices.push(1, undefined);
	await pi.invokeCommand("tsgw", ctx);
	const diagnosis = dialogs.at(-1)!.options.join("\n");
	match(diagnosis, new RegExp(`目录数量：${ctx.modelRegistry.getAvailable().length}`));
	match(diagnosis, /目录来源：/);
	match(diagnosis, /真实获取时间：未知/);
	setConfigured(false);
	pi.invoke("agent_start", {}, ctx);
	equal(statuses.get("command:/tsgw"), catalogLabel(failed, false, true),
		"status.error 的红色优先于缺少凭据警告");
}, "live", "empty");

await withUi(async ({ pi, ctx, statuses, choices, dialogs, dir }) => {
	deepStrictEqual([...statuses.keys()], ["command:/tsgw"], "底部只保留 TSGW 入口");
	equal(pi.commands.has("tsgw-search"), false, "搜索模式由工具按次选择，不再注册设置命令");
	const before = readFileSync(join(dir, "settings.json"), "utf8");
	choices.push(undefined);
	await pi.invokeCommand("tsgw", ctx);
	equal(dialogs.length, 1);
	const request = providerRequest(pi, {}) as { tools: Array<{ external_web_access: boolean }> };
	equal(request.tools[0].external_web_access, true, "旧全局 cached 配置不再影响原生搜索");
	for (const model of [
		{ ...ctx.model, id: "grok-4.5", api: "openai-completions" },
		{ ...ctx.model, id: "glm-5.2", api: "openai-completions" },
		{ ...ctx.model, provider: "other" },
	]) {
		ctx.model = model;
		pi.invoke("model_select", { model }, ctx);
		deepStrictEqual([...statuses.keys()], ["command:/tsgw"]);
		equal(pi.activeTools.includes("tsgw_search"), false);
		equal(pi.activeTools.includes("other_tool"), true);
	}
	equal(readFileSync(join(dir, "settings.json"), "utf8"), before);
	ctx.hasUI = false;
	ctx.model = { ...TSGW_SOL };
	ctx.ui.select = async () => { throw new Error("无界面模式下调用了对话框"); };
	ctx.ui.setStatus = () => { throw new Error("无界面模式下渲染了状态"); };
	pi.invoke("agent_start", {}, ctx);
	equal((providerRequest(pi, {}) as typeof request).tools[0].external_web_access, true);
}, "cached");

console.log("status-integration.test.ts：全部断言通过");
