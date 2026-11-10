import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { withDavAccount, supportsDavNode } from "./client.ts";
import { DavToolError, type DavReadContext } from "./types.ts";

const account = { url: "https://dav.example.invalid/", user: "synthetic-user", password: "synthetic-password" };
const calendar = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>合成日历</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

test("真实本地 HTTP：标准入口发现只跟随同源跳转，GET/REPORT 不跟随跳转", async () => {
	const seen: { method: string; path: string; auth?: string }[] = [];
	const server = createServer((req, res) => {
		seen.push({ method: req.method!, path: req.url!, auth: req.headers.authorization });
		req.resume();
		if (req.url === "/.well-known/caldav") { res.writeHead(302, { location: "/cal/" }); res.end(); }
		else if (req.url === "/cal/" && req.method === "PROPFIND") { res.writeHead(207, { "content-type": "application/xml" }); res.end(calendar.replace("/cal/</d:href>", "./items/</d:href>")); }
		else { res.writeHead(302, { location: "/cal/" }); res.end(); }
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	try {
		const config = { ...account, url: base };
		const collections = await withDavAccount(config, undefined, c => c.client.discover("calendar"), { discoveryKind: "calendar" });
		assert.equal(collections.length, 1);
		assert.equal(collections[0]!.url, `${base}cal/items/`);
		assert.deepEqual(seen.map(r => r.path), ["/.well-known/caldav", "/cal/"]);
		assert.ok(seen.every(r => r.method === "PROPFIND" && r.auth === `Basic ${Buffer.from(`${account.user}:${account.password}`).toString("base64")}`));
		for (const handler of [(c: DavReadContext) => c.client.get(`${base}redirect`),
			(c: DavReadContext) => c.client.query(`${base}redirect`, "calendar")]) {
			const before = seen.length;
			await assert.rejects(withDavAccount<unknown>(config, undefined, handler), (error: unknown) => error instanceof DavToolError && error.code === "DAV_FAILED");
			assert.equal(seen.length, before + 1);
		}
	} finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("发现拒绝跨源及过多跳转，明确路径不被标准入口覆盖", async () => {
	for (const location of ["https://other.example.invalid/private", "https://user:password@dav.example.invalid/cal/", "/loop"]) {
		const urls: string[] = [];
		await assert.rejects(withDavAccount(account, undefined, c => c.client.discover("calendar"), {
			discoveryKind: "calendar", fetch: async url => { urls.push(String(url)); return new Response(null, { status: 302, headers: { location } }); },
		}), DavToolError);
		assert.ok(urls.every(url => new URL(url).origin === new URL(account.url).origin));
		assert.equal(urls.length, location === "/loop" ? 4 : 1);
	}
	let seen = "";
	await withDavAccount({ ...account, url: `${account.url}explicit/` }, undefined, c => c.client.discover("calendar"), {
		discoveryKind: "calendar", fetch: async url => { seen = String(url); return new Response(calendar, { status: 207 }); },
	});
	assert.equal(seen, `${account.url}explicit/`);
});

test("HTTP 认证错误与伪成功网页不泄露响应正文，也不自动重试", async () => {
	for (const [status, code] of [[401, "DAV_AUTH_FAILED"], [403, "DAV_AUTH_FAILED"], [404, "NOT_FOUND"], [200, "DAV_FAILED"], [207, "DAV_PROTOCOL"]] as const) {
		let calls = 0;
		await assert.rejects(withDavAccount(account, undefined, c => c.client.discover("calendar"), {
			discoveryKind: "calendar", fetch: async () => { calls++; return new Response("sensitive-upstream-password", { status }); },
		}), error => {
			assert.ok(error instanceof DavToolError);
			assert.equal(error.code, code);
			assert.doesNotMatch(error.message, /sensitive|synthetic|example/);
			return true;
		});
		assert.equal(calls, 1);
	}
});

test("取消信号按调用隔离，取消不会干扰并行读取，预取消不发请求", async () => {
	const a = new AbortController();
	const b = new AbortController();
	const signals: AbortSignal[] = [];
	let started!: () => void;
	const ready = new Promise<void>(resolve => { started = resolve; });
	const pending = withDavAccount(account, a.signal, c => c.client.discover("calendar"), {
		discoveryKind: "calendar", fetch: async (_url, init) => {
			signals.push(init!.signal!); started();
			return new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("private-reason")), { once: true }));
		},
	});
	await ready;
	const good = withDavAccount(account, b.signal, c => c.client.discover("calendar"), {
		discoveryKind: "calendar", fetch: async (_url, init) => { signals.push(init!.signal!); return new Response(calendar, { status: 207 }); },
	});
	a.abort();
	await assert.rejects(pending, error => error instanceof DavToolError && error.code === "ABORTED");
	assert.equal((await good).length, 1);
	assert.equal(signals[1]!.aborted, false);
	let calls = 0;
	await assert.rejects(withDavAccount(account, a.signal, async () => { calls++; return null; }));
	assert.equal(calls, 0);
	assert.equal(supportsDavNode("22.19.0"), false);
	assert.equal(supportsDavNode("24.0.0"), true);
});
