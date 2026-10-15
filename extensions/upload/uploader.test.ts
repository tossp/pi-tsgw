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

test("single PUT receives raw immutable snapshot and default URL without get", async t => {
	const f = await fixture(t);
	const calls: string[] = [];
	const result = await run(f, { call: async (tool, args) => {
		calls.push(tool); assert.equal(args.filename, "sample.txt"); assert.equal(args.contentType, "text/plain");
		assert.equal(args.size, 3); return raw(prepared(3));
	}, put: async (target, data) => {
		assert.equal(target.offset, 0); assert.equal(target.size, 3);
		assert.ok(data instanceof Uint8Array); assert.equal(Buffer.from(data).toString(), "abc");
	}, onProgress: () => { throw new Error("UI failure is harmless"); } });
	assert.deepEqual(calls, [UPLOAD_TOOL]);
	assert.equal(result.uploaded, true); assert.equal(result.url, link.url); assert.equal(result.linkStatus, "ready");
});

test("custom attachment link is requested only after PUT", async t => {
	const f = await fixture(t); const order: string[] = [];
	const result = await run(f, { call: async (tool, args) => {
		order.push(tool);
		if (tool === UPLOAD_TOOL) return raw(prepared(3));
		assert.deepEqual(args, { key: link.key, expiresIn: 300, disposition: "attachment" });
		return raw({ ...link, expiresIn: 300 });
	}, put: async (...args) => { order.push("put"); await consume(...args); } }, { expiresIn: 300, disposition: "attachment" });
	assert.deepEqual(order, [UPLOAD_TOOL, "put", URL_TOOL]); assert.equal(result.disposition, "attachment");
});

