import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createCatalogState } from "./catalog-state.ts";
import { gatewayModelCacheScope, saveGatewayModelCache, DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "#tsgw/models/gateway-catalog";
import { OPENAI_IMAGE_MODEL_IDS } from "#tsgw/models/vendors/openai";

/** 固定登记的图片 ID 与网关派生目录分开断言，避免锁静态目录快照。 */
const IMAGE_IDS = [...OPENAI_IMAGE_MODEL_IDS];
const gatewayIds = (models: ReadonlyArray<{ id: string; type?: string }>): string[] =>
	models.filter(model => model.type !== "image").map(model => model.id);
const imageIds = (models: ReadonlyArray<{ id: string; type?: string }>): string[] =>
	models.filter(model => model.type === "image").map(model => model.id);

function fixture(t: TestContext, age?: number) {
	const dir = mkdtempSync(join(tmpdir(), "tsgw-state-"));
	const root = `https://${randomUUID()}.invalid`;
	const key = "synthetic-key";
	const cacheFilePath = join(dir, "models.json");
	if (age !== undefined) saveGatewayModelCache(cacheFilePath, gatewayModelCacheScope(root, key), ["gpt-6-luna"], Date.now() - age);
	const previous = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => { calls++; return Response.json({ data: [{ id: "gpt-6-sol" }, { id: "unknown" }] }); };
	const directory = createCatalogState({ root, filter: {}, cacheFilePath, imagesEnabled: true,
		classifiersEnabled: true, initialKey: key, onChange() {} });
	t.after(() => { directory.stop(); globalThis.fetch = previous; rmSync(dir, { recursive: true, force: true }); });
	return { root, key, directory, cacheFilePath, calls: () => calls,
		context: (force = false, allowNetwork = true, signal = new AbortController().signal) => ({
			allowNetwork, force, signal, credential: { type: "api_key", key },
		}),
	};
}

for (const age of [undefined, 1000, 2 * TTL]) {
	test(`初始化与会话就绪前只读本地，缓存年龄 ${age}`, async t => {
		const f = fixture(t, age);
		assert.deepEqual(gatewayIds(f.directory.models()), age === undefined ? [] : ["gpt-6-luna"],
			"聊天/分类仍只来自网关目录交集");
		assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS, "无缓存也固定登记图片");
		assert.equal(f.directory.status().source, age === undefined ? "empty" : "cache",
			"empty 只表示网关目录缺席，不表示没有模型");
		assert.equal(f.directory.status().count, f.directory.models().length, "状态计数包含固定图片");
		const local = await f.directory.refresh(f.context(false));
		assert.deepEqual(gatewayIds(local), age === undefined ? [] : ["gpt-6-luna"]);
		assert.deepEqual(imageIds(local), IMAGE_IDS);
		assert.equal(f.calls(), 0);
		assert.equal(f.directory.needsRefresh(), age === undefined || age >= TTL);
		await f.directory.refresh(f.context(true));
		assert.equal(f.calls(), 1, "显式强制刷新不依赖会话生命周期，兼容无会话 CLI");
	});
}

test("非强制刷新采用更新磁盘并同步目录，获取时间不重置", async t => {
	const f = fixture(t, 2000);
	f.directory.enableNetwork();
	const storedAt = Date.now() - 1000;
	saveGatewayModelCache(f.cacheFilePath, gatewayModelCacheScope(f.root, f.key), ["gpt-6-sol", "unknown"], storedAt);
	const result = await f.directory.refresh(f.context());
	assert.deepEqual(gatewayIds(result), ["gpt-6-sol"]);
	assert.deepEqual(imageIds(result), IMAGE_IDS);
	assert.equal(f.calls(), 0);
	assert.deepEqual(f.directory.summary(), { cacheFilePath: f.cacheFilePath, storedAt, count: 2 },
		"摘要仍只统计网关目录本身");
	assert.equal(f.directory.status().storedAt, storedAt);
	assert.equal(f.directory.status().count, result.length, "状态计数 = 网关目录 + 固定图片");
});

