import { test, type TestContext } from "node:test";
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FakePi } from "#tsgw/test-support.test";
import { saveGatewayModelCache, gatewayModelCacheScope } from "#tsgw/models/gateway-catalog";
import { getGatewayCatalogService } from "#tsgw/models/gateway-catalog-service";
import { registerMagpie } from "./controller.ts";

const quota = (used = 20) => ({ provider: "codex", user: "example@example.invalid", plan: "plan", readAt: "2026-11-16T00:00:00Z",
	windows: [{ name: "week", used }] });
const settle = async () => { await new Promise<void>(done => setImmediate(done)); await new Promise<void>(done => setImmediate(done)); };

async function fixture(t: TestContext, magpie = true) {
	const root = `https://${randomUUID()}.invalid`;
	const dir = mkdtempSync(join(tmpdir(), "magpie-controller-"));
	const file = join(dir, "cache.json");
	let key = "synthetic-key";
	saveGatewayModelCache(file, gatewayModelCacheScope(root, key), ["synthetic-model"], Date.now(), magpie ? true : undefined);
	const catalog = getGatewayCatalogService(root, key, file);
	await catalog.request(key, { allowNetwork: false });
	const previousFetch = globalThis.fetch;
	const calls: Array<{ url: URL; init: RequestInit }> = [];
	const dialogs: string[][] = [];
	const choices: Array<number | undefined> = [];
	let confirm = false;
	let updates = 0;
	const notices: string[] = [];
	const pi = new FakePi();
	let selectedCatalog = catalog;
	const extension = registerMagpie(pi, { root, gateway: () => selectedCatalog, onChange: () => { updates++; } });
	const ctx = {
		hasUI: true,
		model: { provider: "tsgw", id: "synthetic-model", api: "openai-responses", baseUrl: `${root}/v1` },
		sessionManager: { getSessionId: () => "real-session&=?" },
		modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: key, baseUrl: `${root}/v1`, headers: { "X-Extra-Auth": "synthetic-extra" } } }) },
		ui: {
			select: async (_title: string, options: string[]) => { dialogs.push(options); const index = choices.shift(); return index === undefined ? undefined : options[index]; },
			confirm: async () => confirm,
			notify: (message: string) => { notices.push(message); },
		},
	} as unknown as ExtensionCommandContext;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push({ url, init: init! });
		return url.pathname.endsWith("statusline")
			? Response.json({ model: "requested-alias", text: "requested-alias · 周已用 20%", accounts: [quota()] })
			: Response.json({ object: "list", data: [quota(), quota(40)] });
	};
	pi.invoke("session_start", {}, ctx);
	t.after(() => { pi.invoke("session_shutdown", {}, ctx); catalog.invalidate(); globalThis.fetch = previousFetch; rmSync(dir, { recursive: true, force: true }); });
	return { pi, ctx, extension, calls, dialogs, choices, notices, catalog, root, file, updates: () => updates,
		setCatalog: (value: typeof catalog) => { selectedCatalog = value; },
		setKey: (value: string) => { key = value; }, setConfirm: (value: boolean) => { confirm = value; } };
}

test("启动与空闲不查询，正常用户任务最终完成后读一次全局卡片，重试结束和自定义任务不读取", async t => {
	const f = await fixture(t);
	equal(f.calls.length, 0);
	f.pi.invoke("before_agent_start", { messageType: "custom" }, f.ctx);
	f.pi.invoke("agent_settled", { aborted: false }, f.ctx);
	await settle();
	equal(f.calls.length, 0);
	f.pi.invoke("before_agent_start", { messageType: "user" }, f.ctx);
	f.pi.invoke("agent_settled", { aborted: true }, f.ctx);
	await settle();
	equal(f.calls.length, 0);
	f.pi.invoke("before_agent_start", { messageType: "user" }, f.ctx);
	f.pi.invoke("agent_settled", { aborted: false }, f.ctx);
	await settle();
	equal(f.calls.length, 1);
	equal(f.calls[0].url.pathname, "/v1/magpie/quotas/cards");
	equal(f.calls[0].url.searchParams.has("session"), false);
	match(f.extension.label()!, /80%/);
	f.pi.invoke("before_agent_start", { messageType: "user" }, f.ctx);
	f.pi.invoke("agent_settled", { aborted: false }, f.ctx);
	await settle();
	equal(f.calls.length, 1);
	equal(new Headers(f.calls[0].init.headers).get("X-Extra-Auth"), "synthetic-extra");
});

test("普通网关不展示 Magpie 菜单，也不自动读取", async t => {
	const f = await fixture(t, false);
	deepStrictEqual(f.extension.choices(), []);
	f.pi.invoke("before_agent_start", { messageType: "user" }, f.ctx);
	f.pi.invoke("agent_settled", { aborted: false }, f.ctx);
	await settle();
	equal(f.calls.length, 0);
});

