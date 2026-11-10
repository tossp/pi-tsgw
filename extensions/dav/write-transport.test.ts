import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { withDavAccount } from "./client.ts";
import { DavToolError } from "./types.ts";

const account = { url: "https://dav.example.invalid/", user: "fixture", password: "synthetic-secret" };
const resourceUrl = `${account.url}cal/fixture.ics`;

test("本地 HTTP：已接收 PUT 后断连，报告远端结果未确认及目标地址，不重发", async () => {
	let writes = 0;
	const server = createServer((request) => {
		assert.equal(request.method, "PUT");
		assert.equal(request.headers["if-none-match"], "*");
		request.resume();
		request.on("end", () => { writes++; request.socket.destroy(); });
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cal/fixture.ics`;
	try {
		await assert.rejects(withDavAccount({ ...account, url }, undefined,
			context => context.client.create(url, "synthetic-content", "text/calendar")), error => {
			assert.ok(error instanceof DavToolError);
			assert.equal(error.code, "REMOTE_RESULT_UNKNOWN");
			assert.deepEqual(error.details, { method: "PUT", resourceUrl: url });
			assert.doesNotMatch(error.message, /synthetic|secret|content/);
			return true;
		});
		assert.equal(writes, 1);
	} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("PUT/DELETE 已确认成功，清理失败或随后取消不能改写成功结果", async () => {
	for (const method of ["PUT", "DELETE"] as const) {
		const controller = new AbortController();
		let requests = 0;
		const result = await withDavAccount<string | null | void>(account, controller.signal, context => method === "PUT"
			? context.client.update(resourceUrl, "synthetic-content", '"old"', "text/calendar")
			: context.client.delete(resourceUrl, '"old"'), {
			fetch: async (_url, init) => {
				requests++;
				assert.equal(init!.method, method);
				assert.equal(new Headers(init!.headers).get("if-match"), '"old"');
				return new Response(new ReadableStream({ cancel() {
					controller.abort(); throw new Error("synthetic-private-cleanup");
				} }), { status: 200, headers: { etag: '"new"' } });
			},
		});
		assert.equal(result, method === "PUT" ? '"new"' : undefined);
		assert.equal(controller.signal.aborted, true);
		assert.equal(requests, 1);
	}
});

test("写入期间取消而无 HTTP 确认，不能冒充未生效；无自动重试", async () => {
	for (const method of ["PUT", "DELETE"] as const) {
		const controller = new AbortController();
		let calls = 0;
		await assert.rejects(withDavAccount<string | null | void>(account, controller.signal, context => method === "PUT"
			? context.client.create(resourceUrl, "fixture", "text/calendar")
			: context.client.delete(resourceUrl, '"old"'), {
			fetch: async () => { calls++; controller.abort(); throw new Error("synthetic-private-transport"); },
		}), error => {
			assert.ok(error instanceof DavToolError);
			assert.equal(error.code, "REMOTE_RESULT_UNKNOWN");
			assert.deepEqual(error.details, { method, resourceUrl });
			assert.doesNotMatch(error.message, /synthetic-private/);
			return true;
		});
		assert.equal(calls, 1);
	}
});

test("GET 后取消会阻止 PUT 发出，而不是报告写入未知", async () => {
	const controller = new AbortController();
	const methods: string[] = [];
	await assert.rejects(withDavAccount(account, controller.signal, async context => {
		await context.client.get(resourceUrl);
		return context.client.update(resourceUrl, "fixture", '"old"', "text/calendar");
	}, { fetch: async (_url, init) => {
		methods.push(init!.method!); controller.abort();
		return new Response("fixture", { status: 200, headers: { etag: '"old"' } });
	} }), error => error instanceof DavToolError && error.code === "ABORTED");
	assert.deepEqual(methods, ["GET"]);
});

test("明确拒绝和冲突不因随后取消被覆盖，202 接受待处理仍非完成", async () => {
	for (const [status, expected] of [[412, "CONFLICT"], [403, "DAV_AUTH_FAILED"], [500, "DAV_FAILED"], [302, "DAV_FAILED"], [202, "REMOTE_RESULT_UNKNOWN"]] as const) {
		const controller = new AbortController();
		let requests = 0;
		await assert.rejects(withDavAccount(account, controller.signal,
			context => context.client.update(resourceUrl, "fixture", '"old"', "text/calendar"), {
			fetch: async () => {
				requests++; controller.abort();
				return new Response("synthetic-private-upstream", { status, headers: { location: "/elsewhere" } });
			},
		}), error => {
			assert.ok(error instanceof DavToolError);
			assert.equal(error.code, expected);
			assert.doesNotMatch(error.message, /synthetic-private/);
			return true;
		});
		assert.equal(requests, 1);
	}
});

test("只读断连仍是安全读取失败，不错误标记远端写入未知", async () => {
	await assert.rejects(withDavAccount(account, undefined, context => context.client.get(resourceUrl), {
		fetch: async () => { throw new Error("synthetic-private-network"); },
	}), error => error instanceof DavToolError && error.code === "DAV_FAILED"
		&& !error.message.includes("synthetic-private"));
});
