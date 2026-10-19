import { deepStrictEqual, equal, match } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test, type TestContext } from "node:test";
import {
	gatewayModelCacheScope, getCachedGatewayModelIds, getGatewayModelIds, loadGatewayModelCache,
	saveGatewayModelCache, type GatewayFetch,
} from "./gateway-catalog.ts";

function fixture(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "gateway-isolation-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { root: `https://${randomUUID()}.invalid`, path: join(directory, "models.json") };
}
function response(id: string) {
	return new Response(JSON.stringify({ data: [{ id }] }));
}
function deferred() {
	let resolve!: (value: Response) => void;
	let calls = 0;
	const promise = new Promise<Response>((done) => { resolve = done; });
	const fetcher: GatewayFetch = () => { calls++; return promise; };
	return { resolve, fetcher, calls: () => calls };
}
const unavailable: GatewayFetch = async () => new Response(null, { status: 503 });

test("作用域对根地址与凭据取哈希，且仅归一化末尾斜杠", () => {
	const scope = gatewayModelCacheScope("https://example.invalid", "secret");
	match(scope, /^[a-f0-9]{64}$/);
	equal(scope, gatewayModelCacheScope("https://example.invalid/", "secret"));
	equal(scope === gatewayModelCacheScope("https://other.invalid", "secret"), false);
	equal(scope === gatewayModelCacheScope("https://example.invalid", "other"), false);
});

for (const change of ["root", "credential"] as const) {
	test(`内存与进行中的请求按${change === "root" ? "根地址" : "凭据"}隔离`, async (t) => {
		const { root } = fixture(t);
		const otherRoot = change === "root" ? `${root}/other` : root;
		const otherKey = change === "credential" ? "other-key" : "key";
		const a = deferred(), b = deferred();
		const first = getGatewayModelIds(root, "key", { fetcher: a.fetcher }, 1);
		const second = getGatewayModelIds(otherRoot, otherKey, { fetcher: b.fetcher }, 2);
		equal(a.calls(), 1); equal(b.calls(), 1);
		b.resolve(response("B")); a.resolve(response("A"));
		await Promise.all([first, second]);
		for (const [url, key, id, storedAt] of [
			[root, "key", "A", 1], [otherRoot, otherKey, "B", 2],
		] as const) {
			deepStrictEqual(await getGatewayModelIds(url, key, { fetcher: unavailable }, 3), {
				ok: true, ids: [id], cached: true, stale: false, storedAt,
			});
		}
	});
	test(`磁盘缓存拒绝不同${change === "root" ? "根地址" : "凭据"}，包括过期回退`, async (t) => {
		const { root, path } = fixture(t);
		const scope = gatewayModelCacheScope(root, "key");
		saveGatewayModelCache(path, scope, ["private-model"], 0);
		const otherRoot = change === "root" ? `${root}/other` : root;
		const otherKey = change === "credential" ? "other-key" : "key";
		for (const now of [1, 999999]) {
			deepStrictEqual(await getGatewayModelIds(otherRoot, otherKey, {
				cacheFilePath: path, fetcher: unavailable,
			}, now), { ok: false, reason: "http", status: 503 });
		}
		equal(loadGatewayModelCache(path, gatewayModelCacheScope(otherRoot, otherKey)), undefined);
		const raw = readFileSync(path, "utf8");
		equal(raw.includes(root), false); equal(raw.includes('"key"'), false);
	});
}

test("忽略无作用域的旧版磁盘缓存，并在请求成功时替换", async (t) => {
	const { root, path } = fixture(t);
	writeFileSync(path, JSON.stringify({ ids: ["legacy-private"], storedAt: 0 }));
	const scope = gatewayModelCacheScope(root, "key");
	equal(loadGatewayModelCache(path, scope, 1), undefined);
	deepStrictEqual(await getGatewayModelIds(root, "key", {
		cacheFilePath: path, fetcher: unavailable,
	}, 1), { ok: false, reason: "http", status: 503 });
	await getGatewayModelIds(root, "key", {
		cacheFilePath: path, fetcher: async () => response("new"),
	}, 2);
	deepStrictEqual(loadGatewayModelCache(path, scope, 3), { ids: ["new"], fresh: true });
});

