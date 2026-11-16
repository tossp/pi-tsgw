import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { GatewayCatalogService } from "./gateway-catalog-service.ts";
import type { CachedGatewayModelIds, GetGatewayModelIdsResult } from "./gateway-catalog.ts";
import type { MagpieService } from "../magpie/service.ts";

interface Loaded {
	catalog: GatewayCatalogService;
	magpie: MagpieService;
	fetchIds(signal?: AbortSignal, now?: number): Promise<GetGatewayModelIdsResult>;
	readCache(): CachedGatewayModelIds | undefined;
}

async function fixture(t: TestContext) {
	const sdk = await import("@earendil-works/pi-coding-agent");
	const dir = mkdtempSync(join(tmpdir(), "tsgw-reload-"));
	const root = `https://${randomUUID()}.invalid`;
	const key = "synthetic-key";
	const path = join(dir, "models.json");
	const symbol = Symbol.for(`tsgw-reload-test:${randomUUID()}`);
	const globals = globalThis as typeof globalThis & { [symbol]: Loaded[] };
	globals[symbol] = [];
	let source = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(source, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw") break;
		const parent = dirname(source);
		assert.notEqual(parent, source);
		source = parent;
	}
	const extension = join(dir, "probe.ts");
	writeFileSync(extension, `
import { getGatewayCatalogService } from ${JSON.stringify(join(source, "extensions/models/gateway-catalog-service.ts"))};
import { getGatewayModelIds, getCachedGatewayModelIds } from ${JSON.stringify(join(source, "extensions/models/gateway-catalog.ts"))};
import { getMagpieService } from ${JSON.stringify(join(source, "extensions/magpie/service.ts"))};
export default function () {
  const root = ${JSON.stringify(root)}, key = ${JSON.stringify(key)}, path = ${JSON.stringify(path)};
  const catalog = getGatewayCatalogService(root, key, path);
  globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(symbol))})].push({
    catalog, magpie: getMagpieService(catalog),
    fetchIds: (signal, now) => getGatewayModelIds(root, key, { cacheFilePath: path, force: true, signal }, now),
    readCache: () => getCachedGatewayModelIds(root, key, { cacheFilePath: path }),
  });
}
`);
	const original = globalThis.fetch;
	const requests: Array<{ url: string; signal?: AbortSignal | null; respond: (response: Response) => void }> = [];
	globalThis.fetch = async (input, init) => new Promise(resolve => {
		requests.push({ url: String(input), signal: init?.signal, respond: resolve });
	});
	const loaders = new Map<string, InstanceType<typeof sdk.DefaultResourceLoader>>();
	t.after(() => {
		for (const loaded of globals[symbol]) loaded.catalog.invalidate();
		for (const request of requests) request.respond(new Response(null, { status: 503 }));
		delete (globals as Record<symbol, unknown>)[symbol];
		globalThis.fetch = original;
		rmSync(dir, { recursive: true, force: true });
	});
	return {
		root, key, path, requests,
		request: { root, headers: new Headers({ Authorization: "Bearer synthetic-key" }) },
		async load(name: string): Promise<Loaded> {
			let loader = loaders.get(name);
			if (!loader) {
				const cwd = join(dir, name);
				mkdirSync(cwd);
				loader = new sdk.DefaultResourceLoader({ cwd, agentDir: dir,
					settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
					additionalExtensionPaths: [extension], noSkills: true, noPromptTemplates: true,
					noThemes: true, noContextFiles: true });
				loaders.set(name, loader);
			}
			await loader.reload();
			assert.deepEqual(loader.getExtensions().errors, []);
			return globals[symbol].at(-1)!;
		},
		models(index: number, id = "model-a") {
			requests[index].respond(Response.json({ data: [{ id, magpie_label: "synthetic" }] }));
		},
		cards(index: number, used: number) {
			requests[index].respond(Response.json({ object: "list", data: [{ provider: "codex", windows: [{ used }] }] }));
		},
	};
}

async function flush(): Promise<void> {
	for (let i = 0; i < 30; i++) await Promise.resolve();
}