test("过期缓存非强制联网，失败不丢旧目录；成功重新应用交集", async t => {
	const f = fixture(t, 2 * TTL);
	f.directory.enableNetwork();
	const original = readFileSync(f.cacheFilePath, "utf8");
	globalThis.fetch = async () => new Response(null, { status: 503 });
	await assert.rejects(f.directory.refresh(f.context()));
	assert.deepEqual(gatewayIds(f.directory.models()), ["gpt-6-luna"], "失败保留原网关目录");
	assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS, "失败不影响固定图片");
	assert.equal(readFileSync(f.cacheFilePath, "utf8"), original);
	assert.equal(f.directory.retryable(), true);
	globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-6-sol" }, { id: "unregistered" }] });
	const recovered = await f.directory.refresh(f.context());
	assert.deepEqual(gatewayIds(recovered), ["gpt-6-sol"]);
	assert.deepEqual(imageIds(recovered), IMAGE_IDS);
	assert.equal(f.directory.status().error, undefined);
	assert.equal(f.directory.summary()?.count, 2);
});

test("401/403 不进入网络退避重试，强制失败不冒充缓存成功", async t => {
	const f = fixture(t, 1000);
	f.directory.enableNetwork();
	for (const status of [401, 403]) {
		globalThis.fetch = async () => new Response(null, { status });
		await assert.rejects(f.directory.refresh(f.context(true)));
		assert.equal(f.directory.retryable(), false);
		assert.deepEqual(gatewayIds(f.directory.models()), ["gpt-6-luna"]);
		assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS);
	}
});

test("旧宿主省略 signal 时可读缓存、强制联网；实例仍可取消自身请求", async t => {
	const f = fixture(t, 1000);
	assert.deepEqual(gatewayIds(await f.directory.refresh({ allowNetwork: false,
		credential: { type: "api_key", key: f.key } })), ["gpt-6-luna"]);
	let requestSignal: AbortSignal | null | undefined;
	let release!: (response: Response) => void;
	globalThis.fetch = async (_input, init) => {
		requestSignal = init?.signal;
		return new Promise(resolve => { release = resolve; });
	};
	const original = readFileSync(f.cacheFilePath, "utf8");
	const pending = f.directory.refresh({ allowNetwork: true, force: true,
		credential: { type: "api_key", key: f.key } });
	await Promise.resolve(); // 让队列启动实际 GET，不依赖墙钟延时。
	assert.equal(f.directory.status().loading, true);
	f.directory.stop();
	assert.equal(requestSignal?.aborted, true);
	assert.equal(f.directory.status().loading, false);
	release(Response.json({ data: [{ id: "gpt-6-sol" }] }));
	await assert.rejects(pending, /取消/);
	assert.deepEqual(gatewayIds(f.directory.models()), ["gpt-6-luna"]);
	assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS);
	assert.equal(readFileSync(f.cacheFilePath, "utf8"), original);
});

test("外部普通/强制回调共享实际获取；取消一个等待者不影响另一个", async t => {
	const f = fixture(t, 2 * TTL);
	f.directory.enableNetwork();
	let calls = 0;
	let signal: AbortSignal | null | undefined;
	let release!: (response: Response) => void;
	globalThis.fetch = async (_input, init) => {
		calls++; signal = init?.signal;
		return new Promise(resolve => { release = resolve; });
	};
	const firstSignal = new AbortController();
	const first = f.directory.refresh(f.context(false, true, firstSignal.signal));
	await Promise.resolve();
	assert.equal(f.directory.refreshKind(), "normal");
	const second = f.directory.refresh(f.context(true));
	assert.equal(f.directory.refreshKind(), "force", "后来强制请求提升同一任务，不另起网络");
	assert.equal(calls, 1);
	const rejected = assert.rejects(first, /已取消/);
	firstSignal.abort();
	await rejected;
	assert.equal(signal?.aborted, false);
	release(Response.json({ data: [{ id: "gpt-6-sol" }] }));
	assert.deepEqual(gatewayIds(await second), ["gpt-6-sol"]);
	assert.equal(calls, 1);
	assert.equal(f.directory.refreshKind(), undefined);
	assert.equal(f.directory.status().loading, false);
	assert.equal(f.directory.status().error, undefined);
});