for (const outcome of ["success", "failure", "abort"] as const) {
	test(`较新请求${outcome === "success" ? "成功" : outcome === "failure" ? "失败" : "取消"}后，迟到的旧成功结果不得覆盖`, async (t) => {
		const { root, path } = fixture(t);
		const scope = gatewayModelCacheScope(root, "key");
		await getGatewayModelIds(root, "key", {
			cacheFilePath: path, fetcher: async () => response("baseline"),
		}, 0);
		const old = deferred(), newer = deferred();
		const oldRequest = getGatewayModelIds(root, "key", {
			cacheFilePath: path, force: true, fetcher: old.fetcher,
			signal: new AbortController().signal,
		}, 1);
		const controller = new AbortController();
		const newRequest = getGatewayModelIds(root, "key", {
			cacheFilePath: path, force: true, fetcher: newer.fetcher, signal: controller.signal,
		}, 2);
		if (outcome === "abort") controller.abort();
		newer.resolve(outcome === "failure" ? new Response(null, { status: 503 }) : response("new"));
		const result = await newRequest;
		if (outcome === "abort") deepStrictEqual(result, { ok: false, reason: "aborted" });
		old.resolve(response("old"));
		const oldResult = await oldRequest;
		equal(oldResult.ok, true);
		const id = outcome === "success" ? "new" : "baseline";
		deepStrictEqual(loadGatewayModelCache(path, scope, 3)?.ids, [id]);
		deepStrictEqual(await getGatewayModelIds(root, "key", { cacheFilePath: path, fetcher: unavailable }, 3), {
			ok: true, ids: [id], cached: true, stale: false,
			storedAt: outcome === "success" ? 2 : 0,
		});
	});
}

test("普通与强制请求分离；迟到的普通成功结果不能撤销强制刷新", async (t) => {
	const { root } = fixture(t);
	const old = deferred();
	const first = getGatewayModelIds(root, "key", { fetcher: old.fetcher }, 0);
	await getGatewayModelIds(root, "key", { force: true, fetcher: async () => response("new") }, 1);
	old.resolve(response("old")); await first;
	const result = await getGatewayModelIds(root, "key", { fetcher: unavailable }, 2);
	if (!result.ok) throw new Error("应命中缓存");
	deepStrictEqual(result.ids, ["new"]);
});

test("无 signal 的请求去重保留发起时间戳；取消请求不共享其 signal", async (t) => {
	const { root } = fixture(t);
	const shared = deferred(), isolated = deferred();
	const first = getGatewayModelIds(root, "key", { fetcher: shared.fetcher }, 10);
	const second = getGatewayModelIds(root, "key", { fetcher: shared.fetcher }, 11);
	const controller = new AbortController();
	const third = getGatewayModelIds(root, "key", {
		fetcher: isolated.fetcher, signal: controller.signal,
	}, 12);
	equal(shared.calls(), 1); equal(isolated.calls(), 1);
	controller.abort(); isolated.resolve(response("cancelled"));
	deepStrictEqual(await third, { ok: false, reason: "aborted" });
	shared.resolve(response("shared"));
	for (const result of await Promise.all([first, second])) {
		if (!result.ok) throw new Error("独立请求应成功");
		equal(result.storedAt, 10);
	}
	// 较新的已取消请求也会撤销旧请求的写入权限。
	deepStrictEqual(await getGatewayModelIds(root, "key", { fetcher: unavailable }, 13), {
		ok: false, reason: "http", status: 503,
	});
});

for (const change of ["root", "credential"] as const) {
	for (const outcome of ["success", "failure"] as const) {
		test(`较新请求${outcome === "success" ? "成功" : "失败"}后，单一磁盘位置阻止旧${change === "root" ? "根地址" : "凭据"}请求的迟到成功结果写入`, async (t) => {
			const { root, path } = fixture(t);
			const otherRoot = change === "root" ? `${root}/other` : root;
			const otherKey = change === "credential" ? "other-key" : "key";
			const scope = gatewayModelCacheScope(otherRoot, otherKey);
			saveGatewayModelCache(path, scope, ["baseline"], 0);
			const old = deferred();
			const first = getGatewayModelIds(root, "key", {
				cacheFilePath: path, force: true, fetcher: old.fetcher,
			}, 1);
			// 相对路径与点路径段别名必须标识同一磁盘位置。
			const alias = `${relative(process.cwd(), dirname(path))}/./models.json`;
			await getGatewayModelIds(otherRoot, otherKey, {
				cacheFilePath: alias, force: true,
				fetcher: outcome === "success" ? async () => response("new") : unavailable,
			}, 2);
			const persisted = readFileSync(path, "utf8");
			// 旧共享请求的迟到订阅者不能重新占用此位置。
			const subscriber = getGatewayModelIds(root, "key", {
				cacheFilePath: alias, force: true, fetcher: old.fetcher,
			}, 3);
			equal(old.calls(), 1);
			old.resolve(response("old"));
			await Promise.all([first, subscriber]);
			equal(readFileSync(path, "utf8"), persisted);
			deepStrictEqual(loadGatewayModelCache(path, scope, 4)?.ids,
				[outcome === "success" ? "new" : "baseline"]);
			// 磁盘写入防护不得丢弃其他作用域的有效内存结果。
			const memory = await getGatewayModelIds(root, "key", { cacheFilePath: path, fetcher: unavailable }, 4);
			if (!memory.ok) throw new Error("应命中独立内存缓存");
			deepStrictEqual(memory.ids, ["old"]);
			equal(memory.storedAt, 1);
		});
	}
}

