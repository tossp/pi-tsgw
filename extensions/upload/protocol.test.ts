import assert from "node:assert/strict";
import { test } from "node:test";
import { UploadError } from "./errors.ts";
import { decodeReceipt, download, encodeReceipt, MAX_BYTES, mcpData, plan, planIdentity, SINGLE_LIMIT, validKey, type Receipt } from "./protocol.ts";

const expiresAt = "2099-01-01T00:00:00.000Z";
const uid = "01900000-0000-7000-8000-000000000001";
const size = SINGLE_LIMIT + 1;
const partSize = 16 * 1024 ** 2;
const link = { key: "files/example.bin", url: "https://storage.example/files/example.bin?signature=download", expiresAt, expiresIn: 86400 };
function multipart(numbers = [1, 2, 3]) {
	return { ...link, uid, mode: "multipart", uploaded: numbers.length === 0, partSize, totalParts: 3,
		remainingParts: numbers.length, uploads: numbers.map(partNumber => ({ partNumber,
			offset: (partNumber - 1) * partSize, size: Math.min(partSize, size - (partNumber - 1) * partSize),
			url: `https://storage.example/part?signature=secret&part=${partNumber}`, method: "PUT",
			headers: { "content-type": "application/octet-stream" }, expiresAt })) };
}
const receipt: Receipt = { version: 1, key: link.key, uid, mode: "multipart", phase: "upload", fingerprint: "a".repeat(64),
	metadata: { filename: "example.bin", contentType: "application/octet-stream", size, mtimeMs: 1, ctimeMs: 2 } };
const invalid = (fn: () => unknown, code = "invalid-response") => assert.throws(fn, (e: unknown) => e instanceof UploadError && e.code === code);

test("MCP 仅接受当前结构化结果或单个 JSON 文本块", () => {
	assert.deepEqual(mcpData({ structuredContent: link }), link);
	assert.deepEqual(mcpData({ content: [{ type: "text", text: JSON.stringify(link) }] }), link);
	assert.deepEqual(mcpData({ structuredContent: link, content: [{ type: "text", text: "not JSON" }] }), link);
	for (const raw of [null, [], {}, { result: { structuredContent: link } }, { structuredContent: [] },
		{ content: [{ type: "text", text: "secret" }] }, { content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }] }]) invalid(() => mcpData(raw));
});

test("MCP 错误经过脱敏，且仅明确的 not-found 允许恢复", () => {
	for (const code of ["not-found", "NoSuchKey", "secret-token"]) {
		assert.throws(() => mcpData({ isError: true, structuredContent: { error: { code, message: "credential=secret" } } }),
			(e: unknown) => e instanceof UploadError && e.code === (code === "not-found" ? code : "mcp-error") && !e.message.includes("secret"));
	}
	invalid(() => mcpData({ structuredContent: { error: "secret" } }), "mcp-error");
});

test("下载结果校验 key、HTTPS、到期时间和请求的有效期", () => {
	assert.deepEqual(download(link, link.key), link);
	assert.equal(download({ ...link, expiresIn: 60 }, link.key, 60).expiresIn, 60);
	for (const key of ["", "/a", "a/", "a//b", "a/../b", "a/./b", "a%2Fb", "a?b", "a#b", "a\\b", "a\u0000b"]) invalid(() => validKey(key));
	for (const url of ["http://storage.example/a", "https://u:p@storage.example/a", "https://storage.example:444/a", "https://storage.example/a#secret", "nonsense"]) invalid(() => download({ ...link, url }));
	for (const patch of [{ key: "other" }, { expiresIn: 60 }, { expiresIn: 0 }, { expiresAt: "never" }]) invalid(() => download({ ...link, ...patch }, link.key));
});

