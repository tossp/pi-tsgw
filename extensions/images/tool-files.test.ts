import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { inspectImage } from "#tsgw/models/adapter/images/image-data";
import { ImageToolFileError, MAX_INPUT_FILE_BYTES, MAX_INPUT_TOTAL_BYTES, resolveImageSources, saveImageOutput, validateImageOutput } from "./tool-files.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const BYTES = Buffer.from(PNG, "base64");
const WEBP = Buffer.from("5249464612000000574542505650384c060000002f0000000000", "hex");
const signal = () => new AbortController().signal;
const crcTable = Array.from({ length: 256 }, (_, n) => {
	for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
	return n >>> 0;
});
function crc(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = (value >>> 8) ^ crcTable[(value ^ byte) & 255];
	return (value ^ 0xffffffff) >>> 0;
}
function sizedPng(width: number, height: number): Buffer {
	const bytes = Buffer.from(BYTES);
	bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
	bytes.writeUInt32BE(crc(bytes.subarray(12, 29)), 29);
	return bytes;
}
function paddedPng(size: number): Buffer {
	const chunk = Buffer.alloc(size + 12);
	chunk.writeUInt32BE(size, 0); chunk.write("tEXt", 4);
	chunk.writeUInt32BE(crc(chunk.subarray(4, -4)), chunk.length - 4);
	return Buffer.concat([BYTES.subarray(0, -12), chunk, BYTES.subarray(-12)]);
}
async function expectSafeError(action: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(action, error => {
		assert.ok(error instanceof ImageToolFileError);
		assert.equal(error.code, code);
		assert.doesNotMatch(error.message, /base64,|private-secret|ENOENT|EACCES/);
		return true;
	});
}

test("本地输入按真实格式读取原bytes，允许OS可访问的相对/绝对/符号链接路径，不声称沙箱", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "image-input-test-"));
	try {
		const misleading = join(cwd, "original.jpeg");
		await writeFile(misleading, BYTES); await symlink(misleading, join(cwd, "link"));
		const inputs = await resolveImageSources([{ path: "original.jpeg" }, { path: misleading }, { path: "link" }], undefined, cwd, signal());
		assert.deepEqual(inputs.images, Array(3).fill({ image_url: `data:image/png;base64,${PNG}` }));
		assert.deepEqual(await readFile(misleading), BYTES);
		const before = await stat(misleading);
		assert.equal(before.size, BYTES.length);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("目录/FIFO/不存在路径/过大或空文件被安全拒绝，FIFO不能挂起", { timeout: 2000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "image-special-test-"));
	try {
		await expectSafeError(resolveImageSources([{ path: cwd }], undefined, cwd, signal()), "not-file");
		await expectSafeError(resolveImageSources([{ path: "private-secret-missing" }], undefined, cwd, signal()), "file-unavailable");
		const empty = join(cwd, "empty"); await writeFile(empty, Buffer.alloc(0));
		await expectSafeError(resolveImageSources([{ path: empty }], undefined, cwd, signal()), "input-too-large");
		const large = join(cwd, "large"); await writeFile(large, Buffer.alloc(0)); await truncate(large, MAX_INPUT_FILE_BYTES);
		await expectSafeError(resolveImageSources([{ path: large }], undefined, cwd, signal()), "input-too-large");
		if (process.platform !== "win32") {
			const fifo = join(cwd, "fifo"); execFileSync("mkfifo", [fifo]);
			await expectSafeError(resolveImageSources([{ path: fifo }], undefined, cwd, signal()), "not-file");
		}
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("读取期间文件被更改即失败，不提交截断或混合bytes", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "image-race-test-"));
	let probe: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const path = join(cwd, "input.png"); await writeFile(path, BYTES);
		probe = await open(path, "r");
		const prototype = Object.getPrototypeOf(probe);
		const original = prototype.read;
		t.mock.method(prototype, "read", async function (this: unknown, ...args: unknown[]) {
			const result = await original.apply(this, args);
			await truncate(path, 0);
			return result;
		});
		await expectSafeError(resolveImageSources([{ path }], undefined, cwd, signal()), "file-changed");
	} finally { await probe?.close(); await rm(cwd, { recursive: true, force: true }); }
});

