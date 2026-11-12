import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FakePi, TEST_ROOT, TSGW_SOL } from "#tsgw/test-support.test";
import { registerGatewayTracing } from "./tracing.ts";

type Headers = Record<string, string | null>;
function setup(root = TEST_ROOT) {
	const pi = new FakePi();
	const manager = SessionManager.inMemory();
	const ctx = { model: { ...TSGW_SOL }, sessionManager: manager };
	registerGatewayTracing(pi as unknown as ExtensionAPI, root);
	const emit = (name: Parameters<FakePi["invoke"]>[0]) => pi.invoke(name, { type: name }, ctx);
	const headers = (initial: Headers = {}) => {
		pi.invoke("before_provider_headers", { type: "before_provider_headers", headers: initial }, ctx);
		return initial;
	};
	emit("session_start");
	return { pi, ctx, manager, emit, headers };
}

function user(manager: SessionManager) {
	return manager.appendMessage({ role: "user", content: "合成测试输入", timestamp: 1 });
}

test("会话头使用宿主身份，消息头随实际用户entry而非agent_start变化", () => {
	const s = setup();
	const id = s.manager.getSessionId();
	assert.deepEqual(s.headers(), { "AH-Thread-Id": id, "X-Magpie-Session": id });
	const first = user(s.manager);
	s.emit("agent_start");
	const expected = { "AH-Thread-Id": id, "X-Magpie-Session": id, "AH-Trace-Id": `${id}.${first}` };
	assert.deepEqual(s.headers(), expected);
	// 同消息工具往返、自动重试不改变身份。
	s.manager.appendMessage({ role: "toolResult", toolCallId: "synthetic-tool", toolName: "fixture", content: [], isError: false, timestamp: 2 });
	s.emit("agent_start");
	s.emit("turn_start");
	assert.deepEqual(s.headers(), expected);
	// steer/follow-up无需重新agent_start，入库后即应换消息身份。
	const second = user(s.manager);
	assert.deepEqual(s.headers(), { ...expected, "AH-Trace-Id": `${id}.${second}` });
});

test("当前分支回溯不使用其他分支，附加上下文不改变用户消息归属", () => {
	const s = setup();
	const first = user(s.manager);
	const second = user(s.manager);
	s.manager.branch(first);
	s.emit("agent_start");
	assert.equal(s.headers()["AH-Trace-Id"], `${s.manager.getSessionId()}.${first}`);
	assert.notEqual(first, second);
	s.manager.appendCustomMessageEntry("synthetic-context", "合成附加上下文", false);
	assert.equal(s.headers()["AH-Trace-Id"], `${s.manager.getSessionId()}.${first}`);
	const third = user(s.manager);
	assert.equal(s.headers()["AH-Trace-Id"], `${s.manager.getSessionId()}.${third}`);
});

test("独立自定义任务不冒用旧用户消息，后续真实输入可获得新归属", () => {
	const s = setup();
	user(s.manager);
	s.pi.invoke("before_agent_start", { type: "before_agent_start", messageType: "custom" }, s.ctx);
	s.manager.appendCustomMessageEntry("synthetic-task", "合成独立任务", true);
	s.emit("agent_start");
	assert.equal(s.headers()["AH-Trace-Id"], undefined);
	const next = user(s.manager);
	assert.equal(s.headers()["AH-Trace-Id"], `${s.manager.getSessionId()}.${next}`);
});

test("压缩、分支摘要、非聊天请求只归集会话，不借用上一条用户消息", () => {
	const s = setup();
	user(s.manager);
	s.emit("agent_start");
	assert.ok(s.headers()["AH-Trace-Id"]);
	for (const boundary of ["session_before_compact", "session_before_tree", "agent_end"] as const) {
		s.emit(boundary);
		assert.equal(s.headers()["AH-Trace-Id"], undefined);
		assert.equal(s.headers()["X-Magpie-Session"], s.manager.getSessionId());
		s.emit("turn_start");
		assert.ok(s.headers()["AH-Trace-Id"]);
	}
});

test("停用实例不再访问宿主身份；新实例不沿用其他会话ID", () => {
	const s = setup();
	s.emit("session_shutdown");
	const stale = new Proxy({}, { get() { throw new Error("失效上下文不得读取"); } });
	const headers = {};
	s.pi.invoke("before_provider_headers", { type: "before_provider_headers", headers }, stale);
	assert.deepEqual(headers, {});
	const other = setup();
	assert.notEqual(s.manager.getSessionId(), other.manager.getSessionId());
	assert.equal(other.headers()["X-Magpie-Session"], other.manager.getSessionId());
});

test("仅匹配当前tsgw模型的网关origin和路径，不使用活动模型旧快照", () => {
	const s = setup(`${TEST_ROOT}/gateway`);
	s.ctx.model.baseUrl = `${TEST_ROOT}/gateway/v1`;
	assert.ok(s.headers()["X-Magpie-Session"]);
	for (const url of [
		`${TEST_ROOT}/other/v1`, `${TEST_ROOT}/gateway-other/v1`,
		"http://aih.example.com/gateway/v1", "https://aih.example.com:444/gateway/v1",
		"https://other.example.com/gateway/v1", "invalid-url",
	]) {
		s.ctx.model.baseUrl = url;
		assert.deepEqual(s.headers(), {});
	}
	s.ctx.model.baseUrl = `${TEST_ROOT}/gateway/v1`;
	s.ctx.model.provider = "other";
	assert.deepEqual(s.headers(), {});
});

test("保留调用方同名头包括大小写及null，不更改其他请求头", () => {
	const s = setup();
	user(s.manager);
	s.emit("agent_start");
	const initial = { "ah-thread-id": "caller-thread", "x-magpie-session": null, "aH-tRaCe-Id": "caller-trace", "X-Fixture": "preserve" };
	assert.deepEqual(s.headers({ ...initial }), initial);
});

test("缺少真实sessionId时不以消息ID或随机值兜底", () => {
	const s = setup();
	const headers = {};
	s.pi.invoke("before_provider_headers", { type: "before_provider_headers", headers }, {
		model: TSGW_SOL,
		sessionManager: { getSessionId: () => "" },
	});
	assert.deepEqual(headers, {});
});
