import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { AssistantImages } from "@earendil-works/pi-ai";
import type { Static } from "typebox";
import type { TsgwImagesContext } from "./parameters.ts";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { registerImageTools, type ImageToolDetails } from "./tools.ts";
import { DEFAULT_IMAGE_MODEL, editImageSchema, generateImageSchema, imageToolResultSchema } from "./tool-schema.ts";
import { IMAGE_API, imageModelsForRoot } from "./models.ts";
import { Compile } from "typebox/compile";

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Registry = ExtensionToolContext["modelRegistry"];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const block = { type: "image" as const, data: PNG, mimeType: "image/png" };

function fixture(cwd = tmpdir()) {
	const tools: Tool[] = [];
	registerImageTools({ registerTool: tool => { tools.push(tool as Tool); } } as ExtensionAPI);
	const models = imageModelsForRoot("https://image-tools.invalid").map(model => ({ ...model, provider: "tsgw" as const }));
	let response: AssistantImages = { api: IMAGE_API, model: DEFAULT_IMAGE_MODEL, provider: "tsgw", timestamp: 0,
		output: [block], stopReason: "stop", usage };
	let available = true, thrown = false;
	const calls: { model: unknown; context: Parameters<Registry["generateImages"]>[1]; options: Parameters<Registry["generateImages"]>[2] }[] = [];
	const lookups: unknown[][] = [];
	const registry = {
		getModelOfType: (...args: unknown[]) => { lookups.push(args); return available ? models.find(model => model.id === args[2]) : undefined; },
		generateImages: async (model, context, options) => {
			calls.push({ model, context, options });
			if (thrown) throw new Error("private-provider-error https://private.invalid/?secret=credential");
			return response;
		},
	} satisfies Pick<Registry, "generateImages"> & { getModelOfType: (...args: unknown[]) => unknown };
	const ctx = { cwd, modelRegistry: registry } as unknown as ExtensionToolContext;
	return { tools, calls, lookups, ctx, registry,
		run: (args: unknown = { prompt: "合成测试，不请求网络" }, edit = false, signal?: AbortSignal) =>
			tools[edit ? 1 : 0].execute("call", args, signal, undefined, ctx),
		reply: (value: Partial<AssistantImages>) => { response = { ...response, ...value }; },
		missing: () => { available = false; }, throw: () => { thrown = true; },
	};
}
function details(result: Awaited<ReturnType<Tool["execute"]>>): ImageToolDetails {
	const value = result.details as ImageToolDetails;
	assert.deepEqual(result.structuredContent, value);
	assert.equal(Compile(imageToolResultSchema).Check(value), true);
	return value;
}
async function cleanup(result: Awaited<ReturnType<Tool["execute"]>>): Promise<void> {
	const paths = (result.details as ImageToolDetails).files.map(file => dirname(file.path));
	await Promise.all([...new Set(paths)].map(path => rm(path, { recursive: true, force: true })));
}

test("工具 direct 默认启用；普通生成仅 prompt 必填，编辑要求 images；schema不丢未知字段", () => {
	const f = fixture();
	assert.deepEqual(f.tools.map(tool => tool.name), ["tsgw_generate_image", "tsgw_edit_image"]);
	for (const tool of f.tools) {
		assert.equal(tool.exposure, "direct"); assert.equal(tool.defaultActive, true);
		assert.equal(tool.annotations?.openWorldHint, true);
		assert.match(tool.description, /Sunburst.*AI 草稿.*Flare/);
	}
	const generation = Compile(generateImageSchema), edit = Compile(editImageSchema);
	assert.equal(generation.Check({ prompt: "test" }), true);
	assert.equal(edit.Check({ prompt: "test" }), false);
	assert.equal(edit.Check({ prompt: "test", images: [{ path: "input.png" }] }), true);
	for (const input of [{ prompt: "test", unknown: 1 }, { prompt: "test", n: 1.5 }, { prompt: "test", model: "other" }])
		assert.equal(generation.Check(input), false);
	assert.equal(edit.Check({ prompt: "test", images: [{ path: "a", file_id: "b" }] }), false);
	assert.equal(generation.Check({ prompt: "test", n: null, stream: null }), true);
	const typed: Static<typeof generateImageSchema> = { prompt: "test", model: "gpt-image-2.5-flare", quality: "low",
		background: "transparent", output_format: "webp", moderation: "auto", n: 2, stream: true, partial_images: 1 };
	assert.equal(generation.Check(typed), true);
	// @ts-expect-error schema静态类型必须拒绝未知型号，而非never或任意string。
	const invalidModel: Static<typeof generateImageSchema>["model"] = "other";
	assert.equal(generation.Check({ prompt: "test", model: invalidModel }), false);
});