test("本地mask保持alpha和原bytes，尺寸或格式不匹配/无alpha均拒绝；远程引用不下载", async (t) => {
	t.mock.method(globalThis, "fetch", () => { throw new Error("不能下载远程引用"); });
	const cwd = await mkdtemp(join(tmpdir(), "image-mask-test-"));
	try {
		await writeFile(join(cwd, "original"), BYTES);
		await writeFile(join(cwd, "wide"), sizedPng(2, 1));
		await writeFile(join(cwd, "opaque"), WEBP);
		const local = [{ path: "original" }];
		const good = await resolveImageSources(local, { path: "original" }, cwd, signal());
		assert.deepEqual(good.mask, good.images[0]);
		assert.equal(inspectImage(PNG).hasAlpha, true);
		await expectSafeError(resolveImageSources(local, { path: "wide" }, cwd, signal()), "invalid-mask");
		await expectSafeError(resolveImageSources(local, { path: "opaque" }, cwd, signal()), "invalid-mask");
		await expectSafeError(resolveImageSources([{ path: "opaque" }], { path: "original" }, cwd, signal()), "invalid-mask");
		const url = "https://reference.invalid/private-secret";
		assert.deepEqual(await resolveImageSources([{ image_url: url }], { file_id: "remote-mask" }, cwd, signal()), {
			images: [{ image_url: url }], mask: { file_id: "remote-mask" },
		});
		assert.deepEqual((await resolveImageSources(Array(16).fill({ file_id: "remote" }), { file_id: "mask" }, cwd, signal())).images.length, 16);
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("内联data URI仍按原bytes与MIME校验，来源必须唯一且非空；坏图不修复", async () => {
	const valid = { image_url: `data:image/png;base64,${PNG}` };
	assert.deepEqual((await resolveImageSources([valid], valid, tmpdir(), signal())).images, [valid]);
	for (const value of [
		{}, null, "path", { path: "a", image_url: "https://example.invalid" }, { file_id: "" }, { image_url: "file:///private-secret" },
		{ image_url: "https://user:private-secret@example.invalid" }, { path: "a", extra: 1 }, { image_url: "data:image/png;base64,AAAA" },
		{ image_url: `data:image/jpeg;base64,${PNG}` }, { image_url: `data:image/png;base64,${PNG}\n` },
	]) {
		await assert.rejects(resolveImageSources([value], undefined, tmpdir(), signal()), error => {
			assert.ok(error instanceof ImageToolFileError);
			assert.doesNotMatch(error.message, /private-secret|base64,|AAAA/);
			return true;
		});
	}
	await assert.rejects(resolveImageSources([valid], undefined, tmpdir(), AbortSignal.abort()));
});

test("输入参考图尺寸不受输出上限限制；输出必须满足数量、格式、容器与尺寸", async () => {
	const large = sizedPng(4000, 16), data = large.toString("base64");
	const reference = { image_url: `data:image/png;base64,${data}` };
	assert.deepEqual((await resolveImageSources([reference], undefined, tmpdir(), signal())).images, [reference]);
	assert.throws(() => validateImageOutput([{ type: "image", data, mimeType: "image/png" }], 1, "png"), /MIME 或尺寸/);
	const image = { type: "image" as const, data: PNG, mimeType: "image/png" };
	assert.deepEqual(validateImageOutput([image, image], 2, "png"), [image, image]);
	for (const output of [[], [image, image], [{ ...image, type: "text" }], [{ ...image, data: "broken" }]])
		assert.throws(() => validateImageOutput(output, 1, "png"), ImageToolFileError);
	assert.throws(() => validateImageOutput([image], 1, "webp"), ImageToolFileError);
});

test("所有参考图和mask共享总字节预算，不能用每文件限制绕过", { timeout: 20_000 }, async () => {
	const cwd = await mkdtemp(join(tmpdir(), "image-budget-test-"));
	try {
		const bytes = paddedPng(7_000_000);
		assert.ok(bytes.length < MAX_INPUT_FILE_BYTES);
		assert.ok(bytes.length * 15 > MAX_INPUT_TOTAL_BYTES);
		await writeFile(join(cwd, "input.png"), bytes);
		await expectSafeError(resolveImageSources(Array(14).fill({ path: "input.png" }), { path: "input.png" }, cwd, signal()), "input-too-large");
	} finally { await rm(cwd, { recursive: true, force: true }); }
});

test("临时输出独占路径、正确扩展名/权限与原字节，绝不覆盖先前结果", async () => {
	const image = { type: "image" as const, data: PNG, mimeType: "image/png" };
	const first = await saveImageOutput([image]), second = await saveImageOutput([image]);
	try {
		assert.notEqual(first[0].path, second[0].path);
		for (const files of [first, second]) {
			assert.match(files[0].path, /\.png$/);
			assert.deepEqual(await readFile(files[0].path), BYTES);
			if (process.platform !== "win32") {
				assert.equal((await stat(files[0].path)).mode & 0o777, 0o600);
				assert.equal((await stat(dirname(files[0].path))).mode & 0o777, 0o700);
			}
		}
	} finally { await rm(dirname(first[0].path), { recursive: true, force: true }); await rm(dirname(second[0].path), { recursive: true, force: true }); }
});

test("部分保存失败返回已经写好的文件，不丢失成功阶段或暴露底层错误", async (t) => {
	const cwd = await mkdtemp(join(tmpdir(), "image-partial-save-test-"));
	const probe = await open(join(cwd, "probe"), "wx");
	let saved: string | undefined;
	try {
		const prototype = Object.getPrototypeOf(probe), original = prototype.writeFile;
		let calls = 0;
		t.mock.method(prototype, "writeFile", async function (this: unknown, ...args: unknown[]) {
			if (++calls === 2) throw new Error("private-secret-disk-error");
			return original.apply(this, args);
		});
		const image = { type: "image" as const, data: PNG, mimeType: "image/png" };
		let failure: unknown;
		try { await saveImageOutput([image, image]); } catch (error) { failure = error; }
		assert.ok(failure instanceof ImageToolFileError); assert.equal(failure.code, "save-failed");
		assert.equal(failure.files.length, 1); saved = dirname(failure.files[0].path);
		assert.deepEqual(await readFile(failure.files[0].path), BYTES);
		assert.doesNotMatch(failure.message, /private-secret-disk-error/);
	} finally {
		await probe.close(); await rm(cwd, { recursive: true, force: true });
		if (saved) await rm(saved, { recursive: true, force: true });
	}
});