test("实际共享获取最后一个等待者取消后，新请求不能接到已取消任务", async t => {
	const f = fixture(t, 1000);
	const releases: Array<(response: Response) => void> = [];
	const signals: Array<AbortSignal | null | undefined> = [];
	globalThis.fetch = async (_input, init) => {
		signals.push(init?.signal);
		return new Promise(resolve => { releases.push(resolve); });
	};
	const caller = new AbortController();
	const first = f.directory.refresh(f.context(true, true, caller.signal));
	await Promise.resolve();
	const rejected = assert.rejects(first, /已取消/);
	caller.abort();
	await rejected;
	assert.equal(signals[0]?.aborted, true);
	const second = f.directory.refresh(f.context(true));
	await Promise.resolve();
	releases[1](Response.json({ data: [{ id: "gpt-6-sol" }] }));
	await second;
	releases[0](Response.json({ data: [{ id: "gpt-6-luna" }] }));
	for (let index = 0; index < 12; index++) await Promise.resolve();
	assert.deepEqual(gatewayIds(f.directory.models()), ["gpt-6-sol"]);
	assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS);
	assert.equal(f.directory.status().error, undefined, "迟到取消任务不能污染新任务的状态");
});

test("无凭据、无缓存初始化只登记固定图片；聊天与分类仍取交集并过滤", async t => {
	const dir = mkdtempSync(join(tmpdir(), "tsgw-state-"));
	const root = `https://${randomUUID()}.invalid`;
	const cacheFilePath = join(dir, "models.json");
	saveGatewayModelCache(cacheFilePath, gatewayModelCacheScope(root, "filtered-key"),
		["gpt-6-sol", "jev-latest", "jev-preview"], Date.now());
	const previous = globalThis.fetch;
	globalThis.fetch = async () => { throw new Error("初始化不得联网"); };
	const filtered = createCatalogState({ root,
		filter: { exclude: ["*"], include: ["gpt-6-sol", "jev-preview"] },
		cacheFilePath, imagesEnabled: true, classifiersEnabled: true,
		initialKey: "filtered-key", onChange() {} });
	const unkeyed = createCatalogState({ root, filter: {}, cacheFilePath,
		imagesEnabled: true, classifiersEnabled: true, onChange() {} });
	t.after(() => { filtered.stop(); unkeyed.stop(); globalThis.fetch = previous;
		rmSync(dir, { recursive: true, force: true }); });
	assert.deepEqual(gatewayIds(filtered.models()), ["gpt-6-sol", "jev-preview"],
		"聊天与分类仍只保留网关交集内、且被 include/exclude 允许的型号");
	assert.deepEqual(imageIds(filtered.models()), IMAGE_IDS, "排除全部前缀也不影响固定图片");
	assert.equal(filtered.status().count, filtered.models().length);
	assert.deepEqual(unkeyed.models().map(model => model.id), IMAGE_IDS,
		"无凭据时不读他人作用域缓存，但仍登记固定图片");
	assert.equal(unkeyed.status().source, "empty");
	assert.equal(unkeyed.status().count, IMAGE_IDS.length);
});

test("更换密钥后不能返回旧配置的缓存摘要或目录", async t => {
	const f = fixture(t, 1000);
	f.directory.enableNetwork();
	const ctx = f.context(false, false);
	ctx.credential.key = "replacement-key";
	const replaced = await f.directory.refresh(ctx);
	assert.deepEqual(gatewayIds(replaced), [], "旧网关目录必须作废");
	assert.deepEqual(imageIds(replaced), IMAGE_IDS, "换凭据重置仍保留固定图片");
	assert.equal(f.directory.status().source, "empty");
	assert.equal(f.directory.status().count, IMAGE_IDS.length);
	assert.equal(f.directory.summary(), undefined);
	assert.equal(f.calls(), 0);
});

test("工具交付摘要要求文件属于当前配置且与已应用快照一致", async t => {
	const f = fixture(t, 1000);
	const summary = f.directory.summary();
	assert.ok(summary);
	saveGatewayModelCache(f.cacheFilePath, gatewayModelCacheScope(f.root, f.key), ["same-count-different-model"], summary.storedAt);
	assert.equal(f.directory.summary(), undefined, "同时间同数量也必须逐 ID 对应已应用的快照");
	saveGatewayModelCache(f.cacheFilePath, gatewayModelCacheScope(f.root, "other-key"), ["other-model"], Date.now());
	assert.equal(f.directory.summary(), undefined);
	saveGatewayModelCache(f.cacheFilePath, gatewayModelCacheScope(f.root, f.key), ["newer-model"], Date.now());
	assert.equal(f.directory.summary(), undefined, "未应用的新文件不能报成当前已同步结果");
});