test("已识别 Magpie 时，其他 provider、非匹配根地址与无 UI 仍不自动读取", async t => {
	const f = await fixture(t);
	const cases = [
		{ ...f.ctx, model: { ...f.ctx.model, provider: "other" } },
		{ ...f.ctx, model: { ...f.ctx.model, baseUrl: "https://other.invalid/v1" } },
		{ ...f.ctx, hasUI: false }];
	for (const ctx of cases) {
		f.pi.invoke("session_start", {}, ctx);
		f.pi.invoke("before_agent_start", { messageType: "user" }, ctx);
		f.pi.invoke("agent_settled", { aborted: false }, ctx);
		await settle();
	}
	equal(f.calls.length, 0);
});

test("手动查看只发 GET，同名多卡可分别展开，重读卡片绕过60秒缓存", async t => {
	const f = await fixture(t);
	f.choices.push(0, 0, 1, 0, undefined);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	equal(f.calls.length, 1);
	equal(f.calls[0].init.method, "GET");
	const accounts = f.dialogs[2];
	equal(accounts.length, 3);
	equal(accounts[0] === accounts[1], false);
	match(f.dialogs[3].join("\n"), /40/);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	equal(f.calls.length, 1);
	await f.extension.handle(f.extension.choices()[2], f.ctx);
	equal(f.calls.length, 2);
	deepStrictEqual(f.calls.map(call => call.init.method), ["GET", "GET"]);
});

test("上游刷新必须确认，目标来自原始卡片且仅调用一次POST", async t => {
	const f = await fixture(t);
	f.choices.push(1);
	await f.extension.handle(f.extension.choices()[3], f.ctx);
	equal(f.calls.length, 1);
	equal(f.calls[0].init.method, "GET");
	f.setConfirm(true);
	f.choices.push(1, undefined);
	await f.extension.handle(f.extension.choices()[3], f.ctx);
	equal(f.calls.length, 2);
	equal(f.calls[1].init.method, "POST");
	equal(f.calls[1].url.searchParams.get("provider"), "codex");
	equal(f.calls[1].url.searchParams.get("user"), quota().user);
	equal(f.calls[1].init.body, undefined);
});

test("认证作用域改变不发送旧请求，不展示旧状态，认证错误不外泄上游信息", async t => {
	const f = await fixture(t);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	equal(f.calls.length, 1);
	f.setKey("replacement-synthetic-key");
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	equal(f.calls.length, 1);
	equal(f.extension.label(), undefined);
	equal(f.notices.some(line => line.includes("replacement-synthetic-key")), false);
});

test("切换会话或模型保留全局读数，新控制器复用快照并收到其他会话更新", async t => {
	const f = await fixture(t);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	const firstLabel = f.extension.label();
	match(firstLabel!, /80%/);
	const otherCtx = { ...f.ctx, sessionManager: { getSessionId: () => "other-session" } } as ExtensionCommandContext;
	f.pi.invoke("session_shutdown", {}, f.ctx);
	f.pi.invoke("session_start", {}, otherCtx);
	equal(f.extension.label(), firstLabel);
	f.pi.invoke("model_select", {}, otherCtx);
	equal(f.extension.label(), firstLabel);
	const otherPi = new FakePi();
	let updates = 0;
	const other = registerMagpie(otherPi, { root: new URL(f.calls[0].url).origin,
		gateway: () => f.catalog, onChange: () => { updates++; } });
	otherPi.invoke("session_start", {}, otherCtx);
	equal(other.label(), firstLabel);
	equal(f.calls.length, 1);
	otherPi.invoke("before_agent_start", { messageType: "user" }, otherCtx);
	otherPi.invoke("agent_settled", { aborted: false }, otherCtx);
	await settle();
	equal(f.calls.length, 1);
	globalThis.fetch = async () => Response.json({ object: "list", data: [{ ...quota(), windows: [{ used: 50 }] }] });
	await f.extension.handle(f.extension.choices()[2], otherCtx);
	match(other.label()!, /50%/);
	match(f.extension.label()!, /50%/);
	equal(updates > 0, true);
	otherPi.invoke("session_shutdown", {}, otherCtx);
	f.catalog.invalidate();
	equal(f.extension.label(), undefined);
});

