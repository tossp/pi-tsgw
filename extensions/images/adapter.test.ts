import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import type { ImageApi, ImageModel, ImagesContext, ImagesOptions } from "@earendil-works/pi-ai";
import { generateImages } from "./adapter.ts";
import { IMAGE_API, IMAGE_MODEL_IDS } from "./models.ts";
import { MAX_RESPONSE_BYTES } from "./response.ts";

const KEY = "fake-test-api-key";
const PROMPT = "private-test-prompt";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const originalFetch = globalThis.fetch;
// 测试进程禁止意外出网；包括未传自定义 fetch 的错误路径。
globalThis.fetch = async () => { throw new Error("测试禁止真实网络"); };

function model(id: string = IMAGE_MODEL_IDS[0]): ImageModel<ImageApi> {
	return { type: "image", id, name: id, provider: "tsgw", api: IMAGE_API,
		baseUrl: "https://gateway.example/v1///", input: ["text"], output: ["image"],
		cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 } };
}
const context = (): ImagesContext => ({ input: [{ type: "text", text: PROMPT }] });
const reply = (extra: Record<string, unknown> = {}) => ({ data: [{ b64_json: PNG }], ...extra });
const jsonResponse = (raw: unknown = reply(), init: ResponseInit = {}) => new Response(JSON.stringify(raw), init);
function mockFetch(respond: () => Response | Promise<Response> = () => jsonResponse()) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init: init! });
		return respond();
	};
	return { calls, fetch };
}
function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}
async function failedInput(input: ImagesContext["input"], options: ImagesOptions = {}, selected = model()) {
	const h = mockFetch();
	const result = await generateImages(selected, { input }, { apiKey: KEY, fetch: h.fetch, ...options });
	assert.equal(result.stopReason, "error"); assert.deepEqual(result.output, []); assert.equal(h.calls.length, 0);
	assert.equal(result.usage, undefined);
	return result;
}
async function failedPayload(change: Record<string, unknown> | ((payload: unknown) => unknown)) {
	return failedInput(context().input, { onPayload: payload => typeof change === "function" ? change(payload) : { ...payload as object, ...change } });
}
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 独立构造可解码的高压缩率 1-bit 灰度 PNG；不调用被测解析器生成 CRC。 */
function monochromePng(width: number, height: number): string {
	const chunk = (type: string, data: Buffer): Buffer => {
		const bytes = Buffer.concat([Buffer.from(type), data]);
		let crc = 0xffffffff;
		for (const byte of bytes) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
		}
		const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
		length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([length, bytes, checksum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 1;
	const pixels = Buffer.alloc((Math.ceil(width / 8) + 1) * height);
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

try {
	await test("两个原生图片 ID 使用默认 payload、Bearer 和调用方 fetch；冻结输入保持不变", async () => {
		assert.deepEqual([...IMAGE_MODEL_IDS], ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"]);
		for (const id of IMAGE_MODEL_IDS) {
			const h = mockFetch(), selected = frozen(model(id));
			const ctx = frozen({ input: [{ type: "text" as const, text: "画猫" }, { type: "text" as const, text: "水彩" }] });
			const snapshot = JSON.stringify(ctx);
			const result = await generateImages(selected, ctx, frozen({ apiKey: KEY, fetch: h.fetch, maxRetries: 9, metadata: { n: 7 } }));
			assert.equal(result.stopReason, "stop"); assert.equal(result.api, IMAGE_API); assert.equal(result.provider, "tsgw");
			assert.equal(result.model, id); assert.ok(Number.isFinite(result.timestamp));
			assert.deepEqual(result.output, [{ type: "image", data: PNG, mimeType: "image/png" }]);
			assert.ok(!("usage" in result)); assert.equal(JSON.stringify(ctx), snapshot);
			assert.equal(h.calls.length, 1);
			const { url, init } = h.calls[0];
			assert.equal(url, "https://gateway.example/v1/images/generations");
			assert.equal(init.method, "POST"); assert.equal(init.redirect, "error"); assert.ok(init.signal instanceof AbortSignal);
			assert.deepEqual(JSON.parse(String(init.body)), { model: id, prompt: "画猫\n水彩", n: 1, quality: "auto", size: "auto", background: "auto", output_format: "png", moderation: "auto", stream: false });
			const headers = new Headers(init.headers);
			assert.equal(headers.get("authorization"), `Bearer ${KEY}`); assert.equal(headers.get("content-type"), "application/json");
		}
	});

	await test("请求头忽略大小写：模型覆盖默认、options 覆盖模型、null 抑制默认", async () => {
		const selected = frozen({ ...model(), headers: { AUTHORIZATION: "model-auth", "Content-Type": "model-json", "X-Trace": "model-trace" } });
		const defaults = mockFetch();
		await generateImages(selected, frozen(context()), { apiKey: KEY, fetch: defaults.fetch });
		assert.equal(new Headers(defaults.calls[0].init.headers).get("authorization"), "model-auth");
		assert.equal(new Headers(defaults.calls[0].init.headers).get("content-type"), "model-json");
		const h = mockFetch();
		await generateImages(selected, frozen(context()), { apiKey: KEY, fetch: h.fetch,
			headers: frozen({ authorization: "option-auth", "CONTENT-TYPE": null, "x-TRACE": "option-trace", "X-Extra": "extra" }) });
		assert.deepEqual(Object.fromEntries(new Headers(h.calls[0].init.headers)), {
			authorization: "option-auth", "x-trace": "option-trace", "x-extra": "extra",
		});
		const suppressed = mockFetch();
		await generateImages(model(), context(), { apiKey: KEY, fetch: suppressed.fetch, headers: { Authorization: null } });
		assert.equal(new Headers(suppressed.calls[0].init.headers).has("authorization"), false);
	});

	await test("默认 fetch 可隔离调用；缺少凭据不请求，显式 Authorization 和 null 可覆盖默认", async () => {
		const h = mockFetch(), blocked = globalThis.fetch;
		globalThis.fetch = h.fetch;
		try {
			assert.equal((await generateImages(model(), context())).stopReason, "error");
			assert.equal(h.calls.length, 0);
			assert.equal((await generateImages(model(), context(), { apiKey: KEY })).stopReason, "stop");
			assert.equal(new Headers(h.calls[0].init.headers).get("authorization"), `Bearer ${KEY}`);
			for (const authorization of ["explicit-auth", null]) {
				assert.equal((await generateImages(model(), context(), { headers: { authorization } })).stopReason, "stop");
				assert.equal(new Headers(h.calls.at(-1)!.init.headers).get("authorization"), authorization);
			}
		} finally { globalThis.fetch = blocked; }
	});

	await test("钩子按契约替换 payload、保留其他字段，onResponse 在读取前收到普通 headers record", async () => {
		const selected = frozen(model()), ctx = frozen(context());
		let responseHook = false, payloadHook = false;
		const h = mockFetch(() => jsonResponse(reply({ revised_prompt: "不应转为输出文本" }), { headers: { "X-Request-ID": "test-id" } }));
		const result = await generateImages(selected, ctx, { apiKey: KEY, fetch: h.fetch,
			onPayload: async (payload, actual) => {
				payloadHook = true; assert.equal(actual, selected); assert.equal(h.calls.length, 0);
				return frozen({ ...payload as object, quality: "high", size: "1024x1024", custom: { keep: true }, user: "test-user" });
			},
			onResponse: async (response, actual) => {
				responseHook = true; assert.equal(payloadHook, true); assert.equal(actual, selected);
				assert.equal(response.status, 200); assert.equal(response.headers["x-request-id"], "test-id");
				assert.equal(response.headers instanceof Headers, false);
			},
		});
		assert.equal(result.stopReason, "stop"); assert.equal(responseHook, true); assert.equal(result.output.length, 1);
		assert.deepEqual(JSON.parse(String(h.calls[0].init.body)), { model: selected.id, prompt: PROMPT,
			n: 1, quality: "high", size: "1024x1024", background: "auto", output_format: "png", moderation: "auto", stream: false, custom: { keep: true }, user: "test-user" });
		const mutate = mockFetch();
		assert.equal((await generateImages(selected, ctx, { apiKey: KEY, fetch: mutate.fetch, onPayload: payload => {
			(payload as Record<string, unknown>).quality = "low"; return undefined;
		} })).stopReason, "stop");
		assert.equal(JSON.parse(String(mutate.calls[0].init.body)).quality, "low");
		assert.equal(ctx.input[0].type === "text" && ctx.input[0].text, PROMPT);
	});

	await test("空输入、无提示词图片、空文本块、超长 prompt 和非目标模型在发请求前失败", async () => {
		for (const input of [[], [{ type: "text", text: "" }], [{ type: "text", text: " \n" }],
			[{ type: "image", data: PNG, mimeType: "image/png" }], [{ type: "text", text: "x".repeat(32001) }],
			[{ type: "text", text: "x".repeat(16000) }, { type: "text", text: "y".repeat(16000) }]] as ImagesContext["input"][]) await failedInput(input);
		for (const changed of [{ id: "gpt-image-unknown" }, { api: "openai-completions" }, { provider: "other" }, { type: "chat" }]) {
			await failedInput(context().input, {}, { ...model(), ...changed } as ImageModel<ImageApi>);
		}
		const h = mockFetch();
		assert.equal((await generateImages(model(), { input: [{ type: "text", text: "x".repeat(32000) }] }, { apiKey: KEY, fetch: h.fetch })).stopReason, "stop");
	});

	await test("最终 payload 固定模型、合法张数/格式、prompt 上限和受限质量/尺寸，不被 toJSON 绕过", async () => {
		for (const patch of [{ model: IMAGE_MODEL_IDS[1] }, { n: 11 }, { n: "1" }, { output_format: "gif" },
			{ prompt: "" }, { prompt: " " }, { prompt: "x".repeat(32001) }, { quality: "ultra" }, { background: "invalid" },
			{ size: "1024X1024" }, { size: "1024x1024\n" }, { size: "1025x1024" }, { size: "640x1008" }, { size: "640x1936" },
			{ size: "3856x2048" }, { size: "3840x3840" }, { size: "0x1024" }, { size: "auto " }]) await failedPayload(patch);
		await failedPayload(() => null);
		await failedPayload(payload => ({ ...payload as object, toJSON: () => ({ n: 8 }) }));
		for (const quality of ["low", "medium", "high", "xhigh", "max", "auto"]) {
			const h = mockFetch();
			assert.equal((await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, onPayload: payload => ({ ...payload as object, quality }) })).stopReason, "stop");
		}
		for (const size of ["auto", "640x1024", "3840x2160", "2160x3840", "768x2304"]) {
			const h = mockFetch();
			assert.equal((await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, onPayload: payload => ({ ...payload as object, size }) })).stopReason, "stop");
		}
	});

	await test("HTTP 非 200 不重试、不采纳原始错误，200 但无有效 image 也必须失败", async () => {
		for (const status of [201, 204, 301, 302, 307, 308, 400, 401, 429, 500, 503]) {
			let hooked = false;
			const h = mockFetch(() => status === 204 ? new Response(null, { status }) : jsonResponse({ error: `${KEY} ${PROMPT} https://gateway.example/secret` }, { status }));
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, maxRetries: 10,
				onResponse: response => { hooked = true; assert.equal(response.status, status); } });
			assert.equal(result.stopReason, "error"); assert.equal(h.calls.length, 1); assert.equal(hooked, true);
			assert.doesNotMatch(result.errorMessage!, /fake-test-api-key|private-test-prompt|gateway\.example|secret/);
			assert.equal(h.calls[0].init.redirect, "error");
		}
		for (const raw of [{}, { data: [] }, { data: [{ url: "https://remote.example/image.png" }] },
			{ data: [{ b64_json: PNG }, { b64_json: PNG }] }, { data: null }, null]) {
			const h = mockFetch(() => jsonResponse(raw));
			assert.equal((await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch })).stopReason, "error");
			assert.equal(h.calls.length, 1);
		}
	});

	await test("拒绝非 canonical base64、假 PNG、损坏 IHDR/CRC/块长度和不完整尾部", async () => {
		const bytes = Buffer.from(PNG, "base64");
		const modified = (offset: number, byte: number) => { const copy = Buffer.from(bytes); copy[offset] = byte; return copy.toString("base64"); };
		// 重算 CRC 后验证 IHDR 和块类型本身，避免测试仅覆盖 CRC 拒绝路径。
		const withCrc = (offset: number, byte: number, chunk = 8) => {
			const copy = Buffer.from(bytes); copy[offset] = byte;
			const end = chunk + 8 + copy.readUInt32BE(chunk);
			let crc = 0xffffffff;
			for (let i = chunk + 4; i < end; i++) {
				crc ^= copy[i];
				for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
			}
			copy.writeUInt32BE((crc ^ 0xffffffff) >>> 0, end); return copy.toString("base64");
		};
		for (const data of ["", "!!!", PNG + "\n", PNG.replace(/=$/, ""), PNG.replace(/I=$/, "J="),
			Buffer.from("not png").toString("base64"), bytes.subarray(0, 8).toString("base64"),
			bytes.subarray(0, -1).toString("base64"), Buffer.concat([bytes, Buffer.from([0])]).toString("base64"),
			modified(0, 0), modified(12, 0), modified(19, 0), modified(8, 255), modified(29, 0),
			withCrc(19, 0), withCrc(24, 3), withCrc(25, 1), withCrc(28, 2), withCrc(60, 0xc9, 56)]) {
			const h = mockFetch(() => jsonResponse({ data: [{ b64_json: data }] }));
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
			assert.equal(result.stopReason, "error"); assert.deepEqual(result.output, []);
		}
	});

	await test("PNG 响应资源上限：拒绝高压缩率超大图片，边长与像素分别检查", async () => {
		for (const [width, height] of [[8192, 8192], [3856, 1024], [3840, 2176]]) {
			const png = monochromePng(width, height);
			assert.ok(png.length < 100_000, "压缩响应很小仍可能造成巨大像素解码开销");
			const h = mockFetch(() => jsonResponse({ data: [{ b64_json: png }] }));
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
			assert.equal(result.stopReason, "error", `${width}x${height}`);
			assert.deepEqual(result.output, []);
		}
		const h = mockFetch(() => jsonResponse({ data: [{ b64_json: monochromePng(3840, 2160) }] }));
		assert.equal((await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch })).stopReason, "stop", "上限内的合法图片不误拒绝");
	});

	await test("图片内容无效仍保留上游已报告的有效 usage，不输出坏图或重试", async () => {
		for (const data of [[], [{ b64_json: "invalid" }], [{ b64_json: PNG }, { b64_json: PNG }]]) {
			const h = mockFetch(() => jsonResponse({ data, usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } }));
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
			assert.equal(result.stopReason, "error"); assert.deepEqual(result.output, []);
			assert.equal(result.usage?.input, 3); assert.equal(result.usage?.output, 4);
			assert.equal(result.usage?.totalTokens, 7); assert.equal(h.calls.length, 1);
		}
	});

	await test("JSON、空 body 和响应流错误安全失败；32 MiB 同时受声明长度和流累计约束", async () => {
		for (const respond of [() => new Response(""), () => new Response("{bad json"), () => new Response(null),
			() => new Response(new Uint8Array([255, 254])),
			() => new Response(new ReadableStream({ start(controller) { controller.error(new Error(`${KEY} ${PROMPT}`)); } })),
			() => jsonResponse(reply(), { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } })]) {
			const h = mockFetch(respond);
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
			assert.equal(result.stopReason, "error"); assert.doesNotMatch(result.errorMessage!, /fake-test|private-test/);
		}
		let cancelled = false, chunks = 0;
		const block = new Uint8Array(1024 * 1024);
		const h = mockFetch(() => new Response(new ReadableStream({
			pull(controller) { chunks++; controller.enqueue(block); }, cancel() { cancelled = true; },
		} ), { headers: { "content-length": "1" } }));
		const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
		assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /32 MiB/);
		assert.equal(cancelled, true); assert.ok(chunks <= 34);
		const exact = mockFetch(() => new Response(JSON.stringify(reply()) + " ".repeat(MAX_RESPONSE_BYTES - JSON.stringify(reply()).length)));
		assert.equal((await generateImages(model(), context(), { apiKey: KEY, fetch: exact.fetch })).stopReason, "stop");
	});

	await test("Content-Length 预拒绝、非 200 和 onResponse 异常均取消未读 body，不等待悬挂 cancel", async () => {
		for (const failure of ["length", "status", "hook"]) {
			let cancelled = false, pulled = false;
			const h = mockFetch(() => new Response(new ReadableStream({
				pull() { pulled = true; },
				cancel() { cancelled = true; return new Promise(() => {}); },
			}, { highWaterMark: 0 }), {
				status: failure === "status" ? 503 : 200,
				headers: failure === "length" ? { "Content-Length": String(MAX_RESPONSE_BYTES + 1) } : {},
			}));
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch,
				onResponse: failure === "hook" ? () => { throw new Error(KEY); } : undefined });
			assert.equal(result.stopReason, "error"); assert.equal(cancelled, true); assert.equal(pulled, false);
		}
	});

	await test("构造、网络、请求钩子和响应钩子的原始异常不会泄漏凭据、URL 或提示词", async () => {
		const sensitive = () => { throw new Error(`${KEY} ${PROMPT} https://gateway.example/?credential=raw-secret`); };
		for (const overrides of [{ fetch: sensitive }, { onPayload: sensitive }, { onResponse: sensitive },
			{ headers: { "Invalid\nHeader": KEY } }, { onPayload: () => { const cycle: Record<string, unknown> = {}; cycle.self = cycle; return cycle; } }]) {
			const h = mockFetch();
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, ...overrides });
			assert.equal(result.stopReason, "error");
			assert.doesNotMatch(result.errorMessage!, /fake-test|private-test|gateway\.example|credential|raw-secret/);
			assert.ok(h.calls.length <= 1);
		}
	});

	await test("usage 仅映射真实有效 tokens，分离缓存并按 model.cost 计算；不存在时完全省略", async () => {
		for (const usage of [undefined, {}, { input_tokens: 2 }, { output_tokens: 2 },
			{ input_tokens: "10", output_tokens: 5 }, { input_tokens: -1, output_tokens: 5 },
			{ input_tokens: 1.1, output_tokens: 5 }, { input_tokens: 1, output_tokens: Number.MAX_SAFE_INTEGER },
			{ input_tokens: 10, output_tokens: 5, total_tokens: 16 },
			{ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 11 } },
			{ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: -1 } },
			{ input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 1, cache_write_tokens: 2 } }]) {
			const h = mockFetch(() => jsonResponse(reply(usage === undefined ? {} : { usage })));
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
			assert.equal(result.stopReason, "stop"); assert.ok(!("usage" in result));
		}
		const h = mockFetch(() => jsonResponse(reply({ usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150,
			input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 } } })));
		const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch });
		assert.ok(result.usage);
		assert.deepEqual({ ...result.usage, cost: undefined }, { input: 80, output: 50, cacheRead: 15, cacheWrite: 5, totalTokens: 150, cost: undefined });
		for (const [field, value] of Object.entries({ input: 0.00016, output: 0.0004, cacheRead: 0.0000075, cacheWrite: 0.000015, total: 0.0005825 })) {
			assert.ok(Math.abs(result.usage.cost[field as keyof typeof result.usage.cost] - value) < 1e-12);
		}
		const zero = mockFetch(() => jsonResponse(reply({ usage: { input_tokens: 0, output_tokens: 0 } })));
		assert.equal((await generateImages(model(), context(), { apiKey: KEY, fetch: zero.fetch })).usage?.totalTokens, 0);
		const plain = mockFetch(() => jsonResponse(reply({ usage: { input_tokens: 12, output_tokens: 8 } })));
		const unknownCost = { ...model(), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
		assert.equal((await generateImages(unknownCost, context(), { apiKey: KEY, fetch: plain.fetch })).usage?.cost.total, 0);
	});

	await test("预取消不发请求；取消贯穿 fetch、body、onPayload 和 onResponse，迟到拒绝无 unhandled", async () => {
		const before = new AbortController(); before.abort(new Error(KEY));
		const h = mockFetch();
		assert.equal((await generateImages(model(), context(), { signal: before.signal, fetch: h.fetch })).stopReason, "aborted");
		assert.equal(h.calls.length, 0);
		const unhandled: unknown[] = [], observe = (reason: unknown) => { unhandled.push(reason); };
		process.on("unhandledRejection", observe);
		try {
			for (const stage of ["fetch", "body", "onPayload", "onResponse"] as const) {
				const caller = new AbortController(); let entered!: () => void;
				const started = new Promise<void>(resolve => { entered = resolve; });
				const late = () => { entered(); return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(KEY)), 10)); };
				let bodyCancelled = false;
				const h = mockFetch(stage === "fetch" ? late : stage === "body" ? () => new Response(new ReadableStream({
					pull: late, cancel() { bodyCancelled = true; },
				}, { highWaterMark: 0 })) : () => jsonResponse());
				const pending = generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, signal: caller.signal,
					...(stage === "onPayload" ? { onPayload: late } : stage === "onResponse" ? { onResponse: late } : {}) });
				await started; caller.abort(new Error(`${KEY} ${PROMPT}`));
				const result = await pending;
				assert.equal(result.stopReason, "aborted"); assert.match(result.errorMessage!, /取消.*未自动重试.*不代表上游未计费/);
				assert.doesNotMatch(result.errorMessage!, /fake-test|private-test/);
				if (stage === "onPayload") assert.equal(h.calls.length, 0);
				else assert.equal(h.calls[0].init.signal?.aborted, true);
				if (stage === "body") assert.equal(bodyCancelled, true);
			}
			await wait(30); assert.deepEqual(unhandled, []);
		} finally { process.off("unhandledRejection", observe); }
	});

	await test("忽略 signal 的自定义 fetch 在取消后迟到返回 Response，也会取消其 body", async () => {
		const caller = new AbortController();
		let release!: (response: Response) => void, entered!: () => void, cancelled = false;
		const started = new Promise<void>(resolve => { entered = resolve; });
		const h = mockFetch(() => { entered(); return new Promise<Response>(resolve => { release = resolve; }); });
		const pending = generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, signal: caller.signal });
		await started; caller.abort(); assert.equal((await pending).stopReason, "aborted");
		release(new Response(new ReadableStream({ cancel() { cancelled = true; return Promise.reject(new Error(KEY)); } }, { highWaterMark: 0 })));
		await wait(5); assert.equal(cancelled, true);
	});

	await test("更短 timeout 贯穿 fetch、body 和钩子，maxRetries 不造成自动重试", async () => {
		for (const stage of ["fetch", "body", "onPayload", "onResponse"]) {
			const never = () => new Promise<never>(() => {});
			const h = mockFetch(stage === "fetch" ? never : stage === "body" ? () => new Response(new ReadableStream({
				pull: never, cancel: never,
			}, { highWaterMark: 0 })) : () => jsonResponse());
			const result = await generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, timeoutMs: 5, maxRetries: 10,
				...(stage === "onPayload" ? { onPayload: never } : stage === "onResponse" ? { onResponse: never } : {}) });
			assert.equal(result.stopReason, "error"); assert.match(result.errorMessage!, /超时.*未自动重试.*不代表上游未计费/);
			assert.equal(h.calls.length, stage === "onPayload" ? 0 : 1);
			if (stage !== "onPayload") assert.equal(h.calls[0].init.signal?.aborted, true);
		}
		for (const timeoutMs of [-1, NaN, Infinity, 2_147_483_648]) await failedInput(context().input, { timeoutMs });
		await failedInput(context().input, { timeoutMs: 0 });
	});

	await test("默认截止 600000ms；调用方可明确延长截止，不把默认值当硬限制", async t => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		for (const timeoutMs of [undefined, 900_000, 2_147_483_647]) {
			let entered!: () => void;
			const started = new Promise<void>(resolve => { entered = resolve; });
			const h = mockFetch(() => { entered(); return new Promise(() => {}); });
			const pending = generateImages(model(), context(), { apiKey: KEY, fetch: h.fetch, timeoutMs });
			await started; t.mock.timers.tick((timeoutMs ?? 600_000) - 1);
			assert.equal(h.calls[0].init.signal?.aborted, false);
			t.mock.timers.tick(1);
			assert.match((await pending).errorMessage!, /超时/); assert.equal(h.calls.length, 1);
		}
	});
} finally {
	globalThis.fetch = originalFetch;
}