test("同时间同数量但另一实例已更换 ID，旧实例不得交付新文件摘要", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
	const f = fixture(t);
	const other = createCatalogState({ root: f.root, filter: {}, cacheFilePath: f.cacheFilePath,
		initialKey: f.key, imagesEnabled: true, classifiersEnabled: true, onChange() {} });
	t.after(() => other.stop());
	f.directory.enableNetwork(); other.enableNetwork();
	globalThis.fetch = async () => Response.json({ data: [{ id: "gpt-6-sol" }] });
	await f.directory.refresh(f.context(true));
	assert.ok(f.directory.summary());
	globalThis.fetch = async () => Response.json({ data: [{ id: "glm-5.2" }] });
	await other.refresh(f.context(true));
	assert.ok(other.summary());
	assert.equal(f.directory.summary(), undefined);
});

test("不同实例共用实际 GET，各自过滤和退出不干扰另一实例", async t => {
	const f = fixture(t, 2 * TTL);
	let calls = 0;
	let networkSignal: AbortSignal | null | undefined;
	let release!: (response: Response) => void;
	globalThis.fetch = async (_input, init) => {
		calls++; networkSignal = init?.signal;
		return new Promise(resolve => { release = resolve; });
	};
	const second = createCatalogState({ root: f.root, filter: { exclude: ["*"], include: ["glm-5.2"] },
		cacheFilePath: f.cacheFilePath, initialKey: f.key, imagesEnabled: true,
		classifiersEnabled: true, onChange() {} });
	const third = createCatalogState({ root: f.root, filter: { exclude: ["*"], include: ["gpt-6-sol"] },
		cacheFilePath: f.cacheFilePath, initialKey: f.key, imagesEnabled: false,
		classifiersEnabled: false, onChange() {} });
	t.after(() => { second.stop(); third.stop(); });
	f.directory.enableNetwork(); second.enableNetwork(); third.enableNetwork();
	const first = f.directory.refresh(f.context());
	const canceled = assert.rejects(first, /取消/);
	await Promise.resolve();
	const other = second.refresh(f.context(true));
	const background = third.refresh(f.context());
	f.directory.stop();
	await canceled;
	assert.equal(calls, 1);
	assert.equal(networkSignal?.aborted, false);
	release(Response.json({ data: [{ id: "gpt-6-sol" }, { id: "glm-5.2" }, { id: "unknown" }] }));
	const otherModels = await other;
	assert.deepEqual(gatewayIds(otherModels), ["glm-5.2"]);
	assert.deepEqual(imageIds(otherModels), IMAGE_IDS, "include/exclude 不影响固定图片");
	const backgroundModels = await background;
	assert.deepEqual(gatewayIds(backgroundModels), ["gpt-6-sol"]);
	assert.deepEqual(imageIds(backgroundModels), [], "宿主不支持图片能力时不登记图片");
	assert.deepEqual(gatewayIds(f.directory.models()), ["gpt-6-luna"]);
	assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS, "退出取消刷新但保留已有目录与固定图片");
	assert.equal(calls, 1);
	assert.equal(second.status().error, undefined);
	assert.equal(third.status().error, undefined);
});

test("截止或退出使迟到请求失效；不能覆盖失败提示、模型及磁盘", async t => {
	const f = fixture(t, 1000);
	f.directory.enableNetwork();
	const original = readFileSync(f.cacheFilePath, "utf8");
	let release!: (response: Response) => void;
	globalThis.fetch = async () => new Promise(resolve => { release = resolve; });
	const controller = new AbortController();
	const pending = f.directory.refresh(f.context(true, true, controller.signal));
	await Promise.resolve(); // 验证实际 GET 已开始后的迟到完成，而非排队前取消。
	f.directory.invalidate();
	const message = f.directory.fail();
	controller.abort();
	release(Response.json({ data: [{ id: "gpt-6-sol" }] }));
	await assert.rejects(pending);
	assert.deepEqual(gatewayIds(f.directory.models()), ["gpt-6-luna"]);
	assert.deepEqual(imageIds(f.directory.models()), IMAGE_IDS);
	assert.equal(f.directory.status().error, message);
	assert.equal(readFileSync(f.cacheFilePath, "utf8"), original);
});
