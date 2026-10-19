import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { getGatewayCatalogService } from "./gateway-catalog-service.ts";
import { gatewayModelCacheScope, saveGatewayModelCache } from "./gateway-catalog.ts";

function fixture(t: TestContext, ids?: string[]) {
	const dir = mkdtempSync(join(tmpdir(), "tsgw-shared-"));
	const root = `https://${randomUUID()}.invalid`;
	const key = "synthetic-key";
	const path = join(dir, "models.json");
	if (ids) saveGatewayModelCache(path, gatewayModelCacheScope(root, key), ids, Date.now() - 1000);
	const service = getGatewayCatalogService(root, key, path);
	const original = globalThis.fetch;
	const releases: Array<(response: Response) => void> = [];
	const signals: Array<AbortSignal | null | undefined> = [];
	globalThis.fetch = async (_input, init) => {
		signals.push(init?.signal);
		return new Promise(resolve => { releases.push(resolve); });
	};
	t.after(() => {
		service.invalidate();
		for (const release of releases) release(new Response(null, { status: 503 }));
		globalThis.fetch = original;
		rmSync(dir, { recursive: true, force: true });
	});
	return { dir, root, key, path, service, releases, signals,
		respond: (i: number, values = ["new-model"]) => releases[i](Response.json({ data: values.map(id => ({ id })) })),
	};
}

async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const network = { allowNetwork: true };

test("不同实例与强制/普通请求合并，同一实际 GET 返回防御性快照", async t => {
	const f = fixture(t);
	const second = getGatewayCatalogService(f.root, f.key, f.path);
	assert.equal(second, f.service);
	const first = f.service.request(f.key, network);
	await drain();
	const other = second.request(f.key, { ...network, force: true });
	assert.equal(f.service.refreshKind(), "force");
	assert.equal(f.signals.length, 1);
	f.respond(0);
	const [a, b] = await Promise.all([first, other]);
	assert.equal(a.networkSucceeded, true);
	assert.equal(b.networkSucceeded, true);
	a.snapshot!.ids.push("mutation");
	assert.deepEqual(b.snapshot!.ids, ["new-model"]);
	assert.deepEqual(f.service.read(f.key)!.ids, ["new-model"]);
	const next = second.request(f.key, { ...network, force: true });
	await drain();
	assert.equal(f.signals.length, 2, "已结束任务不能吞掉新的 force");
	f.respond(1);
	await next;
});

test("同批强制请求提升尚未决策的缓存任务，不受新鲜缓存吞掉", async t => {
	const f = fixture(t, ["cached"]);
	const ordinary = f.service.request(f.key, network);
	const forced = f.service.request(f.key, { ...network, force: true });
	await drain();
	assert.equal(f.signals.length, 1);
	f.respond(0);
	for (const outcome of await Promise.all([ordinary, forced])) {
		assert.equal(outcome.networkSucceeded, true);
		assert.deepEqual(outcome.snapshot!.ids, ["new-model"]);
	}
});

test("缓存已经决策但尚未交付时，force 不能错误复用缓存", async t => {
	const f = fixture(t, ["cached"]);
	const ordinary = f.service.request(f.key, network);
	await Promise.resolve();
	const forced = f.service.request(f.key, { ...network, force: true });
	await drain();
	assert.equal((await ordinary).networkAttempted, false);
	assert.equal(f.signals.length, 1);
	f.respond(0);
	assert.equal((await forced).networkSucceeded, true);
});

test("缓存交接期间普通等待者取消，不得误取消另一个 force", async t => {
	const f = fixture(t, ["cached"]);
	const caller = new AbortController();
	const ordinary = f.service.request(f.key, { ...network, signal: caller.signal });
	const canceled = assert.rejects(ordinary, /取消/);
	await Promise.resolve();
	const forced = f.service.request(f.key, { ...network, force: true });
	caller.abort();
	await canceled;
	await drain();
	assert.equal(f.signals.length, 1);
	f.respond(0);
	assert.equal((await forced).networkSucceeded, true);
});

test("缓存交接期间 force 自身取消，不得发起额外 GET", async t => {
	const f = fixture(t, ["cached"]);
	const ordinary = f.service.request(f.key, network);
	await Promise.resolve();
	const caller = new AbortController();
	const forced = f.service.request(f.key, { ...network, force: true, signal: caller.signal });
	const canceled = assert.rejects(forced, /取消/);
	caller.abort();
	await ordinary;
	await canceled;
	assert.equal(f.signals.length, 0);
});

