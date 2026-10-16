import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments, type JsonObject } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { registerUploadTool } from "./index.ts";
import { decodeReceipt, encodeReceipt, type Receipt } from "./protocol.ts";
import { openLocalFile } from "./local-file.ts";
import { uploadLocalFile, type UploadDependencies } from "./uploader.ts";

let tool!: Pick<Parameters<ExtensionAPI["registerTool"]>[0], "name" | "description" | "parameters" | "outputSchema">;
registerUploadTool({ registerTool: value => { tool = value; } } as ExtensionAPI);
const validate = (args: JsonObject): Record<string, unknown> => validateToolArguments(tool, {
	type: "toolCall", id: "validation-fixture", name: tool.name, arguments: args,
});
const receipt: Receipt = {
	version: 1, key: "fixture/report.txt", mode: "single", phase: "upload", fingerprint: "a".repeat(64),
	metadata: { filename: "report.txt", contentType: "text/plain", size: 3, mtimeMs: 1, ctimeMs: 1 },
};

test("上传工具暴露的输入与输出 schema 均不包含 lookaround", () => {
	const check = (value: unknown): void => {
		if (!value || typeof value !== "object") return;
		for (const [key, child] of Object.entries(value)) {
			if (key === "pattern" && typeof child === "string")
				assert.doesNotMatch(child, /\(\?(?:[=!]|<[=!])/);
			check(child);
		}
	};
	check(tool.parameters);
	check(tool.outputSchema);
});

// 将原始 schema 校验与 Pi 会进行类型转换的输入流水线分开测试。
test("上传输入 schema 约束 MIME、凭条字符集及长度和有效期范围", () => {
	const valid = { path: "report.txt", contentType: "Text/Plain", resume: encodeReceipt(receipt), expiresIn: 3600 };
	assert.equal(Value.Check(tool.parameters, valid), true);
	assert.deepEqual(validate(valid), valid);
	for (const patch of [
		{ path: "" }, { contentType: "bad" }, { contentType: "text/plain; charset=utf-8" },
		{ contentType: "text/\r\nsecret" },
		{ contentType: "a/" + "a".repeat(126) },
		{ resume: "" }, { resume: "a=" }, { resume: "a/b" }, { resume: "a b" }, { resume: "a".repeat(8193) },
		{ expiresIn: 0 }, { expiresIn: 604801 }, { expiresIn: 1.5 }, { expiresIn: "3600" },
	]) assert.equal(Value.Check(tool.parameters, { ...valid, ...patch }), false, JSON.stringify(patch));
	for (const patch of [{ contentType: "bad" }, { resume: "a=" }, { expiresIn: 0 }, { expiresIn: 604801 }] as JsonObject[])
		assert.throws(() => validate({ path: "report.txt", ...patch }), /Validation failed/);
});

test("真实 Pi 校验器规范化可选 null、字符串和整数参数，且不修改原始输入", () => {
	const args = { path: "report.txt", expiresIn: 1.5, contentType: null, resume: null };
	assert.deepEqual(validate(args), { path: "report.txt", expiresIn: 1 });
	assert.equal(args.expiresIn, 1.5);
	assert.equal(args.contentType, null);
	assert.deepEqual(validate({ path: "report.txt", expiresIn: "3600" }), { path: "report.txt", expiresIn: 3600 });
	assert.deepEqual(validate({ path: "report.txt", expiresIn: null, disposition: null }), { path: "report.txt" });
});

test("实际上传成功、安全失败、PUT 结果未知、链接失败和恢复结果均符合输出 schema", async t => {
	const cwd = await mkdtemp(join(tmpdir(), "tsgw-upload-schema-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(join(cwd, "report.txt"), "abc");
	const link = { key: receipt.key, url: "https://schema-fixture.invalid/report?download=fixture",
		expiresAt: "2099-01-01T00:00:00.000Z", expiresIn: 86400 };
	const plan = { ...link, mode: "single", uploaded: false, uploads: [{ partNumber: 1, offset: 0, size: 3,
		url: "https://schema-fixture.invalid/report?put=fixture", method: "PUT", headers: {}, expiresAt: link.expiresAt }] };
	const check = (result: unknown) => {
		assert.ok(tool.outputSchema);
		assert.equal(Value.Check(tool.outputSchema, result), true, JSON.stringify(result));
	};
	const deps: UploadDependencies = { call: async () => ({ structuredContent: plan }), put: async () => {} };
	const signal = () => new AbortController().signal;
	const success = await uploadLocalFile({ path: "report.txt" }, cwd, signal(), deps);
	assert.equal(success.uploaded, true); check(success);
	const invalid = await uploadLocalFile({ path: "report.txt", expiresIn: 1.5 }, cwd, signal(), deps);
	assert.equal(invalid.error?.code, "invalid-options"); check(invalid);
	// schema 的 `$` 在不同正则引擎中语义不同；执行层必须拒绝所有末尾行终止符。
	for (const mime of ["text/plain\n", "text/plain\r", "text/plain\r\n", "text/plain\u2028", "text/plain\u2029"])
		await assert.rejects(openLocalFile("report.txt", cwd, mime), /MIME 类型/);
	for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029"])
		assert.throws(() => decodeReceipt(encodeReceipt(receipt) + suffix), /恢复凭条无效/);
	// 字符集和长度提示不等于凭条认证，也不等于 JSON 或内容校验。
	const malformed = await uploadLocalFile({ path: "missing.txt", resume: "bm90LWpzb24" }, cwd, signal(), {
		call: async () => assert.fail("畸形凭条不得联系 MCP"),
		put: async () => assert.fail("畸形凭条不得执行 PUT"),
	});
	assert.equal(malformed.error?.code, "invalid-resume"); check(malformed);
	const uncertain = await uploadLocalFile({ path: "report.txt" }, cwd, signal(), {
		...deps, put: async () => { throw new Error("private transport error"); },
	});
	assert.equal(uncertain.uploaded, null);
	assert.equal(typeof uncertain.resume, "string"); check(uncertain);
	assert.equal(Value.Check(tool.parameters, { path: "report.txt", resume: uncertain.resume }), true);
	const failedLink = await uploadLocalFile({ path: "report.txt", disposition: "attachment" }, cwd, signal(), {
		...deps, call: async name => ({ structuredContent: name.endsWith("upload_file") ? plan : { error: { code: "denied" } } }),
	});
	assert.equal(failedLink.uploaded, true);
	assert.equal(failedLink.linkStatus, "failed");
	assert.ok(failedLink.fallback); check(failedLink);
	const recovered = await uploadLocalFile({ path: "missing.txt", resume: uncertain.resume }, cwd, signal(), {
		call: async name => { assert.ok(name.endsWith("get_file_url")); return { structuredContent: link }; },
		put: async () => assert.fail("恢复时不得执行 PUT"),
	});
	assert.equal(recovered.uploaded, true); check(recovered);
	assert.equal(JSON.stringify(uncertain).includes("private transport error"), false);
	assert.equal(Value.Check(tool.outputSchema!, { ...success, uploaded: "yes" }), false);
	assert.equal(Value.Check(tool.outputSchema!, { ...failedLink, fallback: { ...link, expiresIn: "bad" } }), false);
});
