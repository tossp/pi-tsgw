import assert from "node:assert/strict";
import { Writable, Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { UploadError } from "./errors.ts";
import { isPublicAddress, putBytesWithDeps, type PutTarget, type TransportDeps } from "./transport.ts";

const target = (size = 3): PutTarget => ({
	url: "https://bucket.storage.example/object?X-Amz-Signature=secret-signature",
	method: "PUT", headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*", "x-amz-meta-kind": "test" },
	expiresAt: new Date(Date.now() + 600_000).toISOString(), size,
});
const signal = () => new AbortController().signal;

function harness(options: { status?: number; early?: boolean; hang?: boolean; failWrite?: boolean } = {}) {
	const chunks: Buffer[] = [];
	let calls = 0;
	let captured: RequestOptions | undefined;
	let socket: Writable | undefined;
	const deps: TransportDeps = {
		resolve: async () => [{ address: "8.8.8.8", family: 4 }],
		request: (requestOptions, respond) => {
			calls++;
			captured = requestOptions;
			const reply = () => {
				if (socket?.destroyed) return;
				const incoming = Readable.from([Buffer.from("ignored response")]) as unknown as IncomingMessage;
				incoming.statusCode = options.status ?? 200;
				incoming.complete = true;
				respond(incoming);
			};
			socket = new Writable({
				autoDestroy: false,
				write(chunk: Buffer, _encoding, callback) {
					chunks.push(Buffer.from(chunk));
					if (options.failWrite) callback(new Error("secret-signature network details"));
					else setImmediate(callback);
				},
			});
			if (options.early) setImmediate(reply);
			else if (!options.hang) socket.once("finish", () => setImmediate(reply));
			return socket as unknown as ClientRequest;
		},
	};
	return { deps, chunks, get calls() { return calls; }, get captured() { return captured; }, get socket() { return socket; } };
}

async function expectCode(action: Promise<void>, code: string) {
	await assert.rejects(action, (error: unknown) => {
		assert.ok(error instanceof UploadError);
		assert.equal(error.code, code);
		assert.doesNotMatch(error.message + error.stack, /secret-signature|storage\.example|raw-secret|Authorization/);
		return true;
	});
}

// 验证原始字节、签名请求头保留、有界写入、DNS 地址固定和 TLS 默认设置。
{
	const h = harness();
	const bytes = Buffer.alloc(200_003);
	for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
	await putBytesWithDeps(target(bytes.length), bytes, signal(), h.deps);
	assert.deepEqual(Buffer.concat(h.chunks), bytes);
	assert.ok(h.chunks.every(chunk => chunk.length <= 65_536));
	assert.equal(h.calls, 1);
	assert.equal(h.socket?.destroyed, true);
	assert.equal(h.captured?.rejectUnauthorized, true);
	assert.equal(h.captured?.agent, false);
	assert.equal(h.captured?.method, "PUT");
	assert.deepEqual({ ...h.captured?.headers }, {
		"content-type": "application/octet-stream", "if-none-match": "*", "x-amz-meta-kind": "test", "content-length": String(bytes.length),
	});
	const lookup = h.captured!.lookup!;
	lookup("untrusted-rebinding.example", {}, (err, address, family) => {
		assert.equal(err, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4);
	});
	lookup("untrusted-rebinding.example", { all: true }, (err, addresses) => {
		assert.equal(err, null); assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
	});
}

for (const length of [2, 4]) {
	const h = harness();
	let closed = false;
	async function* bytes() { try { yield Buffer.alloc(length); } finally { closed = true; } }
	await expectCode(putBytesWithDeps(target(), bytes(), signal(), h.deps), "network-error");
	assert.equal(closed, true);
	assert.equal(h.socket?.destroyed, true);
	if (length === 4) assert.equal(h.chunks.length, 0);
}
{
	const h = harness();
	await putBytesWithDeps(target(0), new Uint8Array(), signal(), h.deps);
	assert.equal(h.chunks.length, 0);
	const withLength = target();
	withLength.headers["Content-Length"] = "3";
	await putBytesWithDeps(withLength, Buffer.from([0, 255, 128]), signal(), harness().deps);
}
for (const status of [301, 307, 308, 400, 503]) {
	const h = harness({ status });
	await expectCode(putBytesWithDeps(target(), Buffer.from([0, 255, 3]), signal(), h.deps), status < 400 ? "redirect" : "http-error");
	assert.equal(h.calls, 1);
	assert.equal(h.socket?.destroyed, true);
}
{
	const h = harness({ early: true });
	let closed = false;
	async function* bytes() {
		try { await new Promise(resolve => setTimeout(resolve, 15)); yield Buffer.alloc(3); }
		finally { closed = true; }
	}
	await expectCode(putBytesWithDeps(target(), bytes(), signal(), h.deps), "network-error");
	assert.equal(closed, true);
	assert.equal(h.chunks.length, 0);
}
{
	const h = harness();
	let closed = false;
	async function* bytes() { try { yield Buffer.from([1]); throw new Error("raw-secret"); } finally { closed = true; } }
	await expectCode(putBytesWithDeps(target(), bytes(), signal(), h.deps), "network-error");
	assert.equal(closed, true);
}
{
	const h = harness({ failWrite: true });
	await expectCode(putBytesWithDeps(target(), Buffer.alloc(3), signal(), h.deps), "network-error");
	assert.equal(h.socket?.destroyed, true);
}
{
	const h = harness({ hang: true });
	const abort = new AbortController();
	let closed = false;
	async function* bytes() {
		try {
			abort.abort(new Error("raw-secret"));
			await new Promise(resolve => setTimeout(resolve, 15));
			yield Buffer.alloc(3);
		} finally { closed = true; }
	}
	await expectCode(putBytesWithDeps(target(), bytes(), abort.signal, h.deps), "cancelled");
	assert.equal(closed, true);
	assert.equal(h.chunks.length, 0);
	assert.equal(h.socket?.destroyed, true);
}
{
	const h = harness();
	const abort = new AbortController(); abort.abort();
	let returned = false;
	const body = { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true as const, value: undefined }),
		return: async () => { returned = true; return { done: true as const, value: undefined }; } }) };
	await expectCode(putBytesWithDeps(target(), body, abort.signal, h.deps), "cancelled");
	assert.equal(returned, true); assert.equal(h.calls, 0);
}
{
	const h = harness({ hang: true });
	await expectCode(putBytesWithDeps({ ...target(), expiresAt: new Date(Date.now() + 50).toISOString() }, Buffer.alloc(3), signal(), h.deps), "timeout");
	assert.equal(h.socket?.destroyed, true);
}
// 进度不会延长总截止时间；拒绝前关闭数据生产者。
{
	const h = harness();
	let closed = false;
	async function* bytes() {
		try {
			for (let i = 0; i < 100; i++) {
				await new Promise(resolve => setTimeout(resolve, 5));
				yield Buffer.from([i]);
			}
		} finally { closed = true; }
	}
	await expectCode(putBytesWithDeps({ ...target(100), expiresAt: new Date(Date.now() + 50).toISOString() }, bytes(), signal(), h.deps), "timeout");
	assert.equal(closed, true);
	assert.ok(h.chunks.length < 100);
	assert.equal(h.socket?.destroyed, true);
}
// 截止时间也覆盖 DNS，而不仅是套接字空闲时间。
{
	const h = harness();
	let stopped = false;
	h.deps.resolve = async (_host, abort) => new Promise(resolve => {
		abort.addEventListener("abort", () => { stopped = true; resolve([]); }, { once: true });
	});
	await expectCode(putBytesWithDeps({ ...target(), expiresAt: new Date(Date.now() + 40).toISOString() }, Buffer.alloc(3), signal(), h.deps), "timeout");
	assert.equal(stopped, true); assert.equal(h.calls, 0);
}