test("分片布局校验接受完整计划、缺失分片子集及最终计划", () => {
	for (const numbers of [[1, 2, 3], [3, 1], [2], []]) {
		const parsed = plan(multipart(numbers), size, receipt);
		assert.deepEqual(parsed.uploads.map(p => p.partNumber), numbers);
		assert.equal(parsed.uploaded, numbers.length === 0);
	}
	const target = multipart().uploads[0]!;
	const single = { ...link, mode: "single", uploaded: false, uploads: [{ ...target, offset: 0, size: 3 }] };
	assert.equal(plan(single, 3).mode, "single");
	invalid(() => plan({ ...single, uploaded: true, uploads: [] }, 3));
	invalid(() => plan({ ...link, uploadUrl: target.url }, 3));
});

test("拒绝模式、身份、分片布局、目标或请求头畸形的计划", () => {
	const patches = [
		{ mode: "single" }, { uploaded: "false" }, { uploaded: true }, { uploads: [] }, { uploads: null },
		{ uid: "not-a-uuid" }, { uid: "01900000-0000-4000-8000-000000000001" },
		{ partSize: 1 }, { partSize: 5 * 1024 ** 3 + 1 }, { totalParts: 4 }, { remainingParts: 2 },
		{ uploads: [multipart().uploads[0], multipart().uploads[0]], remainingParts: 2 },
	];
	for (const patch of patches) invalid(() => plan({ ...multipart(), ...patch }, size));
	for (const patch of [{ partNumber: 0 }, { partNumber: 4 }, { offset: 1 }, { size: 1 }, { method: "POST" },
		{ url: "https://other.example/part" }, { headers: { authorization: 3 } }, { headers: [] }, { expiresAt: "bad" }]) {
		const body = multipart([1]);
		invalid(() => plan({ ...body, uploads: [{ ...body.uploads[0], ...patch }] }, size));
	}
	invalid(() => plan({ ...multipart(), key: "new/key" }, size, receipt), "session-changed");
	invalid(() => plan({ ...multipart(), uid: "01900000-0000-7000-8000-000000000002" }, size, receipt));
});

test("下载字段畸形时保留计划身份，且不削弱身份校验", () => {
	for (const uploaded of [false, true]) {
		for (const patch of [{ url: undefined }, { url: "http://invalid.example/secret" }, { expiresAt: "invalid" }, { expiresIn: 0 }]) {
			const body = { ...multipart(uploaded ? [] : [3]), ...patch };
			assert.deepEqual(planIdentity(body, size, receipt), { key: link.key, mode: "multipart", uploaded, uid, partSize, totalParts: 3 });
			invalid(() => plan(body, size, receipt));
		}
	}
	invalid(() => planIdentity({ ...multipart([]), key: "other/key", url: undefined }, size, receipt), "session-changed");
	for (const patch of [{ uploaded: true }, { mode: "single" }, { uid: "bad" }, { totalParts: 99 }]) {
		invalid(() => planIdentity({ ...multipart(), ...patch, url: undefined }, size, receipt));
	}
});

test("凭条编解码往返保留元数据和身份，但绝不包含传输凭据", () => {
	const token = encodeReceipt(receipt);
	assert.deepEqual(decodeReceipt(token), receipt);
	const text = Buffer.from(token, "base64url").toString();
	assert.doesNotMatch(text, /https:|signature|headers|authorization|password/i);
	const external = Buffer.from(JSON.stringify({ ...receipt, url: "secret", headers: { authorization: "secret" } })).toString("base64url");
	assert.deepEqual(decodeReceipt(external), receipt);
});

test("无效凭条不能悄然触发全新上传", () => {
	for (const token of ["", "!", "a".repeat(8193), Buffer.from("{}").toString("base64url")]) invalid(() => decodeReceipt(token), "invalid-resume");
	for (const patch of [{ version: 2 }, { phase: "prepare" }, { mode: "single" }, { fingerprint: "bad" }, { key: "../key" },
		{ metadata: { ...receipt.metadata, size: 0 } }, { metadata: { ...receipt.metadata, size: MAX_BYTES + 1 } },
		{ metadata: { ...receipt.metadata, mtimeMs: null } }]) {
		invalid(() => decodeReceipt(Buffer.from(JSON.stringify({ ...receipt, ...patch })).toString("base64url")), "invalid-resume");
	}
});