test("默认Sunburst与auto通过context.tsgw；600000超时、实际图片块和原始usage/文件", async (t) => {
	t.mock.method(globalThis, "fetch", () => { throw new Error("工具不得直接请求网络"); });
	const f = fixture();
	const result = await f.run();
	try {
		assert.equal(result.isError, undefined);
		assert.equal(result.usage, usage);
		assert.deepEqual(f.lookups, [["image", "tsgw", DEFAULT_IMAGE_MODEL]]);
		assert.deepEqual(f.calls[0].context, { input: [{ type: "text", text: "合成测试，不请求网络" }], tsgw: {
			operation: "generate", quality: "auto", size: "auto", background: "auto", output_format: "png", n: 1,
			moderation: "auto", stream: false, partial_images: 0,
		} });
		assert.equal(f.calls[0].options?.timeoutMs, 600_000);
		assert.ok(f.calls[0].options?.signal);
		assert.deepEqual(result.content.filter(part => part.type === "image"), [block]);
		const info = details(result);
		assert.equal(info.phase, "complete"); assert.equal(info.requestStatus, "succeeded");
		assert.match(info.files[0].path, /tsgw-images-.*[/\\]1\.png$/);
		assert.deepEqual(await readFile(info.files[0].path), Buffer.from(PNG, "base64"));
		assert.doesNotMatch(JSON.stringify(info), new RegExp(PNG));
	} finally { await cleanup(result); }
});

test("完整可选参数、Flare与显式延长超时传递；多图输出分别保存且调用间路径唯一", async () => {
	const f = fixture();
	f.reply({ output: [block, block] });
	const args = { prompt: "draft", model: "gpt-image-2.5-flare", quality: "low", size: "1024x1024", background: "opaque",
		output_format: "png", n: 2, moderation: "low", stream: true, partial_images: 3, safety_identifier: "synthetic", user: "compat", timeout_ms: 900_000 };
	const first = await f.run(args), second = await f.run(args);
	try {
		assert.equal(first.isError, undefined); assert.equal(second.isError, undefined);
		assert.equal(f.calls.length, 2);
		assert.equal(f.calls[0].options?.timeoutMs, 900_000);
		const { prompt: _p, model: _m, timeout_ms: _t, ...parameters } = args;
		assert.deepEqual(f.calls[0].context, { input: [{ type: "text", text: "draft" }], tsgw: { operation: "generate", ...parameters } });
		assert.equal(details(first).files.length, 2);
		assert.equal(new Set([...details(first).files, ...details(second).files].map(file => file.path)).size, 4);
	} finally { await cleanup(first); await cleanup(second); }
});

test("JPEG/WebP格式与压缩参数完整传递，原始多格式字节保存正确扩展名", async () => {
	// 仅容器夹具；工具/inspectImage不承诺完整像素解码。
	const table = (id: number) => Buffer.from([id, 1, ...Array(15).fill(0), 0]);
	const jpeg = Buffer.concat([Buffer.from([255, 216, 255, 219, 0, 67, 0]), Buffer.alloc(64, 1),
		Buffer.from([255, 196, 0, 38]), table(0), table(16),
		Buffer.from([255, 192, 0, 11, 8, 0, 1, 0, 1, 1, 1, 17, 0, 255, 218, 0, 8, 1, 1, 0, 0, 63, 0, 1, 255, 217])]);
	const webp = Buffer.from("5249464612000000574542505650384c060000002f0000000000", "hex");
	for (const [format, bytes] of [["jpeg", jpeg], ["webp", webp]] as const) {
		const f = fixture();
		f.reply({ output: [{ type: "image", data: bytes.toString("base64"), mimeType: `image/${format}` }] });
		const result = await f.run({ prompt: "test", output_format: format, output_compression: 75 });
		try {
			assert.equal(result.isError, undefined, JSON.stringify(result));
			assert.equal((f.calls[0].context as TsgwImagesContext).tsgw?.output_compression, 75);
			assert.ok(details(result).files[0].path.endsWith(`.${format}`));
			assert.deepEqual(await readFile(details(result).files[0].path), bytes);
		} finally { await cleanup(result); }
	}
});

