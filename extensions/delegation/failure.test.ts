import assert from "node:assert/strict";
import test from "node:test";
import { chatFailure } from "./failure.ts";

test("聊天通道只从安全错误前缀提取状态码，不回显上游正文", () => {
	const cases: Array<[string, number, string]> = [
		["HTTP 401 hidden-token", 401, "authentication"],
		["503 secret response body", 503, "http"],
		["tsgw API error (429): bearer hidden", 429, "rate_limit"],
		["429 private payload", 429, "rate_limit"],
	];
	for (const [message, statusCode, failureKind] of cases) {
		const failure = chatFailure(message);
		assert.equal(failure.statusCode, statusCode);
		assert.equal(failure.failureKind, failureKind);
		assert.doesNotMatch(JSON.stringify(failure), /hidden-token|secret response|bearer|private payload/);
	}
});

test("网络、超时与未知 SDK 错误均映射为安全的简短原因", () => {
	assert.deepEqual(chatFailure("Request timed out."), {
		failureKind: "timeout", reason: "聊天选型请求超时。",
	});
	assert.deepEqual(chatFailure("Connection error."), {
		failureKind: "network", reason: "聊天选型连接失败。",
	});
	for (const message of [undefined, "Bearer secret", 'payload mentions HTTP 503', "SDK failure token=private"]) {
		const failure = chatFailure(message);
		assert.equal(failure.failureKind, "unknown");
		assert.equal(failure.statusCode, undefined);
		assert.doesNotMatch(JSON.stringify(failure), /secret|private/);
	}
});
