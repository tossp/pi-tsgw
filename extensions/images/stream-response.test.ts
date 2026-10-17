import assert from "node:assert/strict";
import test from "node:test";
import { ImageFailure, MAX_RESPONSE_BYTES } from "./response.ts";
import { MAX_SSE_EVENT_BYTES, readImageResponse, type ExpectedImageResponse } from "./stream-response.ts";
import { PNG, REAL_IMAGE_FIXTURES, pngContainer } from "./image-fixtures.test.ts";

const expected = (patch: Partial<ExpectedImageResponse> = {}): ExpectedImageResponse => ({ count: 1, format: "png", stream: true, operation: "generate", ...patch });
const usage = { input_tokens: 3, output_tokens: 4, total_tokens: 7 };
const complete = (patch: Record<string, unknown> = {}) => ({ type: "image_generation.completed", b64_json: PNG, ...patch });
const partial = (patch: Record<string, unknown> = {}) => ({ type: "image_generation.partial_image", partial_image_index: 0, b64_json: PNG, ...patch });
function frame(raw: Record<string, unknown>, eol = "\n", multiline = false): string {
	const data = JSON.stringify(raw, null, multiline ? 2 : undefined).split("\n").map(line => `data: ${line}`).join(eol);
	return `event: ${raw.type}${eol}${data}${eol}${eol}`;
}
function sse(chunks: (string | Uint8Array)[], cancel?: () => void): Response {
	let index = 0;
	return new Response(new ReadableStream<Uint8Array>({
		pull(c) { if (index < chunks.length) { const item = chunks[index++]; c.enqueue(typeof item === "string" ? Buffer.from(item) : item); } else c.close(); },
		cancel,
	}), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}
async function read(response: Response, exp = expected()) {
	const reports: unknown[] = [];
	const output = await readImageResponse(response, new AbortController().signal, exp, raw => reports.push(raw));
	return { output, reports };
}

test("非流式 n/多格式调用先报告 usage；坏图、数量错和元数据冲突同样保留 usage", async () => {
	for (const { format, data } of [{ format: "png", data: PNG }, ...REAL_IMAGE_FIXTURES] as const) {
		const raw = { data: [{ b64_json: data }], usage };
		const result = await read(new Response(JSON.stringify(raw)), expected({ format, stream: false }));
		assert.deepEqual(result.reports, [raw]); assert.equal(result.output[0].mimeType, `image/${format}`);
	}
	for (const patch of [{ data: [] }, { data: [{ b64_json: "bad" }] }, { size: "2x2" }, { output_format: "jpeg" }]) {
		const raw = { data: [{ b64_json: PNG }], usage, ...patch }, reports: unknown[] = [];
		await assert.rejects(readImageResponse(new Response(JSON.stringify(raw)), new AbortController().signal, expected({ stream: false }), value => reports.push(value)), ImageFailure);
		assert.deepEqual(reports, [raw]);
	}
	const raw = { data: [{ b64_json: PNG }, { b64_json: PNG }], usage };
	assert.equal((await read(new Response(JSON.stringify(raw)), expected({ stream: false, count: 2 }))).output.length, 2);
	// n=2 的总预算不是旧的 32 MiB；这里只用声明长度，不分配大响应。
	assert.equal((await read(new Response(JSON.stringify(raw), { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }), expected({ stream: false, count: 2 }))).output.length, 2);
});

test("SSE 任意字节拆分、跨 chunk UTF-8/CRLF、多行 data；partial 不累计成输出或 usage", async () => {
	const final = complete({ usage, revised_prompt: "中文😀" });
	const source = Buffer.from(": 注释\r\n\r\n" + frame(partial(), "\r\n", true) + frame(final, "\r\n", true) + "data: [DONE]\r\n\r\n");
	for (const chunks of [[source], Array.from(source, value => Buffer.from([value])),
		...Array.from({ length: source.length - 1 }, (_, i) => [source.subarray(0, i + 1), source.subarray(i + 1)])]) {
		const result = await read(sse(chunks));
		assert.deepEqual(result.output, [{ type: "image", data: PNG, mimeType: "image/png" }]);
		assert.deepEqual(result.reports, [final]);
	}
});

test("生成/编辑 SSE 使用真实三格式，允许仅 data.type；显式序号不改变 completed 到达顺序", async () => {
	for (const { format, data } of [{ format: "png", data: PNG }, ...REAL_IMAGE_FIXTURES] as const) {
		for (const operation of ["generate", "edit"] as const) {
			const raw = complete({ type: operation === "edit" ? "image_edit.completed" : "image_generation.completed", b64_json: data, usage });
			const result = await read(sse([`data: ${JSON.stringify(raw)}\n\n`]), expected({ format, operation }));
			assert.equal(result.output[0].mimeType, `image/${format}`); assert.deepEqual(result.reports, [raw]);
		}
	}
	const second = pngContainer(2, 1).toString("base64");
	const result = await read(sse([frame(complete({ image_index: 1, b64_json: second })), frame(complete({ image_index: 0, usage }))]), expected({ count: 2 }));
	assert.deepEqual(result.output.map(image => image.data), [second, PNG]);
	assert.deepEqual(result.reports, [{ usage_reports: [usage] }]);
	const unindexed = await read(sse([frame(partial()), frame(complete()), frame(partial({ partial_image_index: 1 })),
		frame(complete({ usage }))]), expected({ count: 2 }));
	assert.deepEqual(unindexed.output.map(image => image.data), [PNG, PNG]);
	const optionalIndex = await read(sse([frame(complete({ image_index: 0 })), frame(complete())]), expected({ count: 2 }));
	assert.equal(optionalIndex.output.length, 2);
});

test("多图相同图片/usage 均不去重，多个 usage_reports 为独立有界快照，不伪造汇总", async () => {
	for (const secondUsage of [usage, { input_tokens: 9, output_tokens: 9 }]) {
		const result = await read(sse([frame(complete({ usage })), frame(complete({ usage: secondUsage }))]), expected({ count: 2 }));
		assert.deepEqual(result.output.map(image => image.data), [PNG, PNG]);
		assert.deepEqual(result.reports, [{ usage_reports: [usage] }, { usage_reports: [usage, secondUsage] }]);
	}
	const all = Array.from({ length: 10 }, (_, i) => ({ input_tokens: i, output_tokens: i + 1 }));
	const result = await read(sse(all.map(value => frame(complete({ usage: value })))), expected({ count: 10 }));
	assert.equal(result.output.length, 10);
	assert.deepEqual(result.reports, all.map((_, i) => ({ usage_reports: all.slice(0, i + 1) })));
	const reports: unknown[] = [];
	await assert.rejects(readImageResponse(sse([...all.map(value => frame(complete({ usage: value }))),
		frame(complete({ usage }))]), new AbortController().signal, expected({ count: 10 }), raw => reports.push(raw)), /超额/);
	assert.equal(reports.length, 10); assert.deepEqual(reports.at(-1), { usage_reports: all });
});

test("单图超额完成/迟到错误不覆盖首次 usage；多图坏图与超额路径仍保留原始 usage_reports", async () => {
	const first = complete({ usage }), later = { input_tokens: 9, output_tokens: 9 };
	for (const event of [complete({ usage: later }), { type: "error", usage: later }]) {
		const reports: unknown[] = [];
		await assert.rejects(readImageResponse(sse([frame(first), frame(event)]), new AbortController().signal,
			expected(), raw => reports.push(raw)), ImageFailure);
		assert.deepEqual(reports, [first]);
	}
	for (const tail of [[frame(complete({ b64_json: "bad", usage: later }))],
		[frame(complete()), frame(complete({ usage: later }))], [frame({ type: "error", usage: later })]]) {
		const reports: unknown[] = [];
		await assert.rejects(readImageResponse(sse([frame(first), ...tail]), new AbortController().signal,
			expected({ count: 2 }), raw => reports.push(raw)), ImageFailure);
		assert.deepEqual(reports, [{ usage_reports: [usage] }, { usage_reports: [usage, later] }]);
	}
});

test("HTTP200 不是完成：断流、坏图、过多/重复完成、partial 超额、类型和序号错误安全失败", async () => {
	const final = frame(complete()), part = frame(partial());
	const cases: [string, Partial<ExpectedImageResponse>?][] = [
		[""], [part], ["data: [DONE]\n\n"], [final.slice(0, -1)], [final + "data: {"],
		[final, { count: 2 }], [final + final],
		[frame(complete({ b64_json: "bad", usage }))], [frame(complete({ size: "2x2" }))],
		[frame(partial({ b64_json: "bad" })) + final], [part.repeat(4) + final],
		[frame(partial({ partial_image_index: 3 })) + final], [frame(partial({ partial_image_index: -1 })) + final],
		[frame(complete({ image_index: 1 }))], [frame(complete({ image_index: 0.5 }))],
		[frame(complete({ image_index: 0 })) + frame(complete({ image_index: 0 })), { count: 2 }],
		[frame(complete({ type: "image_edit.completed" }))], [frame(complete({ type: "unknown" }))],
		['event: image_generation.completed\ndata: {"type":"image_edit.completed"}\n\n'],
		['data: {"type":\n\n'], [final + "data: [DONE]\n\n" + final], [final + part],
	];
	for (const [source, patch] of cases) await assert.rejects(read(sse([source]), expected(patch)), ImageFailure, source.slice(0, 100));
});

test("坏图与错误事件保留真实 usage，服务端错误/原始异常内容绝不进入安全错误", async () => {
	for (const raw of [complete({ b64_json: "invalid", usage }), { type: "error", message: "private-server-secret", usage },
		complete({ error: { message: "private-server-secret" }, usage })]) {
		const reports: unknown[] = [];
		await assert.rejects(readImageResponse(sse([frame(raw)]), new AbortController().signal, expected(), value => reports.push(value)), error => {
			assert.ok(error instanceof ImageFailure); assert.ok(!error.message.includes("private-server-secret")); return true;
		});
		assert.deepEqual(reports, [raw]);
	}
	await assert.rejects(read(sse(["event: error\n\n"])), ImageFailure);
	const reports: unknown[] = [], controller = new AbortController();
	const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(frame(complete({ usage })))); },
		pull(c) { c.error(new Error("private-stream-secret")); } });
	await assert.rejects(readImageResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), controller.signal,
		expected(), raw => reports.push(raw)), error => error instanceof ImageFailure && !error.message.includes("private-stream-secret"));
	assert.equal(reports.length, 1); assert.equal(body.locked, false);
});

