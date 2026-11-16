import { test } from "node:test";
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { createMagpieService, type MagpieRequest } from "./service.ts";

const request: MagpieRequest = { root: "https://gateway.invalid", headers: new Headers({ Authorization: "Bearer synthetic" }) };
const catalog = () => ({ valid: () => true, isMagpie: () => true });
const cards = [{ provider: "codex", user: "person@example.invalid", readAt: "2026-11-16T00:00:00Z", windows: [{ name: "week", used: 20 }] }];
const response = () => Response.json({ object: "list", data: cards });
const status = () => Response.json({ text: "周已用 20%", model: "requested-alias", accounts: cards });

function pending() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>(done => { resolve = done; });
	return { promise, resolve };
}

test("普通网关和失效作用域不发 Magpie 查询，旧响应不提交", async () => {
	let valid = true;
	let calls = 0;
	const remote = pending();
	const service = createMagpieService({ valid: () => valid, isMagpie: () => valid }, async () => { calls++; return remote.promise; });
	const result = service.readCards(request);
	valid = false;
	remote.resolve(response());
	deepStrictEqual(await result, {});
	deepStrictEqual(service.cards(), {});
	await service.readStatus("session", request);
	await service.refreshCards(request);
	equal(calls, 1);
	const plain = createMagpieService({ valid: () => true, isMagpie: () => false }, async () => { calls++; return response(); });
	await plain.readCards(request);
	await plain.readStatus("session", request);
	equal(calls, 1);
});

test("卡片并发合并与缓存复用，强制读取仍只 GET，保留逐记录读数时间", async () => {
	let calls = 0;
	let clock = 100;
	const methods: string[] = [];
	const service = createMagpieService(catalog(), async (_url, init) => {
		calls++; methods.push(init!.method!); return response();
	}, () => clock);
	const [first, second] = await Promise.all([service.readCards(request), service.readCards(request)]);
	equal(calls, 1);
	deepStrictEqual(first, second);
	clock = 200;
	const cached = await service.readCards(request);
	equal(cached.fetchedAt, 100);
	await service.readCards(request, { force: true });
	equal(service.cards().fetchedAt, 200);
	equal(service.cards().data?.[0].readAt, cards[0].readAt);
	deepStrictEqual(methods, ["GET", "GET"]);
});

test("会话 statusline 分离，真实 ID 编码；失败尝试也抑制自动查询", async () => {
	let clock = 0;
	const urls: string[] = [];
	const service = createMagpieService(catalog(), async input => {
		urls.push(String(input));
		if (urls.length === 1) throw new Error("不得暴露此上游错误与秘密");
		return status();
	}, () => clock);
	const first = await service.readStatus("a&b/?中文", request, { automatic: true });
	equal(first.data, undefined);
	equal(first.error?.includes("秘密"), false);
	clock = 50_000;
	await service.readStatus("a&b/?中文", request, { automatic: true });
	equal(urls.length, 1);
	await service.readStatus("other", request, { automatic: true });
	equal(urls.length, 2);
	equal(service.status("other").data?.model, "requested-alias");
	clock = 60_001;
	await service.readStatus("a&b/?中文", request, { automatic: true });
	equal(urls.length, 3);
	equal(new URL(urls[0]).searchParams.get("session"), "a&b/?中文");
});

test("401/403 隐藏旧资料，404/405 停止自动状态请求，显式重查可恢复", async () => {
	for (const http of [401, 403, 404, 405]) {
		let calls = 0;
		let clock = 0;
		const service = createMagpieService(catalog(), async () => {
			calls++;
			return calls === 2 ? new Response(null, { status: http }) : status();
		}, () => clock);
		await service.readStatus("session", request);
		clock = 61_000;
		const failed = await service.readStatus("session", request, { automatic: true });
		equal(failed.status, http);
		equal(!!failed.data, http !== 401 && http !== 403);
		clock = 122_000;
		await service.readStatus("session", request, { automatic: true });
		equal(calls, 2);
		const recovered = await service.readStatus("session", request, { force: true });
		equal(calls, 3);
		equal(recovered.error, undefined);
	}
});

test("POST 刷新范围在 URL，全部不带筛选，合并覆盖范围且拒绝隐式排队", async () => {
	const calls: Array<{ url: URL; init: RequestInit }> = [];
	let remote = pending();
	const service = createMagpieService(catalog(), async (input, init) => {
		calls.push({ url: new URL(String(input)), init: init! }); return remote.promise;
	});
	const target = { provider: "远程/codex", user: "person+tag@example.invalid" };
	const first = service.refreshCards(request, target);
	const second = service.refreshCards(request, { ...target, user: target.user.toUpperCase() });
	const read = service.readCards(request);
	const other = await service.refreshCards(request, { provider: "deepseek" });
	match(other.error!, /正在进行/);
	equal(calls.length, 1);
	equal(calls[0].init.method, "POST");
	equal(calls[0].init.body, undefined);
	equal(calls[0].url.searchParams.get("provider"), target.provider);
	equal(calls[0].url.searchParams.get("user"), target.user);
	remote.resolve(response());
	deepStrictEqual(await first, await second);
	deepStrictEqual(await read, service.cards());
	remote = pending();
	const all = service.refreshCards(request);
	equal(calls[1].url.search, "");
	remote.resolve(response());
	await all;
});