test("显式状态仍按真实会话读取，额度失败保留全局旧读数并标记", async t => {
	const f = await fixture(t);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	await f.extension.handle(f.extension.choices()[0], f.ctx);
	equal(f.calls[1].url.searchParams.get("session"), f.ctx.sessionManager.getSessionId());
	match(f.extension.label()!, /80%/);
	globalThis.fetch = async () => new Response(null, { status: 503 });
	await f.extension.handle(f.extension.choices()[2], f.ctx);
	match(f.extension.label()!, /80%/);
	match(f.extension.label()!, /旧/);
	globalThis.fetch = async () => new Response(null, { status: 403 });
	await f.extension.handle(f.extension.choices()[2], f.ctx);
	equal(f.extension.label()!.includes("80%"), false);
});

test("认证失败只隐藏旧作用域，识别新凭据后直接显示其共享读数", async t => {
	const f = await fixture(t);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	f.setKey("replacement-key");
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	equal(f.extension.label(), undefined);
	const root = f.calls[0].url.origin;
	const dir = mkdtempSync(join(tmpdir(), "magpie-new-scope-"));
	const file = join(dir, "cache.json");
	saveGatewayModelCache(file, gatewayModelCacheScope(root, "replacement-key"), ["synthetic-model"], Date.now(), true);
	const catalog = getGatewayCatalogService(root, "replacement-key", file);
	await catalog.request("replacement-key", { allowNetwork: false });
	const pi = new FakePi();
	const other = registerMagpie(pi, { root, gateway: () => catalog, onChange: () => {} });
	pi.invoke("session_start", {}, f.ctx);
	t.after(() => { pi.invoke("session_shutdown", {}, f.ctx); catalog.invalidate(); rmSync(dir, { recursive: true, force: true }); });
	await other.handle(other.choices()[1], f.ctx);
	f.setCatalog(catalog);
	match(f.extension.label()!, /80%/);
});

test("其他实例更换凭据时，空闲界面立即清除已发布的旧额度", async t => {
	const f = await fixture(t);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	const pi = new FakePi();
	let published: string | undefined;
	const other = registerMagpie(pi, { root: f.root, gateway: () => f.catalog,
		onChange: () => { published = other.label(); } });
	pi.invoke("session_start", {}, f.ctx);
	t.after(() => pi.invoke("session_shutdown", {}, f.ctx));
	published = other.label();
	match(published!, /80%/);
	const updates = f.updates();
	const replacement = getGatewayCatalogService(f.root, "different-key", f.file);
	t.after(() => replacement.invalidate());
	equal(published, undefined);
	equal(f.updates() > updates, true);
});

test("目录识别为 Magpie、失去标记与重新识别均通知空闲界面", async t => {
	const f = await fixture(t);
	await f.extension.handle(f.extension.choices()[1], f.ctx);
	const pi = new FakePi();
	let published: string | undefined;
	const other = registerMagpie(pi, { root: f.root, gateway: () => f.catalog,
		onChange: () => { published = other.label(); } });
	pi.invoke("session_start", {}, f.ctx);
	t.after(() => pi.invoke("session_shutdown", {}, f.ctx));
	published = other.label();
	match(published!, /80%/);
	globalThis.fetch = async () => Response.json({ data: [{ id: "synthetic-model" }] });
	await f.catalog.request("synthetic-key", { allowNetwork: true, force: true });
	equal(published, undefined);
	globalThis.fetch = async () => Response.json({ data: [{ id: "synthetic-model", magpie_label: "synthetic" }] });
	await f.catalog.request("synthetic-key", { allowNetwork: true, force: true });
	match(published!, /80%/);
});

test("另一实例首次识别 Magpie 后，空闲界面同步显示且不额外查询额度", async t => {
	const f = await fixture(t, false);
	const pi = new FakePi();
	let published: string | undefined;
	const other = registerMagpie(pi, { root: f.root, gateway: () => f.catalog,
		onChange: () => { published = other.label(); } });
	pi.invoke("session_start", {}, f.ctx);
	t.after(() => pi.invoke("session_shutdown", {}, f.ctx));
	published = other.label();
	equal(published, undefined);
	globalThis.fetch = async () => Response.json({ data: [{ id: "synthetic-model", magpie_label: "synthetic" }] });
	await f.catalog.request("synthetic-key", { allowNetwork: true, force: true });
	equal(published, other.label());
	equal(typeof published, "string");
	equal(f.calls.length, 0);
});

test("会话结束后的旧请求不再更新界面", async t => {
	const f = await fixture(t);
	let finish!: (value: Response) => void;
	globalThis.fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
	f.pi.invoke("before_agent_start", { messageType: "user" }, f.ctx);
	f.pi.invoke("agent_settled", { aborted: false }, f.ctx);
	await settle();
	f.pi.invoke("session_shutdown", {}, f.ctx);
	const before = f.updates();
	finish(Response.json({ object: "list", data: [{ ...quota(), windows: [{ used: 0 }] }] }));
	await settle();
	equal(f.updates(), before);
	equal(f.extension.label(), undefined);
});