test("SSE 单事件、总字节和事件数有界；超限取消底层并释放 reader", async () => {
	assert.equal(MAX_SSE_EVENT_BYTES, 32 * 1024 * 1024);
	let cancelled = false;
	const tooMany = new Response(new ReadableStream<Uint8Array>({
		start(c) { c.enqueue(Buffer.from(": ping\n\n".repeat(1030))); }, cancel() { cancelled = true; },
	}), { headers: { "content-type": "text/event-stream" } });
	await assert.rejects(read(tooMany), /事件过多/); assert.equal(cancelled, true);
	const huge = new Response("", { headers: { "content-type": "text/event-stream", "content-length": String(4 * MAX_RESPONSE_BYTES + 65537) } });
	await assert.rejects(read(huge), /预算/);
	for (const singleEvent of [true, false]) {
		let count = 0, stopped = false;
		const piece = Buffer.from(":" + "x".repeat(1024 * 1024) + (singleEvent ? "" : "\n\n"));
		const body = new ReadableStream<Uint8Array>({ pull(c) { count++; c.enqueue(piece); }, cancel() { stopped = true; } });
		await assert.rejects(read(new Response(body, { headers: { "content-type": "text/event-stream" } })), singleEvent ? /单事件/ : /预算/);
		assert.equal(stopped, true); assert.equal(body.locked, false); assert.ok(count <= (singleEvent ? 34 : 130));
	}
});

