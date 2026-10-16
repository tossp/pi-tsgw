import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { UploadError } from "./errors.ts";
import { openLocalFile } from "./local-file.ts";
import { decodeReceipt, encodeReceipt, MAX_BYTES, SINGLE_LIMIT, UPLOAD_TOOL, URL_TOOL, type Receipt } from "./protocol.ts";
import { uploadLocalFile, type UploadDependencies, type UploadParams } from "./uploader.ts";

const expiresAt = "2099-01-01T00:00:00.000Z";
const uid = "01900000-0000-7000-8000-000000000001";
const partSize = 8 * 1024 ** 2;
const largeSize = SINGLE_LIMIT + 1;
const link = { key: "files/test.bin", url: "https://storage.example/test?signature=download", expiresAt, expiresIn: 86400 };
const raw = (body: unknown) => ({ structuredContent: body });
const missing = () => raw({ error: { code: "not-found" } });
const signal = () => new AbortController().signal;
function prepared(size: number, numbers?: number[]) {
	const multi = size > SINGLE_LIMIT;
	const totalParts = Math.ceil(size / partSize);
	const parts = numbers ?? (multi ? Array.from({ length: totalParts }, (_, i) => i + 1) : [1]);
	return { ...link, mode: multi ? "multipart" : "single", uploaded: parts.length === 0,
		...(multi ? { uid, partSize, totalParts, remainingParts: parts.length } : {}),
		uploads: parts.map(partNumber => ({ partNumber, offset: multi ? (partNumber - 1) * partSize : 0,
			size: multi ? Math.min(partSize, size - (partNumber - 1) * partSize) : size,
			url: `https://storage.example/part?signature=PUT_SECRET&part=${partNumber}`, method: "PUT",
			headers: { "x-test-secret": "HEADER_SECRET" }, expiresAt })) };
}
async function fixture(t: TestContext, size = 3, name = "sample.txt") {
	const cwd = await mkdtemp(join(tmpdir(), "tsgw-upload-test-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const path = join(cwd, name);
	const handle = await open(path, "w");
	try { await handle.truncate(size); if (size) await handle.write(Buffer.from("abc").subarray(0, size), 0, Math.min(3, size), 0); }
	finally { await handle.close(); }
	return { cwd, path, size };
}
async function receiptFor(f: { cwd: string; path: string }, phase: Receipt["phase"] = "upload") {
	const file = await openLocalFile(f.path, f.cwd);
	try { return encodeReceipt({ version: 1, key: link.key, mode: file.metadata.size > SINGLE_LIMIT ? "multipart" : "single",
		uid: file.metadata.size > SINGLE_LIMIT ? uid : undefined, phase, metadata: file.metadata, fingerprint: file.fingerprint }); }
	finally { await file.close(); }
}
const consume: NonNullable<UploadDependencies["put"]> = async (_target, data) => {
	if (data instanceof Uint8Array) return;
	for await (const chunk of data) assert.ok(chunk.byteLength > 0);
};
function run(f: { cwd: string; path: string }, deps: UploadDependencies, extra: Partial<UploadParams> = {}, abort = signal()) {
	return uploadLocalFile({ path: f.path, ...extra }, f.cwd, abort, deps);
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

test("单次 PUT 接收原始不可变快照，无需获取链接即可返回默认 URL", async t => {
	const f = await fixture(t);
	const calls: string[] = [];
	const result = await run(f, { call: async (tool, args) => {
		calls.push(tool); assert.equal(args.filename, "sample.txt"); assert.equal(args.contentType, "text/plain");
		assert.equal(args.size, 3); return raw(prepared(3));
	}, put: async (target, data) => {
		assert.equal(target.offset, 0); assert.equal(target.size, 3);
		assert.ok(data instanceof Uint8Array); assert.equal(Buffer.from(data).toString(), "abc");
	}, onProgress: () => { throw new Error("界面失败不影响上传"); } });
	assert.deepEqual(calls, [UPLOAD_TOOL]);
	assert.equal(result.uploaded, true); assert.equal(result.url, link.url); assert.equal(result.linkStatus, "ready");
});

test("仅在 PUT 后请求自定义 attachment 链接", async t => {
	const f = await fixture(t); const order: string[] = [];
	const result = await run(f, { call: async (tool, args) => {
		order.push(tool);
		if (tool === UPLOAD_TOOL) return raw(prepared(3));
		assert.deepEqual(args, { key: link.key, expiresIn: 300, disposition: "attachment" });
		return raw({ ...link, expiresIn: 300 });
	}, put: async (...args) => { order.push("put"); await consume(...args); } }, { expiresIn: 300, disposition: "attachment" });
	assert.deepEqual(order, [UPLOAD_TOOL, "put", URL_TOOL]); assert.equal(result.disposition, "attachment");
});

test("分片上传使用三个并发工作单元、正确偏移量及恰好一次完成调用", async t => {
	const f = await fixture(t, largeSize); let calls = 0; let running = 0; let peak = 0;
	const seen: number[] = [];
	const result = await run(f, { call: async tool => {
		assert.equal(tool, UPLOAD_TOOL); calls++; return raw(prepared(f.size, calls === 1 ? undefined : []));
	}, put: async (target, data) => {
		running++; peak = Math.max(peak, running); seen.push(target.partNumber);
		assert.equal(target.offset, (target.partNumber - 1) * partSize);
		assert.ok(!(data instanceof Uint8Array)); let length = 0;
		for await (const block of data) { if (target.partNumber === 1 && length === 0) assert.equal(Buffer.from(block).subarray(0, 3).toString(), "abc"); length += block.byteLength; }
		await delay(2); assert.equal(length, target.size); running--;
	} });
	assert.equal(result.uploaded, true); assert.equal(calls, 2); assert.equal(peak, 3);
	assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]); assert.equal(running, 0);
});

test("恢复分片上传先检查 key，且仅发送缺失分片", async t => {
	const f = await fixture(t, largeSize); const resume = await receiptFor(f); const calls: string[] = []; const parts: number[] = [];
	const result = await run(f, { call: async tool => {
		calls.push(tool); if (tool === URL_TOOL) return missing();
		return raw(prepared(f.size, calls.length === 2 ? [2, 5] : []));
	}, put: async (...args) => { parts.push(args[0].partNumber); await consume(...args); } }, { resume });
	assert.deepEqual(calls, [URL_TOOL, UPLOAD_TOOL, UPLOAD_TOOL]); assert.deepEqual(parts, [2, 5]); assert.equal(result.uploaded, true);
});

test("已上传的分片任务无需 PUT 或完成调用", async t => {
	const f = await fixture(t, largeSize); let calls = 0;
	const result = await run(f, { call: async () => { calls++; return raw(prepared(f.size, [])); }, put: async () => assert.fail("不得发送字节") });
	assert.equal(result.uploaded, true); assert.equal(calls, 1);
});

test("完成结果为 false 时返回未完成状态，绝不循环或重试缺失分片", async t => {
	const f = await fixture(t, largeSize); let calls = 0; let puts = 0;
	const result = await run(f, { call: async () => { calls++; return raw(prepared(f.size, [5])); },
		put: async (...args) => { puts++; await consume(...args); } });
	assert.equal(calls, 2); assert.equal(puts, 1); assert.equal(result.uploaded, false);
	assert.equal(result.uploadStatus, "incomplete"); assert.equal(result.error?.code, "incomplete-upload");
	assert.equal(decodeReceipt(result.resume!).phase, "upload");
});

test("分片失败后等待所有进行中的 PUT 结束再返回，且不调用完成", async t => {
	const f = await fixture(t, largeSize); let calls = 0; const started: number[] = []; const settled: number[] = [];
	const result = await run(f, { call: async () => { calls++; return raw(prepared(f.size)); }, put: async (target, _data, abort) => {
		started.push(target.partNumber);
		if (target.partNumber === 1) { await delay(2); settled.push(1); throw new Error("https://secret.example/?credential=SECRET"); }
		await delay(20); assert.equal(abort.aborted, true); settled.push(target.partNumber);
	} });
	assert.deepEqual(started, [1, 2, 3]); assert.deepEqual(settled.sort(), [1, 2, 3]); assert.equal(calls, 1);
	assert.equal(result.uploaded, null); assert.equal(result.uploadStatus, "unknown");
	const text = JSON.stringify(result); assert.doesNotMatch(text, /SECRET|secret\.example|PUT_SECRET|HEADER_SECRET/);
	assert.doesNotMatch(Buffer.from(result.resume!, "base64url").toString(), /https:|signature|headers/i);
});

test("元数据相同的并发调用返回忙碌状态", async t => {
	const f = await fixture(t); const entered = deferred<void>(); const release = deferred<unknown>();
	const first = run(f, { call: async () => { entered.resolve(); return release.promise; }, put: consume });
	await entered.promise;
	const second = await run(f, { call: async () => assert.fail("忙碌时不得调用 MCP"), put: consume });
	assert.equal(second.error?.code, "busy"); release.resolve(raw(prepared(3))); assert.equal((await first).uploaded, true);
});

for (const kind of ["cancelled", "timeout"] as const) test(`${kind === "cancelled" ? "取消" : "超时"}发生在完成阶段时结果未知；延迟的 MCP Promise 持续占锁`, async t => {
	const f = await fixture(t, largeSize); const controller = new AbortController();
	const entered = deferred<void>(); const late = deferred<unknown>(); let calls = 0;
	const pending = run(f, { remoteTimeoutMs: 100, call: async () => {
		calls++; if (calls === 1) return raw(prepared(f.size, [5])); entered.resolve(); return late.promise;
	}, put: consume }, {}, controller.signal);
	await entered.promise; if (kind === "cancelled") controller.abort();
	const result = await pending;
	assert.equal(result.error?.code, kind); assert.equal(result.uploaded, null); assert.equal(result.uploadStatus, "unknown"); assert.equal(calls, 2);
	const blocked = await run(f, { call: async () => assert.fail("锁仍被持有"), put: consume });
	assert.equal(blocked.error?.code, "busy");
	late.resolve(raw(prepared(f.size, []))); await delay(0);
	const recovered = await run(f, { call: async (tool, args) => {
		assert.equal(tool, URL_TOOL); assert.equal(args.key, link.key); return raw(link);
	}, open: async () => assert.fail("HEAD 成功后无需本地文件"), put: async () => assert.fail("不得重放上传") }, { resume: result.resume });
	assert.equal(recovered.uploaded, true); assert.equal(recovered.url, link.url);
});

test("单次 PUT 取消后结果未知，显式恢复绝不重放 PUT", async t => {
	const f = await fixture(t); const controller = new AbortController(); let puts = 0;
	const result = await run(f, { call: async () => raw(prepared(3)), put: async () => {
		puts++; controller.abort(); throw new UploadError("cancelled", "上传已取消。");
	} }, {}, controller.signal);
	assert.equal(result.uploaded, null); assert.equal(result.error?.code, "cancelled"); assert.equal(puts, 1);
	let calls = 0;
	const resumed = await run(f, { call: async tool => { calls++; assert.equal(tool, URL_TOOL); return missing(); },
		open: async () => assert.fail("单次上传恢复绝不打开文件"), put: async () => assert.fail("单次上传恢复绝不执行 PUT") }, { resume: result.resume });
	assert.equal(calls, 1); assert.equal(resumed.error?.code, "not-found");
});

test("链接失败时保留 uploaded 为 true、key、有效备用链接和安全凭条", async t => {
	const f = await fixture(t);
	const result = await run(f, { call: async tool => {
		if (tool === UPLOAD_TOOL) return raw(prepared(3)); throw new Error("credential=SECRET");
	}, put: consume }, { disposition: "attachment" });
	assert.equal(result.uploaded, true); assert.equal(result.key, link.key); assert.equal(result.linkStatus, "failed");
	assert.deepEqual(result.fallback, link); assert.equal(decodeReceipt(result.resume!).phase, "link");
	assert.doesNotMatch(JSON.stringify(result), /credential|SECRET/);
});

test("默认 URL 过期时在 PUT 成功后重新获取链接", async t => {
	const f = await fixture(t); const calls: string[] = [];
	const result = await run(f, { call: async tool => { calls.push(tool);
		return raw(tool === UPLOAD_TOOL ? { ...prepared(3), expiresAt: "2000-01-01T00:00:00Z" } : link);
	}, put: consume });
	assert.deepEqual(calls, [UPLOAD_TOOL, URL_TOOL]); assert.equal(result.url, link.url);
});

test("文件或元数据更改后，在 not-found 之后、准备之前拒绝分片恢复", async t => {
	for (const changed of ["file", "metadata"] as const) {
		const f = await fixture(t, largeSize); const resume = await receiptFor(f); let calls = 0;
		if (changed === "file") { const h = await open(f.path, "r+"); try { await h.write(Buffer.from("z"), 0, 1, 0); } finally { await h.close(); } }
		const result = await run(f, { call: async tool => { calls++; assert.equal(tool, URL_TOOL); return missing(); }, put: async () => assert.fail("文件已更改，不得上传") },
			{ resume, ...(changed === "metadata" ? { contentType: "application/json" } : {}) });
		assert.equal(result.error?.code, "file-changed"); assert.equal(calls, 1);
	}
});

test("恢复遇到 not-found 时仅允许匹配的分片身份，不向新 key 发送字节", async t => {
	for (const patch of [{ key: "different/key" }, { uid: "01900000-0000-7000-8000-000000000002" }]) {
		const f = await fixture(t, largeSize); const resume = await receiptFor(f); const calls: string[] = [];
		const result = await run(f, { call: async tool => { calls.push(tool); return tool === URL_TOOL ? missing() : raw({ ...prepared(f.size), ...patch }); },
			put: async () => assert.fail("身份不匹配") }, { resume });
		assert.deepEqual(calls, [URL_TOOL, UPLOAD_TOOL]); assert.equal(result.error?.code, "key" in patch ? "session-changed" : "invalid-response");
	}
});

test("恢复遇到普通 HEAD 错误或已完成凭条的 not-found 时不执行准备", async t => {
	const f = await fixture(t, largeSize);
	for (const phase of ["upload", "link"] as const) {
		const resume = await receiptFor(f, phase); let calls = 0;
		const result = await run(f, { call: async tool => { calls++; assert.equal(tool, URL_TOOL);
			return phase === "link" ? missing() : raw({ error: { code: "access-denied" } });
		}, put: async () => assert.fail("不得重放上传") }, { resume });
		assert.equal(calls, 1); assert.equal(result.error?.code, phase === "link" ? "not-found" : "mcp-error");
	}
});

test("准备期间文件更改后不得发送过时快照", async t => {
	const f = await fixture(t); let calls = 0;
	const result = await run(f, { call: async () => { calls++; await writeFile(f.path, "changed"); return raw(prepared(3)); },
		put: async () => assert.fail("不得发送已更改的源文件") });
	assert.equal(result.error?.code, "file-changed"); assert.equal(calls, 1);
});

test("畸形准备结果绝不发送字节", async t => {
	const f = await fixture(t);
	for (const patch of [{ mode: "multipart" }, { uploads: [] }, { uploads: [{ ...prepared(3).uploads[0], offset: 1 }] }]) {
		const result = await run(f, { call: async () => raw({ ...prepared(3), ...patch }), put: async () => assert.fail("无效计划不得上传") });
		assert.equal(result.error?.code, "invalid-response");
	}
});

test("本地失败和无效选项绝不调用 MCP", async t => {
	const f = await fixture(t, 0); const huge = await fixture(t, MAX_BYTES + 1);
	const deps: UploadDependencies = { call: async () => assert.fail("网络访问前必须完成本地校验"), put: consume };
	for (const [path, code] of [[f.path, "invalid-size"], [huge.path, "invalid-size"], [f.cwd, "not-file"], [join(f.cwd, "missing"), "file-unavailable"]]) {
		assert.equal((await run(f, deps, { path })).error?.code, code);
	}
	for (const expiresIn of [0, 604801, 1.5, NaN]) assert.equal((await run(f, deps, { expiresIn })).error?.code, "invalid-options");
	assert.equal((await run(f, deps, { resume: "invalid!" })).error?.code, "invalid-resume");
});

test("显式空恢复凭条在打开文件或联系 MCP 前被拒绝", async t => {
	const f = await fixture(t);
	const result = await run(f, { call: async () => assert.fail("不得远程调用"),
		open: async () => assert.fail("不得打开本地文件"), put: async () => assert.fail("不得执行 PUT") }, { resume: "" });
	assert.equal(result.error?.code, "invalid-resume"); assert.equal(result.uploaded, false);
});

test("有效凭条在取消或选项无效时保留 key 和已知状态", async t => {
	const f = await fixture(t, largeSize);
	for (const phase of ["upload", "complete", "link"] as const) {
		const resume = await receiptFor(f, phase);
		for (const reason of ["cancelled", "invalid-options"] as const) {
			const controller = new AbortController(); if (reason === "cancelled") controller.abort();
			const result = await run(f, { call: async () => assert.fail("不得远程调用"),
				open: async () => assert.fail("不得打开本地文件"), put: async () => assert.fail("不得执行 PUT") },
				{ resume, ...(reason === "invalid-options" ? { expiresIn: 0 } : {}) }, controller.signal);
			assert.equal(result.error?.code, reason); assert.equal(result.key, link.key); assert.equal(result.uid, uid);
			assert.equal(result.uploaded, phase === "link" ? true : null);
			assert.equal(result.uploadStatus, phase === "link" ? "uploaded" : "unknown");
			assert.deepEqual(decodeReceipt(result.resume!), decodeReceipt(resume));
		}
	}
});

test("畸形准备链接保留已校验 key 和服务端上传状态", async t => {
	for (const uploaded of [false, true]) {
		const f = await fixture(t, largeSize); let calls = 0;
		const result = await run(f, { call: async () => { calls++; return raw({ ...prepared(f.size, uploaded ? [] : [5]), url: "http://invalid.example/SECRET" }); },
			put: async () => assert.fail("畸形链接不能授权 PUT") });
		assert.equal(calls, 1); assert.equal(result.error?.code, "invalid-response"); assert.equal(result.key, link.key);
		assert.equal(result.uploaded, uploaded ? true : null); assert.equal(result.uploadStatus, uploaded ? "uploaded" : "unknown");
		assert.equal(decodeReceipt(result.resume!).phase, uploaded ? "link" : "upload");
		assert.doesNotMatch(JSON.stringify(result), /SECRET/);
	}
});

test("完成结果包含无效链接时保留 uploaded 为 true 和恢复凭条", async t => {
	const f = await fixture(t, largeSize); let calls = 0; let puts = 0;
	const result = await run(f, { call: async () => {
		calls++; return raw(calls === 1 ? prepared(f.size, [5]) : { ...prepared(f.size, []), expiresAt: "invalid" });
	}, put: async (...args) => { puts++; await consume(...args); } });
	assert.equal(calls, 2); assert.equal(puts, 1); assert.equal(result.error?.code, "invalid-response");
	assert.equal(result.uploaded, true); assert.equal(result.uploadStatus, "uploaded"); assert.equal(result.linkStatus, "failed");
	assert.equal(result.key, link.key); assert.equal(decodeReceipt(result.resume!).phase, "link"); assert.deepEqual(result.fallback, link);
});

test("已上传计划忽略准备期间发生的源文件变化", async t => {
	const f = await fixture(t, largeSize); let calls = 0;
	const result = await run(f, { call: async () => { calls++; await writeFile(f.path, "changed"); return raw(prepared(f.size, [])); },
		put: async () => assert.fail("已上传，不得再次上传") });
	assert.equal(calls, 1); assert.equal(result.uploaded, true); assert.equal(result.url, link.url); assert.equal(result.error, undefined);
});

test("获取到过期链接时仅失败一次，并保留上传状态和有效备用链接", async t => {
	const f = await fixture(t); const calls: string[] = [];
	const result = await run(f, { call: async tool => {
		calls.push(tool); return raw(tool === UPLOAD_TOOL ? prepared(3) : { ...link, expiresAt: "2000-01-01T00:00:00Z" });
	}, put: consume }, { disposition: "attachment" });
	assert.deepEqual(calls, [UPLOAD_TOOL, URL_TOOL]); assert.equal(result.error?.code, "expired-link");
	assert.equal(result.uploaded, true); assert.equal(result.linkStatus, "failed"); assert.equal(result.url, undefined);
	assert.deepEqual(result.fallback, link); assert.equal(decodeReceipt(result.resume!).phase, "link");
	const resumedCalls: string[] = [];
	const resumed = await run(f, { call: async tool => { resumedCalls.push(tool); return raw({ ...link, expiresAt: "2000-01-01T00:00:00Z" }); },
		open: async () => assert.fail("链接过期不等于 not-found"), put: async () => assert.fail("不得重放上传") }, { resume: result.resume });
	assert.deepEqual(resumedCalls, [URL_TOOL]); assert.equal(resumed.error?.code, "expired-link");
	assert.equal(resumed.uploaded, true); assert.equal(resumed.key, link.key); assert.equal(resumed.url, undefined);
});

test("本地 MIME 推断、覆盖、回退、快照及文件变化检测", async t => {
	for (const [name, override, expected] of [["image.PNG", undefined, "image/png"], ["data.unknown", undefined, "application/octet-stream"],
		["sample.txt", "APPLICATION/JSON", "application/json"]] as const) {
		const f = await fixture(t, 3, name); const file = await openLocalFile(name, f.cwd, override);
		try { assert.equal(file.metadata.contentType, expected); assert.equal(Buffer.from(await file.snapshot(signal())).toString(), "abc");
			await writeFile(f.path, "changed"); await assert.rejects(file.assertUnchanged(), (e: unknown) => e instanceof UploadError && e.code === "file-changed");
		} finally { await file.close(); }
	}
	const f = await fixture(t);
	for (const mime of ["text/plain; charset=utf-8", "bad", "text/\r\nsecret"]) {
		await assert.rejects(openLocalFile(f.path, f.cwd, mime), (e: unknown) => e instanceof UploadError && e.code === "invalid-content-type");
	}
});