test("旧 GET 不覆盖已发起的刷新结果，一个会话取消不取消另一个等待者", async () => {
	const get = pending();
	const post = pending();
	let signal: AbortSignal | null | undefined;
	const service = createMagpieService(catalog(), async (_input, init) => {
		if (init?.method === "POST") return post.promise;
		signal = init?.signal;
		return get.promise;
	});
	const a = new AbortController();
	const first = service.readCards(request, { signal: a.signal });
	const second = service.readCards(request);
	a.abort();
	deepStrictEqual(await first, {});
	equal(signal?.aborted, false);
	const refreshed = service.refreshCards(request);
	post.resolve(Response.json({ object: "list", data: [{ ...cards[0], balance: "$2" }] }));
	await refreshed;
	get.resolve(response());
	await second;
	equal(service.cards().data?.[0].balance, "$2");
});

test("网络与非法 JSON 失败保留旧数据，鉴权失败清除旧卡片", async () => {
	let calls = 0;
	const service = createMagpieService(catalog(), async () => {
		calls++;
		if (calls === 1) return response();
		if (calls === 2) return new Response("not json");
		return new Response(null, { status: 403 });
	});
	const original = await service.readCards(request);
	const malformed = await service.readCards(request, { force: true });
	deepStrictEqual(malformed.data, original.data);
	equal(malformed.fetchedAt, original.fetchedAt);
	const forbidden = await service.readCards(request, { force: true });
	equal(forbidden.data, undefined);
});

test("最后等待者取消后，新查询不会复用已取消的请求", async () => {
	const old = pending();
	let calls = 0;
	let oldSignal: AbortSignal | null | undefined;
	const service = createMagpieService(catalog(), async (_input, init) => {
		calls++;
		if (calls === 1) { oldSignal = init?.signal; return old.promise; }
		return response();
	});
	const caller = new AbortController();
	const cancelled = service.readCards(request, { signal: caller.signal });
	caller.abort();
	await cancelled;
	equal(oldSignal?.aborted, true);
	const next = await service.readCards(request);
	equal(calls, 2);
	equal(next.data?.length, 1);
	old.resolve(response());
});

test("读取与刷新分别使用截止时间，超时保留旧读数和失败状态", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let calls = 0;
	const service = createMagpieService(catalog(), async (_input, init) => {
		if (++calls === 1) return response();
		return new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("合成中止")), { once: true });
		});
	});
	const before = await service.readCards(request);
	const read = service.readCards(request, { force: true });
	t.mock.timers.tick(5_000);
	const failed = await read;
	deepStrictEqual(failed.data, before.data);
	equal(failed.fetchedAt, before.fetchedAt);
	equal(typeof failed.error, "string");
	const post = service.refreshCards(request);
	t.mock.timers.tick(34_999);
	equal(service.cards().error, failed.error);
	t.mock.timers.tick(1);
	const refreshFailed = await post;
	deepStrictEqual(refreshFailed.data, before.data);
	equal(typeof refreshFailed.error, "string");
});

test("全局卡片的失败抑制、接口阻断和显式恢复不随会话重置", async () => {
	let clock = 0;
	let calls = 0;
	const service = createMagpieService(catalog(), async () => {
		calls++;
		return calls === 1 ? new Response(null, { status: 503 })
			: calls === 2 ? new Response(null, { status: 403 }) : response();
	}, () => clock);
	await service.readCards(request, { automatic: true });
	clock = 50_000;
	await service.readCards(request, { automatic: true });
	equal(calls, 1);
	clock = 60_001;
	await service.readCards(request, { automatic: true });
	clock = 120_002;
	await service.readCards(request, { automatic: true });
	equal(calls, 2);
	await service.readCards(request, { force: true });
	equal(calls, 3);
	equal(service.cards().error, undefined);
});

test("共享额度更新通知订阅界面，退出订阅后不再通知，取消响应不发布", async () => {
	let updates = 0;
	const remote = pending();
	let calls = 0;
	const service = createMagpieService(catalog(), async () => ++calls === 1 ? response() : remote.promise);
	const unsubscribe = service.subscribe(() => { updates++; });
	await service.readCards(request);
	equal(updates, 1);
	const controller = new AbortController();
	const next = service.readCards(request, { force: true, signal: controller.signal });
	controller.abort();
	await next;
	remote.resolve(response());
	await new Promise<void>(resolve => setImmediate(resolve));
	equal(updates, 1);
	unsubscribe();
	await service.readCards(request, { force: true });
	equal(updates, 1);
});