test("严格 UTF-8、取消和不合作底层；已完成图片不能掩盖迟到错误/取消", async () => {
	for (const chunks of [[Buffer.from([0xff])], [frame(complete()), Buffer.from([0xc3])]]) await assert.rejects(read(sse(chunks)), /UTF-8/);
	for (const eol of ["\n", "\r\n", "\r"]) {
		const reports: unknown[] = [], final = complete({ usage });
		await assert.rejects(readImageResponse(sse([Buffer.concat([Buffer.from(frame(final, eol)), Buffer.from([255])])]),
			new AbortController().signal, expected(), raw => reports.push(raw)), /UTF-8/);
		assert.deepEqual(reports, [final]);
		assert.equal((await read(sse(["\ufeff" + frame(complete(), eol)]))).output.length, 1);
	}
	await assert.rejects(read(new Response("data: {}\n\n")), /不是 SSE/);
	for (const count of [1, 2]) {
		let cancelled = false;
		const controller = new AbortController(), reason = new Error("调用者取消"), final = complete({ usage });
		const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(frame(final))); },
			pull() { return new Promise(() => {}); }, cancel() { cancelled = true; return new Promise(() => {}); } });
		const reports: unknown[] = [];
		const pending = readImageResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }),
			controller.signal, expected({ count }), raw => reports.push(raw));
		await new Promise(resolve => setTimeout(resolve, 0)); controller.abort(reason);
		await assert.rejects(pending, error => error === reason);
		assert.deepEqual(reports, count === 1 ? [final] : [{ usage_reports: [usage] }]);
		assert.equal(cancelled, true); assert.equal(body.locked, false);
	}
});