test("A 运行时 B 重载，方法更新而目录 GET、额度 GET 和订阅继续共享", async t => {
	const f = await fixture(t);
	const a = await f.load("a");
	const b = await f.load("b");
	assert.equal(f.requests.length, 0, "工厂只绑定状态，不发请求");
	assert.notEqual(a.catalog.request, b.catalog.request);
	assert.notEqual(a.magpie.readCards, b.magpie.readCards);
	assert.equal(a.catalog.identity, b.catalog.identity);
	const caller = new AbortController();
	const first = a.catalog.request(f.key, { allowNetwork: true, signal: caller.signal });
	const rejected = assert.rejects(first, /取消/);
	await flush();
	const second = b.catalog.request(f.key, { allowNetwork: true });
	caller.abort();
	await rejected;
	assert.equal(f.requests.length, 1);
	assert.equal(f.requests[0].signal?.aborted, false);
	f.models(0);
	await second;
	assert.deepEqual(a.catalog.peek()?.ids, ["model-a"]);

	let oldNotifications = 0, currentNotifications = 0;
	const release = a.magpie.subscribe(() => oldNotifications++);
	b.magpie.subscribe(() => currentNotifications++);
	const cardCaller = new AbortController();
	const oldCards = a.magpie.readCards(f.request, { signal: cardCaller.signal });
	const currentCards = b.magpie.readCards(f.request);
	release();
	cardCaller.abort();
	assert.deepEqual(await oldCards, {});
	assert.equal(f.requests.length, 2);
	assert.equal(f.requests[1].signal?.aborted, false);
	f.cards(1, 20);
	await currentCards;
	assert.equal(oldNotifications, 0);
	assert.equal(currentNotifications, 1);
	const reloaded = await f.load("b");
	assert.notEqual(reloaded.magpie.readCards, b.magpie.readCards);
	assert.deepEqual(reloaded.magpie.cards(), a.magpie.cards());
	await reloaded.magpie.readCards(f.request);
	assert.equal(f.requests.length, 2, "重载后复用额度快照，不额外 GET");
});

test("重载后的上游额度刷新完成，旧 GET 迟到不能覆盖新读数", async t => {
	const f = await fixture(t);
	const a = await f.load("a");
	const catalog = a.catalog.request(f.key, { allowNetwork: true });
	await flush(); f.models(0); await catalog;
	const old = a.magpie.readCards(f.request);
	const b = await f.load("b");
	const refresh = b.magpie.refreshCards(f.request);
	assert.equal(f.requests.length, 3);
	f.cards(2, 80);
	await refresh;
	f.cards(1, 0);
	await old;
	assert.equal(a.magpie.cards().data?.[0].windows?.[0].used, 80);
	assert.equal(b.magpie.cards().data?.[0].windows?.[0].used, 80);
});

test("重导入的底层目录请求共享写入顺序，旧结果不回写磁盘或内存", async t => {
	const f = await fixture(t);
	const a = await f.load("a");
	const old = a.fetchIds(new AbortController().signal, 100);
	const b = await f.load("b");
	const current = b.fetchIds(new AbortController().signal, 200);
	assert.equal(f.requests.length, 2);
	f.models(1, "current");
	await current;
	f.models(0, "late");
	const late = await old;
	assert.ok(late.ok);
	assert.deepEqual(late.ids, ["late"], "调用者仍取得自己的结果");
	assert.deepEqual(JSON.parse(readFileSync(f.path, "utf8")).ids, ["current"]);
	assert.deepEqual(a.readCache()?.ids, ["current"]);
	assert.deepEqual(b.readCache()?.ids, ["current"]);
});

test("重导入共享后台恢复轮次，旧实例取消不结束仍有参与者的恢复", async t => {
	const f = await fixture(t);
	const a = await f.load("a");
	const caller = new AbortController();
	const first = a.catalog.recover(f.key, caller.signal);
	const rejected = assert.rejects(first, /取消/);
	await flush();
	const b = await f.load("b");
	const second = b.catalog.recover(f.key);
	caller.abort();
	await rejected;
	assert.equal(f.requests.length, 1);
	assert.equal(f.requests[0].signal?.aborted, false);
	f.models(0);
	assert.deepEqual((await second).snapshot?.ids, ["model-a"]);
});