test("单个调用取消不影响其他等待者；最后取消会中止 GET", async t => {
	const f = fixture(t);
	const one = new AbortController();
	const two = new AbortController();
	const first = f.service.request(f.key, { ...network, signal: one.signal });
	const second = f.service.request(f.key, { ...network, signal: two.signal });
	const rejectsFirst = assert.rejects(first, /取消/);
	const rejectsSecond = assert.rejects(second, /取消/);
	await drain();
	one.abort();
	await rejectsFirst;
	assert.equal(f.signals[0]?.aborted, false);
	two.abort();
	await rejectsSecond;
	assert.equal(f.signals[0]?.aborted, true);
	const third = f.service.request(f.key, network);
	await drain();
	assert.equal(f.signals.length, 2);
	f.respond(1, ["latest"]);
	await third;
	f.respond(0, ["late"]);
	await drain();
	assert.deepEqual(f.service.read(f.key)!.ids, ["latest"]);
});

test("本地读取不等待或取消网络，磁盘新快照保留原始时间", async t => {
	const f = fixture(t, ["cached"]);
	const pending = f.service.request(f.key, { ...network, force: true });
	await drain();
	const storedAt = Date.now() - 500;
	saveGatewayModelCache(f.path, gatewayModelCacheScope(f.root, f.key), ["disk-update"], storedAt);
	const local = await f.service.request(f.key, { allowNetwork: false, force: true });
	assert.deepEqual(local.snapshot!.ids, ["disk-update"]);
	assert.equal(local.snapshot!.storedAt, storedAt);
	assert.equal(local.networkAttempted, false);
	assert.equal(f.signals[0]?.aborted, false);
	f.respond(0);
	await pending;
});

test("失败向所有等待者交付一次结果；认证失败不可重试，手动获取不自动重试", async t => {
	const f = fixture(t, ["cached"]);
	for (const code of [503, 401, 403]) {
		const a = f.service.request(f.key, { ...network, force: true });
		const b = f.service.request(f.key, { ...network, force: true });
		await drain();
		const index = f.signals.length - 1;
		f.releases[index](new Response(null, { status: code }));
		const [first, second] = await Promise.all([a, b]);
		assert.equal(first.failed, true);
		assert.equal(first.networkSucceeded, false);
		assert.equal(first.retryable, code === 503);
		assert.deepEqual(first, second);
		await drain();
		assert.equal(f.signals.length, index + 1);
	}
});

test("当前配置替换使旧服务失效；旧结果不得覆盖新配置缓存", async t => {
	const f = fixture(t);
	const old = f.service.request(f.key, network);
	const oldRejected = assert.rejects(old, /取消/);
	await drain();
	const replacement = getGatewayCatalogService(f.root, "replacement", f.path);
	t.after(() => replacement.invalidate());
	await oldRejected;
	assert.equal(f.signals[0]?.aborted, true);
	assert.throws(() => f.service.read(f.key), /取消/);
	const next = replacement.request("replacement", network);
	await drain();
	f.respond(1, ["current"]);
	await next;
	f.respond(0, ["old"]);
	await drain();
	const stored = JSON.parse(readFileSync(f.path, "utf8"));
	assert.deepEqual(stored.ids, ["current"]);
	assert.equal(stored.scope, gatewayModelCacheScope(f.root, "replacement"));
});

test("网络已提交但尚未交付时替换配置，旧 waiter 不得收到成功", async t => {
	const f = fixture(t);
	const pending = f.service.request(f.key, network);
	const rejected = assert.rejects(pending, /取消/);
	await drain();
	f.respond(0, ["old-model"]);
	// 等到服务清除已结算任务，但其 waiter 的交付微任务尚未运行。
	for (let i = 0; f.service.refreshKind() !== undefined; i++) {
		assert.ok(i < 100);
		await Promise.resolve();
	}
	const replacement = getGatewayCatalogService(f.root, "replacement", f.path);
	t.after(() => replacement.invalidate());
	await rejected;
});

test("旧版本共享对象不能被热重载后的新契约直接复用", t => {
	const f = fixture(t);
	const symbol = Symbol.for("pi-tsgw:gateway-catalog");
	const globals = globalThis as Record<symbol, unknown>;
	const previous = globals[symbol];
	try {
		globals[symbol] = { version: 1, slots: new Map([[f.path, { scope: gatewayModelCacheScope(f.root, f.key) }]]) };
		assert.throws(() => getGatewayCatalogService(f.root, f.key, f.path), /重启宿主/);
	} finally { globals[symbol] = previous; }
});

test("显式失效后的同配置重新获取服务，不复用已失效对象", async t => {
	const f = fixture(t);
	f.service.invalidate();
	const next = getGatewayCatalogService(f.root, f.key, f.path);
	t.after(() => next.invalidate());
	assert.notEqual(next, f.service);
	assert.equal(next.valid(), true);
});

test("共享恢复与手动强制获取只共享当前 GET；恢复退出不取消手动等待者", async t => {
	const f = fixture(t);
	const caller = new AbortController();
	const recovery = f.service.recover(f.key, caller.signal);
	const rejected = assert.rejects(recovery, /取消/);
	await drain();
	const manual = f.service.request(f.key, { ...network, force: true });
	await drain();
	assert.equal(f.signals.length, 1);
	caller.abort();
	await rejected;
	assert.equal(f.signals[0]?.aborted, false, "恢复退出只能解除它自己的等待");
	f.respond(0);
	assert.equal((await manual).networkSucceeded, true);
	assert.equal(f.signals.length, 1);
});