for (const address of [
	"0.1.2.3", "10.0.0.1", "100.64.1.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.0.1",
	"192.0.0.9", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255",
	"::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "fc00::1", "fe80::1", "ff02::1", "2001::1", "2001:2::1",
	"2001:20::1", "2001:db8::1", "2002:0808:0808::1", "3fff::1", "not-an-ip",
]) assert.equal(isPublicAddress(address), false, address);
for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
	assert.equal(isPublicAddress(address), true, address);
}
for (const address of ["127.0.0.1", "::1", "2001:db8::1"]) {
	const h = harness();
	h.deps.resolve = async () => [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }];
	await expectCode(putBytesWithDeps(target(), Buffer.alloc(3), signal(), h.deps), "invalid-target");
	assert.equal(h.calls, 0);
}
for (const url of ["http://public.example/a", "https://user:password@public.example/a", "https://public.example:444/a",
	"https://public.example/a#fragment", "https://127.1/a", "https://[::1]/a", "raw-secret"] ) {
	const h = harness();
	await expectCode(putBytesWithDeps({ ...target(), url }, Buffer.alloc(3), signal(), h.deps), "invalid-target");
	assert.equal(h.calls, 0);
}
for (const headers of [
	{ Authorization: "raw-secret" }, { Cookie: "raw-secret" }, { Host: "private" }, { Connection: "close" },
	{ "Transfer-Encoding": "chunked" }, { "Content-Length": "4" }, { "Content-Length": "03" },
	{ "If-None-Match": "other" }, { "x-amz-meta-test": "value\r\ninjected: secret" }, { "x-amz-meta-a\n": "x" },
	{ "content-type": "a", "Content-Type": "b" }, { "x-mcp-key": "raw-secret" },
] as Record<string, string>[]) {
	const h = harness();
	await expectCode(putBytesWithDeps({ ...target(), headers }, Buffer.alloc(3), signal(), h.deps), "invalid-headers");
	assert.equal(h.calls, 0);
}
{
	const h = harness();
	await expectCode(putBytesWithDeps({ ...target(), expiresAt: new Date(0).toISOString() }, Buffer.alloc(3), signal(), h.deps), "invalid-target");
	assert.equal(h.calls, 0);
	h.deps.resolve = async () => { throw new Error("raw-secret"); };
	await expectCode(putBytesWithDeps(target(), Buffer.alloc(3), signal(), h.deps), "network-error");
	h.deps.resolve = async () => [];
	await expectCode(putBytesWithDeps(target(), Buffer.alloc(3), signal(), h.deps), "network-error");
}
console.log("上传传输测试通过");
