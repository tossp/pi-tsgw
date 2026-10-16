import { Resolver } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { UploadError } from "./errors.ts";

export interface PutTarget {
	url: string;
	method: "PUT";
	headers: Record<string, string>;
	expiresAt: string;
	size: number;
}

type Address = { address: string; family: 4 | 6 };
/** 供离线传输测试使用的有限依赖注入点；生产环境始终使用 Node DNS 和 HTTPS。 */
export interface TransportDeps {
	resolve(host: string, signal: AbortSignal): Promise<Address[]>;
	request(options: RequestOptions, response: (response: IncomingMessage) => void): ClientRequest;
}

const messages = {
	"http-error": "上传服务器拒绝了所发送的字节。不要自动重复上传。",
	redirect: "上传不允许重定向。",
	"network-error": "上传传输或字节流失败。不要自动重复上传。",
	timeout: "上传已超过截止时间。不要自动重复上传。",
	cancelled: "上传已取消。不要自动重复上传。",
	"invalid-target": "上传目标不是有效的公网 HTTPS 地址。",
	"invalid-headers": "上传请求头不被允许，或与字节数不匹配。",
} as const;
type Code = keyof typeof messages;
const failure = (code: Code) => new UploadError(code, messages[code]);

/** 拒绝特殊用途 IPv4，以及非全球可达、过渡机制或文档用途的 IPv6。 */
export function isPublicAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
		return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
			(a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) ||
			(a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
			(a === 203 && b === 0 && c === 113));
	}
	if (isIP(address) !== 6 || address.includes("%")) return false;
	const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
	const parts = canonical.split(":");
	const first = Number.parseInt(parts[0]!, 16);
	const second = Number.parseInt(parts[1] || "0", 16);
	return first >= 0x2000 && first <= 0x3fff &&
		// 2001::/23 包含 Teredo、基准测试、ORCHID 和协议分配地址。
		!(first === 0x2001 && second < 0x200) &&
		!(first === 0x2001 && second === 0xdb8) && first !== 0x2002 &&
		!(first === 0x3fff && second < 0x1000);
}

