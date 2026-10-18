import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakePi } from "#tsgw/test-support.test";
import { DEFAULT_GATEWAY_MODEL_CACHE_TTL_MS as TTL } from "#tsgw/models/gateway-catalog";
import { registerRefreshTool } from "./refresh-tool.ts";

const dir = mkdtempSync(join(tmpdir(), "refresh-tool-"));
const cache = join(dir, "models.json");
const secret = "secret-sentinel";
const ids = ["gpt-6-luna", "unknown-model"];
type Options = { providers: string[]; force: boolean; signal?: AbortSignal };
type Tool = { name: string; exposure: string; execute: (...args: any[]) => Promise<any> };
function writeCache(storedAt = Date.now()) {
	writeFileSync(cache, JSON.stringify({ scope: secret, storedAt, ids }));
}
function fixture(refresh: (options: Options) => unknown = async () => { writeCache(); }, configured = true) {
	const pi = new FakePi();
	registerRefreshTool(pi, cache);
	let calls = 0;
	let options: Options | undefined;
	const ctx = { signal: undefined as AbortSignal | undefined, modelRegistry: {
		getProviderAuthStatus: () => ({ configured }),
		refresh: async (input: Options) => { calls++; options = input; return refresh(input); },
	} };
	return { tool: pi.tools[0] as Tool, ctx, calls: () => calls, options: () => options };
}
function invoke(f: ReturnType<typeof fixture>, force = false, signal?: AbortSignal) {
	return f.tool.execute("call", { force }, signal, undefined, f.ctx);
}
try {
	const fresh = fixture();
	equal(fresh.tool.name, "tsgw_refresh_models");
	equal(fresh.tool.exposure, "codemode");
	const recentAt = Date.now() - 23 * 60 * 60 * 1000;
	writeCache(recentAt);
	const cached = await invoke(fresh);
	equal(fresh.calls(), 0);
	equal(cached.details.storedAt, recentAt);
	equal(JSON.parse(readFileSync(cache, "utf8")).storedAt, recentAt);
	deepStrictEqual(cached.details, { cacheFilePath: cache, count: 2, storedAt: recentAt });
	equal(JSON.stringify(cached).includes(secret), false);
	deepStrictEqual(cached.structuredContent, cached.details);

	const controller = new AbortController();
	const forced = await invoke(fresh, true, controller.signal);
	equal(fresh.calls(), 1);
	deepStrictEqual(fresh.options(), { providers: ["tsgw"], force: true, signal: controller.signal });
	equal(forced.details.count, ids.length);

	writeCache(Date.now() - TTL - 1000);
	const expired = fixture();
	await invoke(expired);
	equal(expired.calls(), 1, "24 小时过期触发一次强制联网，不采用启动七天窗口");
	rmSync(cache);
	const missing = fixture();
	await invoke(missing);
	equal(missing.calls(), 1);

	const noAuth = fixture(async () => {}, false);
	await rejects(invoke(noAuth), /刷新失败/);
	equal(noAuth.calls(), 0);
	for (const refresh of [
		async () => { throw new Error(secret); },
		async () => ({ errors: new Map([["tsgw", new Error(secret)]]) }),
	]) {
		const failed = fixture(refresh);
		await rejects(invoke(failed, true), (error: Error) => {
			match(error.message, /刷新失败/);
			equal(error.message.includes(secret), false);
			return true;
		});
		equal(failed.calls(), 1);
	}
	for (const invalid of [
		() => writeCache(Date.now() - TTL - 1000),
		() => rmSync(cache, { force: true }),
		() => writeFileSync(cache, "invalid-json"),
		() => writeFileSync(cache, JSON.stringify({ storedAt: Date.now(), ids: [" "] })),
	]) {
		invalid();
		const failedWrite = fixture(async () => {});
		await rejects(invoke(failedWrite), /未确认/);
		equal(failedWrite.calls(), 1);
	}
	rmSync(cache, { force: true });
	mkdirSync(cache);
	const blocked = fixture(async () => {});
	await rejects(invoke(blocked), /未确认/);
	rmSync(cache, { recursive: true });

	const aborted = new AbortController();
	aborted.abort();
	const cancelled = fixture();
	await rejects(invoke(cancelled, false, aborted.signal), /已取消/);
	equal(cancelled.calls(), 0);
	const host = new AbortController();
	const combined = fixture(async ({ signal }) => { host.abort(); equal(signal?.aborted, true); });
	combined.ctx.signal = host.signal;
	await rejects(invoke(combined, true, new AbortController().signal), /已取消/);
	const reported = fixture(async () => ({ aborted: true }));
	await rejects(invoke(reported, true), /已取消/);

	// 旧宿主 refresh() 返回 void，由本次文件写入确认结果。
	const legacy = fixture(async () => { writeCache(); return undefined; });
	equal((await invoke(legacy, true)).details.count, 2);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log("refresh-tool.test.ts：全部断言通过");