test("编辑原始文件和mask保真，不向结构化结果泄露引用、URL或base64", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "image-tool-test-"));
	try {
		await writeFile(join(cwd, "original.jpg"), Buffer.from(PNG, "base64"));
		const f = fixture(cwd);
		const url = "https://reference.invalid/image?sensitive=temporary-token";
		const result = await f.run({ prompt: "edit", images: [{ path: "original.jpg" }, { image_url: url }, { file_id: "file-test" }], mask: { path: "original.jpg" } }, true);
		try {
			assert.equal(result.isError, undefined);
			const reference = { image_url: `data:image/png;base64,${PNG}` };
			assert.deepEqual((f.calls[0].context as TsgwImagesContext).tsgw, {
				operation: "edit", quality: "auto", size: "auto", background: "auto", output_format: "png", n: 1,
				moderation: "auto", stream: false, partial_images: 0,
				images: [reference, { image_url: url }, { file_id: "file-test" }], mask: reference,
			});
			assert.doesNotMatch(JSON.stringify(details(result)), /temporary-token|base64|original\.jpg/);
			assert.deepEqual(await readFile(join(cwd, "original.jpg")), Buffer.from(PNG, "base64"));
		} finally { await cleanup(result); }
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("runtime拒绝未知参数和非法组合，模型过滤/预取消/非法来源在调用前失败", async () => {
	for (const args of [
		{ prompt: "test", unknown: true }, { prompt: "x".repeat(32_001) }, { prompt: "test", response_format: "b64_json" }, { prompt: "test", style: "vivid" },
		{ prompt: "test", input_fidelity: "high" }, { prompt: "test", n: 0 }, { prompt: "test", n: 11 }, { prompt: "test", quality: "hd" },
		{ prompt: "test", output_compression: 80 }, { prompt: "test", output_format: "jpeg", background: "transparent" },
		{ prompt: "test", timeout_ms: Infinity }, { prompt: "test", timeout_ms: 2_147_483_648 }, { prompt: "test", partial_images: 1 },
		{ prompt: "test", model: "gpt-image-other" }, { prompt: "test", images: [{ file_id: "file-test" }] },
	]) {
		const f = fixture();
		assert.equal((await f.run(args)).isError, true); assert.equal(f.calls.length, 0);
	}
	const filtered = fixture(); filtered.missing();
	const missing = await filtered.run(); assert.equal(details(missing).error?.code, "model-unavailable"); assert.equal(filtered.calls.length, 0);
	const cancelled = fixture(); assert.equal((await cancelled.run(undefined, false, AbortSignal.abort())).isError, true); assert.equal(cancelled.calls.length, 0);
	const edit = fixture();
	for (const images of [[], Array(17).fill({ file_id: "file-test" }), [{ path: "/secret-missing", file_id: "file-test" }], [{ image_url: "https://user:secret@private.invalid/" }]]) {
		const result = await edit.run({ prompt: "edit", images }, true);
		assert.equal(result.isError, true); assert.equal(details(result).requestStatus, "not-started");
		assert.doesNotMatch(JSON.stringify(result), /secret-missing|user:secret/);
	}
	assert.equal(edit.calls.length, 0);
});

test("失败、取消、坏图、数量/格式错误保留usage，脱敏且不自动重试", async () => {
	for (const response of [
		{ stopReason: "error", errorMessage: "secret-provider-error" }, { stopReason: "aborted" },
		{ output: [] }, { output: [block, block] }, { output: [{ ...block, data: "invalid-base64" }] }, { output: [{ ...block, mimeType: "image/jpeg" }] },
	] as Partial<AssistantImages>[]) {
		const f = fixture(); f.reply(response);
		const result = await f.run();
		assert.equal(result.isError, true); assert.equal(result.usage, usage); assert.equal(f.calls.length, 1);
		assert.equal(result.content.filter(part => part.type === "image").length, 0);
		assert.doesNotMatch(JSON.stringify(result), /secret-provider-error|invalid-base64/);
		if (!response.stopReason) { assert.equal(details(result).phase, "output"); assert.equal(details(result).requestStatus, "succeeded"); }
		else {
			assert.equal(details(result).requestStatus, "unknown");
			assert.match(details(result).error!.message, /计费/);
		}
	}
	const f = fixture(); f.throw();
	const unknown = await f.run(); assert.equal(unknown.isError, true); assert.equal(details(unknown).requestStatus, "unknown");
	assert.doesNotMatch(JSON.stringify(unknown), /private-provider-error|credential|private\.invalid/);
	assert.equal(f.calls.length, 1);
});

test("调用中取消传播两个signal，仍保留上游返回的usage", async () => {
	const f = fixture();
	const outer = new AbortController(), caller = new AbortController();
	f.ctx.signal = outer.signal;
	f.registry.generateImages = async (_model, _context, options) => {
		await new Promise<void>(resolve => { options!.signal!.addEventListener("abort", () => resolve(), { once: true }); caller.abort(); });
		return { api: IMAGE_API, model: DEFAULT_IMAGE_MODEL, provider: "tsgw", timestamp: 0, output: [], stopReason: "aborted", usage };
	};
	const result = await f.run(undefined, false, caller.signal);
	assert.equal(result.isError, true); assert.equal(result.usage, usage); assert.equal(details(result).requestStatus, "unknown");
});

test("保存失败明确上游已成功，保留实际图片和usage，不重试、不泄露原始磁盘错误", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "image-save-test-"));
	const probe = await open(join(cwd, "probe"), "wx");
	try {
		const prototype = Object.getPrototypeOf(probe);
		t.mock.method(prototype, "writeFile", async () => { throw new Error("private-disk-path-and-token"); });
		const f = fixture();
		const result = await f.run();
		assert.equal(result.isError, true); assert.equal(result.usage, usage);
		assert.equal(details(result).phase, "save"); assert.equal(details(result).requestStatus, "succeeded");
		assert.equal(details(result).error?.code, "save-failed");
		assert.deepEqual(result.content.filter(part => part.type === "image"), [block]);
		assert.equal(f.calls.length, 1); assert.doesNotMatch(JSON.stringify(result), /private-disk-path-and-token/);
	} finally { await probe.close(); await rm(cwd, { recursive: true, force: true }); }
});