async function resolvePublic(host: string, signal: AbortSignal): Promise<Address[]> {
	const resolver = new Resolver();
	const cancel = () => resolver.cancel();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		if (signal.aborted) throw failure("cancelled");
		const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
		return results.flatMap((result, index) => result.status === "fulfilled"
			? result.value.map(address => ({ address, family: (index === 0 ? 4 : 6) as 4 | 6 })) : []);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

function validate(target: PutTarget): { url: URL; headers: Record<string, string>; deadline: number } {
	let url: URL;
	try { url = new URL(target.url); } catch { throw failure("invalid-target"); }
	const expiry = Date.parse(target.expiresAt);
	if (target.method !== "PUT" || !Number.isSafeInteger(target.size) || target.size < 0 ||
		url.protocol !== "https:" || url.username || url.password || url.hash ||
		(url.port && url.port !== "443") || !Number.isFinite(expiry) || expiry <= Date.now()) {
		throw failure("invalid-target");
	}
	const headers: Record<string, string> = Object.create(null) as Record<string, string>;
	for (const [key, value] of Object.entries(target.headers)) {
		const name = key.toLowerCase();
		if (!(name === "content-type" || name === "content-length" || name === "if-none-match" ||
			/^x-amz-[a-z0-9-]+$/.test(name)) || name in headers || typeof value !== "string" ||
			/[^\x20-\x7e]/.test(value) || (name === "if-none-match" && value !== "*") ||
			(name === "content-length" && value !== String(target.size))) throw failure("invalid-headers");
		headers[name] = value;
	}
	headers["content-length"] = String(target.size);
	// 这是总时限，而非套接字空闲超时：至少允许 330 秒，再按 64 KiB/s 计算。
	const budget = Math.max(330_000, Math.ceil(target.size / 65_536) * 1000);
	return { url, headers, deadline: Math.min(expiry, Date.now() + budget) };
}

export async function putBytes(
	target: PutTarget, body: AsyncIterable<Uint8Array> | Uint8Array, signal: AbortSignal,
): Promise<void> {
	return putBytesWithDeps(target, body, signal, { resolve: resolvePublic, request });
}

export async function putBytesWithDeps(
	target: PutTarget, body: AsyncIterable<Uint8Array> | Uint8Array, signal: AbortSignal, deps: TransportDeps,
): Promise<void> {
	let iterator: AsyncIterator<Uint8Array> | undefined;
	let req: ClientRequest | undefined;
	let response: IncomingMessage | undefined;
	let requestClosed: Promise<void> | undefined;
	let pumping: Promise<void> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const controller = new AbortController();
	let error: UploadError | undefined;
	let rejectStopped!: (error: UploadError) => void;
	const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
	void stopped.catch(() => {});
	const stop = (code: Code) => {
		if (error) return;
		error = failure(code);
		controller.abort();
		response?.destroy();
		req?.destroy();
		rejectStopped(error);
	};
	const abort = () => stop("cancelled");
	try {
		iterator = body instanceof Uint8Array ? (async function* () { yield body; })() : body[Symbol.asyncIterator]();
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) { stop("cancelled"); throw error; }
		const { url, headers, deadline } = validate(target);
		const arm = () => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) stop("timeout");
			else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
		};
		arm();
		const host = url.hostname.replace(/^\[|\]$/g, "");
		const addresses = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }]
			: await deps.resolve(host, controller.signal);
		if (error) throw error;
		if (!addresses.length) throw failure("network-error");
		if (addresses.some(item => !isPublicAddress(item.address))) throw failure("invalid-target");
		const pinned = addresses[0]!;
		let sent = false;
		let resolveResponse!: () => void;
		const received = new Promise<void>(resolve => { resolveResponse = resolve; });
		req = deps.request({
			protocol: "https:", hostname: host, port: 443, method: "PUT",
			path: url.pathname + url.search, headers, agent: false, rejectUnauthorized: true,
			lookup: (_hostname, options, callback) => {
				if (options.all) callback(null, [pinned]);
				else callback(null, pinned.address, pinned.family);
			},
		}, incoming => {
			response = incoming;
			incoming.on("error", () => stop("network-error"));
			const status = incoming.statusCode ?? 0;
			if (status >= 300 && status < 400) { stop("redirect"); return; }
			if (status < 200 || status >= 300) { stop("http-error"); return; }
			if (!sent) { stop("network-error"); return; }
			incoming.on("aborted", () => stop("network-error"));
			incoming.on("end", resolveResponse);
			incoming.on("close", () => { if (!incoming.complete) stop("network-error"); });
			incoming.resume();
		});
		const active = req;
		requestClosed = new Promise(resolve => active.once("close", resolve));
		active.on("error", () => stop("network-error"));
		active.on("close", () => { if (!response?.complete) stop("network-error"); });
		pumping = (async () => {
			let count = 0;
			while (!error) {
				const item = await iterator!.next();
				if (error) break;
				if (item.done) {
					if (count !== target.size) throw failure("network-error");
					await new Promise<void>((resolve, reject) => {
						active.end(() => { sent = true; resolve(); });
						void stopped.catch(reject);
					});
					return;
				}
				if (!(item.value instanceof Uint8Array) || item.value.byteLength > target.size - count) {
					throw failure("network-error");
				}
				count += item.value.byteLength;
				// 限制单次写入大小并通过回调施加背压；绝不拼接整个上传内容。
				for (let offset = 0; offset < item.value.byteLength && !error; offset += 65_536) {
					await new Promise<void>((resolve, reject) => {
						const interrupted = () => finish(error);
						const finish = (err?: Error | null) => {
							controller.signal.removeEventListener("abort", interrupted);
							err ? reject(err) : resolve();
						};
						controller.signal.addEventListener("abort", interrupted, { once: true });
						try { active.write(item.value.subarray(offset, offset + 65_536), finish); }
						catch { finish(failure("network-error")); }
					});
				}
			}
		})();
		void pumping.catch(() => stop("network-error"));
		await Promise.race([stopped, Promise.all([pumping, received])]);
	} catch (caught) {
		if (!error) stop(caught instanceof UploadError && caught.code in messages ? caught.code as Code : "network-error");
	} finally {
		if (timer) clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		controller.abort();
		response?.destroy();
		req?.destroy();
		// 请求或正在运行的数据生产者尚未结束时，不得返回。
		await pumping?.catch(() => {});
		try { await iterator?.return?.(); } catch { if (!error) error = failure("network-error"); }
		await requestClosed;
	}
	if (error) throw error;
}