test("共享恢复截止时，刚加入的手动 GET 不受恢复 deadline 取消", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
	const f = fixture(t);
	const recovery = f.service.recover(f.key);
	await drain();
	f.releases[0](new Response(null, { status: 503 }));
	await drain();
	// 恢复仍在等待重试，先推进到截止前；不运行微任务，避免人为启动已超时的 GET。
	t.mock.timers.tick(59_000);
	const manual = f.service.request(f.key, { ...network, force: true });
	await drain();
	assert.equal(f.signals.length, 2);
	t.mock.timers.tick(1000);
	await drain();
	assert.equal((await recovery).failed, true);
	assert.equal(f.signals[1]?.aborted, false);
	f.respond(1);
	assert.equal((await manual).networkSucceeded, true);
});

test("手动获取失败立即返回，不跟着共享恢复一起重试", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
	const f = fixture(t);
	const recovery = f.service.recover(f.key);
	await drain();
	const manual = f.service.request(f.key, { ...network, force: true });
	f.releases[0](new Response(null, { status: 503 }));
	await drain();
	assert.equal((await manual).failed, true);
	assert.equal(f.signals.length, 1);
	t.mock.timers.tick(5000);
	await drain();
	assert.equal(f.signals.length, 2);
	f.respond(1);
	assert.equal((await recovery).networkSucceeded, true);
});

test("恢复驱动实例退出后，其他恢复等待者保活同一个 GET 并接手登记", async t => {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100_000 });
	const f = fixture(t);
	const firstCaller = new AbortController();
	const driver = new AbortController();
	const first = f.service.recoverUsing(() => f.service.request(f.key,
		{ allowNetwork: true, signal: driver.signal }), firstCaller.signal);
	const rejected = assert.rejects(first, /取消/);
	const second = f.service.recoverUsing(signal => f.service.request(f.key, { allowNetwork: true, signal }));
	await drain();
	assert.equal(f.signals.length, 1);
	firstCaller.abort();
	driver.abort();
	await rejected;
	assert.equal(f.signals[0]?.aborted, false);
	f.respond(0);
	await drain();
	t.mock.timers.tick(5000);
	await drain();
	assert.deepEqual((await second).snapshot!.ids, ["new-model"]);
	assert.equal(f.signals.length, 1);
});

test("最后一个恢复实例退出会释放已失去网络 waiter 的 GET", async t => {
	const f = fixture(t);
	const caller = new AbortController();
	const driver = new AbortController();
	const pending = f.service.recoverUsing(() => f.service.request(f.key,
		{ allowNetwork: true, signal: driver.signal }), caller.signal);
	const rejected = assert.rejects(pending, /取消/);
	await drain();
	driver.abort();
	assert.equal(f.signals[0]?.aborted, false);
	caller.abort();
	await rejected;
	assert.equal(f.signals[0]?.aborted, true);
});

test("真实 SDK 在不同 cwd 用 jiti 重导入工厂仍复用同一共享服务，工厂零网络", async t => {
	const f = fixture(t);
	const sdk = await import("@earendil-works/pi-coding-agent");
	const symbol = Symbol.for(`tsgw-service-test:${randomUUID()}`);
	const globals = globalThis as typeof globalThis & { [symbol]: unknown[] };
	globals[symbol] = [];
	t.after(() => { delete (globals as Record<symbol, unknown>)[symbol]; });
	// 测试运行在 dist，定位真实 TS 源码，让宿主 jiti 而非 Node 模块缓存负责加载。
	let source = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(source, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw") break;
		const parent = dirname(source);
		assert.notEqual(parent, source);
		source = parent;
	}
	const extension = join(f.dir, "probe.ts");
	writeFileSync(extension, `import { getGatewayCatalogService } from ${JSON.stringify(join(source, "extensions/models/gateway-catalog-service.ts"))};
export default function () { globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(symbol))})].push(getGatewayCatalogService(${JSON.stringify(f.root)}, ${JSON.stringify(f.key)}, ${JSON.stringify(f.path)})); }`);
	for (const cwd of [join(f.dir, "a"), join(f.dir, "b")]) {
		mkdirSync(cwd);
		const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: f.dir,
			settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
			additionalExtensionPaths: [extension], noSkills: true, noPromptTemplates: true,
			noThemes: true, noContextFiles: true });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
	}
	assert.equal(globals[symbol].length, 2);
	assert.equal(globals[symbol][0], f.service);
	assert.equal(globals[symbol][1], f.service);
	assert.equal(f.signals.length, 0);
});