test("multipart uses three workers, correct offsets and exactly one completion", async t => {
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

test("resumed multipart checks key first and sends only missing parts", async t => {
	const f = await fixture(t, largeSize); const resume = await receiptFor(f); const calls: string[] = []; const parts: number[] = [];
	const result = await run(f, { call: async tool => {
		calls.push(tool); if (tool === URL_TOOL) return missing();
		return raw(prepared(f.size, calls.length === 2 ? [2, 5] : []));
	}, put: async (...args) => { parts.push(args[0].partNumber); await consume(...args); } }, { resume });
	assert.deepEqual(calls, [URL_TOOL, UPLOAD_TOOL, UPLOAD_TOOL]); assert.deepEqual(parts, [2, 5]); assert.equal(result.uploaded, true);
});

test("already uploaded multipart needs no PUT or completion", async t => {
	const f = await fixture(t, largeSize); let calls = 0;
	const result = await run(f, { call: async () => { calls++; return raw(prepared(f.size, [])); }, put: async () => assert.fail("no bytes") });
	assert.equal(result.uploaded, true); assert.equal(calls, 1);
});

test("completion false returns incomplete, never loops or retries missing parts", async t => {
	const f = await fixture(t, largeSize); let calls = 0; let puts = 0;
	const result = await run(f, { call: async () => { calls++; return raw(prepared(f.size, [5])); },
		put: async (...args) => { puts++; await consume(...args); } });
	assert.equal(calls, 2); assert.equal(puts, 1); assert.equal(result.uploaded, false);
	assert.equal(result.uploadStatus, "incomplete"); assert.equal(result.error?.code, "incomplete-upload");
	assert.equal(decodeReceipt(result.resume!).phase, "upload");
});

test("part failure drains every in-flight PUT before returning, no completion", async t => {
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

test("concurrent calls with identical metadata are busy", async t => {
	const f = await fixture(t); const entered = deferred<void>(); const release = deferred<unknown>();
	const first = run(f, { call: async () => { entered.resolve(); return release.promise; }, put: consume });
	await entered.promise;
	const second = await run(f, { call: async () => assert.fail("busy cannot call MCP"), put: consume });
	assert.equal(second.error?.code, "busy"); release.resolve(raw(prepared(3))); assert.equal((await first).uploaded, true);
});

for (const kind of ["cancelled", "timeout"] as const) test(`${kind} during completion is unknown; late MCP promise retains lock`, async t => {
	const f = await fixture(t, largeSize); const controller = new AbortController();
	const entered = deferred<void>(); const late = deferred<unknown>(); let calls = 0;
	const pending = run(f, { remoteTimeoutMs: 100, call: async () => {
		calls++; if (calls === 1) return raw(prepared(f.size, [5])); entered.resolve(); return late.promise;
	}, put: consume }, {}, controller.signal);
	await entered.promise; if (kind === "cancelled") controller.abort();
	const result = await pending;
	assert.equal(result.error?.code, kind); assert.equal(result.uploaded, null); assert.equal(result.uploadStatus, "unknown"); assert.equal(calls, 2);
	const blocked = await run(f, { call: async () => assert.fail("lock held"), put: consume });
	assert.equal(blocked.error?.code, "busy");
	late.resolve(raw(prepared(f.size, []))); await delay(0);
	const recovered = await run(f, { call: async (tool, args) => {
		assert.equal(tool, URL_TOOL); assert.equal(args.key, link.key); return raw(link);
	}, open: async () => assert.fail("HEAD success needs no local file"), put: async () => assert.fail("no replay") }, { resume: result.resume });
	assert.equal(recovered.uploaded, true); assert.equal(recovered.url, link.url);
});

test("single PUT cancellation leaves unknown and explicit resume never replays PUT", async t => {
	const f = await fixture(t); const controller = new AbortController(); let puts = 0;
	const result = await run(f, { call: async () => raw(prepared(3)), put: async () => {
		puts++; controller.abort(); throw new UploadError("cancelled", "Upload cancelled.");
	} }, {}, controller.signal);
	assert.equal(result.uploaded, null); assert.equal(result.error?.code, "cancelled"); assert.equal(puts, 1);
	let calls = 0;
	const resumed = await run(f, { call: async tool => { calls++; assert.equal(tool, URL_TOOL); return missing(); },
		open: async () => assert.fail("single resume never opens"), put: async () => assert.fail("single resume never PUTs") }, { resume: result.resume });
	assert.equal(calls, 1); assert.equal(resumed.error?.code, "not-found");
});

test("link failure preserves uploaded true, key, valid fallback and safe receipt", async t => {
	const f = await fixture(t);
	const result = await run(f, { call: async tool => {
		if (tool === UPLOAD_TOOL) return raw(prepared(3)); throw new Error("credential=SECRET");
	}, put: consume }, { disposition: "attachment" });
	assert.equal(result.uploaded, true); assert.equal(result.key, link.key); assert.equal(result.linkStatus, "failed");
	assert.deepEqual(result.fallback, link); assert.equal(decodeReceipt(result.resume!).phase, "link");
	assert.doesNotMatch(JSON.stringify(result), /credential|SECRET/);
});

test("expired default URL forces fresh get after successful PUT", async t => {
	const f = await fixture(t); const calls: string[] = [];
	const result = await run(f, { call: async tool => { calls.push(tool);
		return raw(tool === UPLOAD_TOOL ? { ...prepared(3), expiresAt: "2000-01-01T00:00:00Z" } : link);
	}, put: consume });
	assert.deepEqual(calls, [UPLOAD_TOOL, URL_TOOL]); assert.equal(result.url, link.url);
});

test("changed file or metadata rejects multipart resume after not-found, before prepare", async t => {
	for (const changed of ["file", "metadata"] as const) {
		const f = await fixture(t, largeSize); const resume = await receiptFor(f); let calls = 0;
		if (changed === "file") { const h = await open(f.path, "r+"); try { await h.write(Buffer.from("z"), 0, 1, 0); } finally { await h.close(); } }
		const result = await run(f, { call: async tool => { calls++; assert.equal(tool, URL_TOOL); return missing(); }, put: async () => assert.fail("changed file") },
			{ resume, ...(changed === "metadata" ? { contentType: "application/json" } : {}) });
		assert.equal(result.error?.code, "file-changed"); assert.equal(calls, 1);
	}
});

test("resume not-found permits only matching multipart identity; new key sends no bytes", async t => {
	for (const patch of [{ key: "different/key" }, { uid: "01900000-0000-7000-8000-000000000002" }]) {
		const f = await fixture(t, largeSize); const resume = await receiptFor(f); const calls: string[] = [];
		const result = await run(f, { call: async tool => { calls.push(tool); return tool === URL_TOOL ? missing() : raw({ ...prepared(f.size), ...patch }); },
			put: async () => assert.fail("identity mismatch") }, { resume });
		assert.deepEqual(calls, [URL_TOOL, UPLOAD_TOOL]); assert.equal(result.error?.code, "key" in patch ? "session-changed" : "invalid-response");
	}
});

test("resume does not prepare on generic HEAD errors or completed receipt not-found", async t => {
	const f = await fixture(t, largeSize);
	for (const phase of ["upload", "link"] as const) {
		const resume = await receiptFor(f, phase); let calls = 0;
		const result = await run(f, { call: async tool => { calls++; assert.equal(tool, URL_TOOL);
			return phase === "link" ? missing() : raw({ error: { code: "access-denied" } });
		}, put: async () => assert.fail("no replay") }, { resume });
		assert.equal(calls, 1); assert.equal(result.error?.code, phase === "link" ? "not-found" : "mcp-error");
	}
});

test("file changed while preparing cannot send a stale snapshot", async t => {
	const f = await fixture(t); let calls = 0;
	const result = await run(f, { call: async () => { calls++; await writeFile(f.path, "changed"); return raw(prepared(3)); },
		put: async () => assert.fail("changed source must not be sent") });
	assert.equal(result.error?.code, "file-changed"); assert.equal(calls, 1);
});

test("malformed prepare never sends bytes", async t => {
	const f = await fixture(t);
	for (const patch of [{ mode: "multipart" }, { uploads: [] }, { uploads: [{ ...prepared(3).uploads[0], offset: 1 }] }]) {
		const result = await run(f, { call: async () => raw({ ...prepared(3), ...patch }), put: async () => assert.fail("invalid plan") });
		assert.equal(result.error?.code, "invalid-response");
	}
});

test("local failures and invalid options never call MCP", async t => {
	const f = await fixture(t, 0); const huge = await fixture(t, MAX_BYTES + 1);
	const deps: UploadDependencies = { call: async () => assert.fail("local validation before network"), put: consume };
	for (const [path, code] of [[f.path, "invalid-size"], [huge.path, "invalid-size"], [f.cwd, "not-file"], [join(f.cwd, "missing"), "file-unavailable"]]) {
		assert.equal((await run(f, deps, { path })).error?.code, code);
	}
	for (const expiresIn of [0, 604801, 1.5, NaN]) assert.equal((await run(f, deps, { expiresIn })).error?.code, "invalid-options");
	assert.equal((await run(f, deps, { resume: "invalid!" })).error?.code, "invalid-resume");
});

test("empty explicit resume rejects before opening a file or contacting MCP", async t => {
	const f = await fixture(t);
	const result = await run(f, { call: async () => assert.fail("no remote call"),
		open: async () => assert.fail("no local open"), put: async () => assert.fail("no PUT") }, { resume: "" });
	assert.equal(result.error?.code, "invalid-resume"); assert.equal(result.uploaded, false);
});

test("valid receipt preserves key and known status before cancellation or invalid options", async t => {
	const f = await fixture(t, largeSize);
	for (const phase of ["upload", "complete", "link"] as const) {
		const resume = await receiptFor(f, phase);
		for (const reason of ["cancelled", "invalid-options"] as const) {
			const controller = new AbortController(); if (reason === "cancelled") controller.abort();
			const result = await run(f, { call: async () => assert.fail("no remote call"),
				open: async () => assert.fail("no local open"), put: async () => assert.fail("no PUT") },
				{ resume, ...(reason === "invalid-options" ? { expiresIn: 0 } : {}) }, controller.signal);
			assert.equal(result.error?.code, reason); assert.equal(result.key, link.key); assert.equal(result.uid, uid);
			assert.equal(result.uploaded, phase === "link" ? true : null);
			assert.equal(result.uploadStatus, phase === "link" ? "uploaded" : "unknown");
			assert.deepEqual(decodeReceipt(result.resume!), decodeReceipt(resume));
		}
	}
});

test("malformed prepare link keeps validated key and server uploaded status", async t => {
	for (const uploaded of [false, true]) {
		const f = await fixture(t, largeSize); let calls = 0;
		const result = await run(f, { call: async () => { calls++; return raw({ ...prepared(f.size, uploaded ? [] : [5]), url: "http://invalid.example/SECRET" }); },
			put: async () => assert.fail("malformed link cannot authorize PUT") });
		assert.equal(calls, 1); assert.equal(result.error?.code, "invalid-response"); assert.equal(result.key, link.key);
		assert.equal(result.uploaded, uploaded ? true : null); assert.equal(result.uploadStatus, uploaded ? "uploaded" : "unknown");
		assert.equal(decodeReceipt(result.resume!).phase, uploaded ? "link" : "upload");
		assert.doesNotMatch(JSON.stringify(result), /SECRET/);
	}
});

test("completion with invalid link preserves uploaded true and recovery receipt", async t => {
	const f = await fixture(t, largeSize); let calls = 0; let puts = 0;
	const result = await run(f, { call: async () => {
		calls++; return raw(calls === 1 ? prepared(f.size, [5]) : { ...prepared(f.size, []), expiresAt: "invalid" });
	}, put: async (...args) => { puts++; await consume(...args); } });
	assert.equal(calls, 2); assert.equal(puts, 1); assert.equal(result.error?.code, "invalid-response");
	assert.equal(result.uploaded, true); assert.equal(result.uploadStatus, "uploaded"); assert.equal(result.linkStatus, "failed");
	assert.equal(result.key, link.key); assert.equal(decodeReceipt(result.resume!).phase, "link"); assert.deepEqual(result.fallback, link);
});

test("already uploaded plan ignores source changes occurring during prepare", async t => {
	const f = await fixture(t, largeSize); let calls = 0;
	const result = await run(f, { call: async () => { calls++; await writeFile(f.path, "changed"); return raw(prepared(f.size, [])); },
		put: async () => assert.fail("already uploaded") });
	assert.equal(calls, 1); assert.equal(result.uploaded, true); assert.equal(result.url, link.url); assert.equal(result.error, undefined);
});

test("expired get link fails once, retaining uploaded status and valid fallback", async t => {
	const f = await fixture(t); const calls: string[] = [];
	const result = await run(f, { call: async tool => {
		calls.push(tool); return raw(tool === UPLOAD_TOOL ? prepared(3) : { ...link, expiresAt: "2000-01-01T00:00:00Z" });
	}, put: consume }, { disposition: "attachment" });
	assert.deepEqual(calls, [UPLOAD_TOOL, URL_TOOL]); assert.equal(result.error?.code, "expired-link");
	assert.equal(result.uploaded, true); assert.equal(result.linkStatus, "failed"); assert.equal(result.url, undefined);
	assert.deepEqual(result.fallback, link); assert.equal(decodeReceipt(result.resume!).phase, "link");
	const resumedCalls: string[] = [];
	const resumed = await run(f, { call: async tool => { resumedCalls.push(tool); return raw({ ...link, expiresAt: "2000-01-01T00:00:00Z" }); },
		open: async () => assert.fail("expired link is not not-found"), put: async () => assert.fail("no replay") }, { resume: result.resume });
	assert.deepEqual(resumedCalls, [URL_TOOL]); assert.equal(resumed.error?.code, "expired-link");
	assert.equal(resumed.uploaded, true); assert.equal(resumed.key, link.key); assert.equal(resumed.url, undefined);
});

test("local MIME inference, override, fallback, snapshot and changed-file detection", async t => {
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