test("单个无 signal 的共享请求独立持久化到多个路径", async (t) => {
	const { root, path } = fixture(t);
	const otherPath = join(dirname(path), "other.json");
	const old = deferred();
	const first = getGatewayModelIds(root, "key", { cacheFilePath: path, fetcher: old.fetcher }, 1);
	const second = getGatewayModelIds(root, "key", { cacheFilePath: otherPath, fetcher: old.fetcher }, 2);
	equal(old.calls(), 1);
	old.resolve(response("shared"));
	await Promise.all([first, second]);
	const scope = gatewayModelCacheScope(root, "key");
	for (const destination of [path, otherPath]) {
		deepStrictEqual(loadGatewayModelCache(destination, scope, 3), { ids: ["shared"], fresh: true });
		equal(JSON.parse(readFileSync(destination, "utf8")).storedAt, 1);
	}
});

test("磁盘写入防护仅影响共享请求中有竞争的路径", async (t) => {
	const { root, path } = fixture(t);
	const otherPath = join(dirname(path), "other.json");
	const old = deferred();
	const first = getGatewayModelIds(root, "key", { cacheFilePath: path, fetcher: old.fetcher }, 1);
	const second = getGatewayModelIds(root, "key", { cacheFilePath: otherPath, fetcher: old.fetcher }, 2);
	await getGatewayModelIds(root, "other-key", {
		cacheFilePath: path, fetcher: async () => response("new"),
	}, 3);
	old.resolve(response("shared"));
	await Promise.all([first, second]);
	deepStrictEqual(loadGatewayModelCache(path, gatewayModelCacheScope(root, "other-key"), 4)?.ids, ["new"]);
	deepStrictEqual(loadGatewayModelCache(otherPath, gatewayModelCacheScope(root, "key"), 4)?.ids, ["shared"]);
});

test("相同网关与密钥的内存快照按规范化缓存路径隔离", async (t) => {
	const { root, path } = fixture(t);
	const otherPath = join(dirname(path), "other.json");
	await getGatewayModelIds(root, "key", { cacheFilePath: path, fetcher: async () => response("A") }, 1);
	equal(getCachedGatewayModelIds(root, "key", { cacheFilePath: otherPath }, 2), undefined);
	deepStrictEqual(await getGatewayModelIds(root, "key", { cacheFilePath: otherPath, fetcher: unavailable }, 2),
		{ ok: false, reason: "http", status: 503 });
	await getGatewayModelIds(root, "key", { cacheFilePath: otherPath, fetcher: async () => response("B") }, 3);
	const alias = `${relative(process.cwd(), dirname(path))}/./models.json`;
	deepStrictEqual(getCachedGatewayModelIds(root, "key", { cacheFilePath: alias }, 4)?.ids, ["A"]);
	deepStrictEqual(getCachedGatewayModelIds(root, "key", { cacheFilePath: otherPath }, 4)?.ids, ["B"]);
	equal(getCachedGatewayModelIds(root, "key", {}, 4), undefined, "无路径调用不混入其他宿主目录的内存");
});

test("不同缓存路径的并发请求互不撤销内存和磁盘写入权限", async (t) => {
	const { root, path } = fixture(t);
	const otherPath = join(dirname(path), "other.json");
	const a = deferred(), b = deferred();
	const first = getGatewayModelIds(root, "key", { cacheFilePath: path, force: true,
		fetcher: a.fetcher, signal: new AbortController().signal }, 1);
	const second = getGatewayModelIds(root, "key", { cacheFilePath: otherPath, force: true,
		fetcher: b.fetcher, signal: new AbortController().signal }, 2);
	b.resolve(response("B"));
	await second;
	a.resolve(response("A"));
	await first;
	const scope = gatewayModelCacheScope(root, "key");
	for (const [file, id] of [[path, "A"], [otherPath, "B"]]) {
		deepStrictEqual(getCachedGatewayModelIds(root, "key", { cacheFilePath: file }, 3)?.ids, [id]);
		deepStrictEqual(loadGatewayModelCache(file, scope, 3)?.ids, [id]);
	}
});

test("预先取消的请求不能返回新鲜内存或磁盘条目", async (t) => {
	const { root, path } = fixture(t);
	await getGatewayModelIds(root, "key", {
		cacheFilePath: path, fetcher: async () => response("cached"),
	}, 0);
	const signal = AbortSignal.abort();
	deepStrictEqual(await getGatewayModelIds(root, "key", { signal, cacheFilePath: path }, 1), {
		ok: false, reason: "aborted",
	});
});
