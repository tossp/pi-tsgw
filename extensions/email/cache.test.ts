import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test, type TestContext } from "node:test";
import {
	EmailCache, EMAIL_CACHE_CONTENT_TTL_MS, EMAIL_CACHE_MAX_BYTES, EMAIL_CACHE_MAX_ENTRY_BYTES,
	EMAIL_CACHE_STATE_TTL_MS, EMAIL_CACHE_SWEEP_MS,
} from "./cache.ts";

function cacheFor(t: TestContext, options?: ConstructorParameters<typeof EmailCache>[0]): EmailCache {
	const cache = new EmailCache(options);
	t.after(() => cache.dispose());
	return cache;
}

function useClock(t: TestContext): void {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100_000 });
}

test("缓存默认预算和单项上限分别为 128 MiB、8 MiB，超大内容不入缓存", t => {
	const cache = cacheFor(t);
	assert.equal(EMAIL_CACHE_MAX_BYTES, 128 * 1024 * 1024);
	assert.equal(EMAIL_CACHE_MAX_ENTRY_BYTES, 8 * 1024 * 1024);
	assert.equal(cache.set("body", Buffer.alloc(EMAIL_CACHE_MAX_ENTRY_BYTES)), true);
	assert.equal(cache.set("oversized", Buffer.alloc(EMAIL_CACHE_MAX_ENTRY_BYTES + 1)), false);
	assert.equal(cache.size, 1);
	assert.ok(cache.bytes <= EMAIL_CACHE_MAX_BYTES);
});

test("LRU：读取提升最近使用次序，满额淘汰最久未使用项", t => {
	const cache = cacheFor(t, { maxBytes: 3000 });
	assert.equal(cache.set("a", Buffer.alloc(1024, 1)), true);
	assert.equal(cache.set("b", Buffer.alloc(1024, 2)), true);
	assert.ok(cache.get("a"));
	assert.equal(cache.set("c", Buffer.alloc(1024, 3)), true);
	assert.equal(cache.get("b"), undefined);
	assert.ok(cache.get("a"));
	assert.ok(cache.get("c"));
	assert.equal(cache.size, 2);
	assert.ok(cache.bytes <= 3000);
});

test("更新已有键重新计费并提升次序，不累计旧大小", t => {
	const cache = cacheFor(t, { maxBytes: 3000 });
	cache.set("a", Buffer.alloc(1024));
	cache.set("b", Buffer.alloc(1024));
	const before = cache.bytes;
	cache.set("a", Buffer.alloc(1024, 7));
	assert.equal(cache.bytes, before);
	cache.set("c", Buffer.alloc(1024));
	assert.equal(cache.get("b"), undefined);
	assert.deepEqual(cache.get("a"), Buffer.alloc(1024, 7));
	assert.equal(cache.size, 2);
});

test("超限更新使同键旧内容失效，但不淘汰无关内容", t => {
	const cache = cacheFor(t, { maxEntryBytes: 1024 });
	cache.set("updated", "旧内容");
	cache.set("preserved", "保留内容");
	assert.equal(cache.set("updated", Buffer.alloc(1025)), false);
	assert.equal(cache.get("updated"), undefined);
	assert.equal(cache.get("preserved"), "保留内容");
});

test("总预算也约束单项及大量小内容，中文字符串计入容量", t => {
	const cache = cacheFor(t, { maxBytes: 1024 });
	assert.equal(cache.set("oversized", Buffer.alloc(1024)), false);
	for (let index = 0; index < 1000; index++) {
		assert.equal(cache.set(String(index), "中文"), true);
		assert.ok(cache.bytes <= 1024);
	}
	assert.ok(cache.size < 1000);
	assert.equal(cache.get("0"), undefined);
	assert.equal(cache.get("999"), "中文");
});

test("状态 TTL 精确到期，读取不会延长寿命", t => {
	useClock(t);
	const cache = cacheFor(t);
	cache.set("state", "未读", "state");
	t.mock.timers.tick(EMAIL_CACHE_STATE_TTL_MS - 1);
	assert.equal(cache.get("state"), "未读");
	t.mock.timers.tick(1);
	assert.equal(cache.get("state"), undefined);
	assert.equal(cache.bytes, 0);
});

test("没有读取也主动回收状态缓存，未到期内容保留", t => {
	useClock(t);
	const cache = cacheFor(t);
	cache.set("state", "未读", "state");
	cache.set("body", "正文");
	t.mock.timers.tick(EMAIL_CACHE_STATE_TTL_MS);
	assert.equal(cache.size, 2, "主动扫描前尚可留在内存，但读取已过期");
	t.mock.timers.tick(EMAIL_CACHE_SWEEP_MS - EMAIL_CACHE_STATE_TTL_MS);
	assert.equal(cache.size, 1, "无需访问就删除过期状态");
	assert.equal(cache.get("body"), "正文");
});

test("正文、头部、小附件十分钟后无访问也主动回收", t => {
	useClock(t);
	const cache = cacheFor(t);
	cache.set("body", "正文");
	cache.set("headers", "Received: first\r\nReceived: second\r\n");
	cache.set("attachment", Buffer.from([0, 1, 255]));
	t.mock.timers.tick(EMAIL_CACHE_CONTENT_TTL_MS);
	assert.equal(cache.size, 0);
	assert.equal(cache.bytes, 0);
});

test("内容读取不续期，重新获取写入才重新计时", t => {
	useClock(t);
	const cache = cacheFor(t);
	cache.set("read", "原文");
	cache.set("updated", "旧文");
	t.mock.timers.tick(EMAIL_CACHE_CONTENT_TTL_MS - 1);
	assert.equal(cache.get("read"), "原文");
	cache.set("updated", "新文");
	t.mock.timers.tick(1);
	assert.equal(cache.get("read"), undefined);
	assert.equal(cache.get("updated"), "新文");
	t.mock.timers.tick(EMAIL_CACHE_CONTENT_TTL_MS);
	assert.equal(cache.size, 0);
});

test("容量不足先回收过期项，不挤掉仍有效的旧内容", t => {
	useClock(t);
	const cache = cacheFor(t, { maxBytes: 3000 });
	cache.set("body", Buffer.alloc(1024));
	cache.set("state", Buffer.alloc(1024), "state");
	t.mock.timers.tick(EMAIL_CACHE_STATE_TTL_MS);
	cache.set("new", Buffer.alloc(1024));
	assert.equal(cache.get("state"), undefined);
	assert.ok(cache.get("body"));
	assert.ok(cache.get("new"));
	assert.ok(cache.bytes <= 3000);
});

test("写入复制缓冲区，调用方修改和大缓冲区切片不改变缓存", t => {
	const cache = cacheFor(t);
	const original = Buffer.alloc(1024 * 1024, 7);
	const slice = original.subarray(0, 16);
	assert.equal(cache.set("attachment", slice), true);
	original.fill(9);
	assert.deepEqual(cache.get("attachment"), Buffer.alloc(16, 7));
	assert.ok(cache.bytes < 1024 * 1024);
});

test("删除和清空正确释放计费，缓存变量彼此独立", t => {
	const first = cacheFor(t);
	const second = cacheFor(t);
	first.set("same", "甲");
	second.set("same", "乙");
	assert.equal(first.delete("same"), true);
	assert.equal(first.delete("same"), false);
	assert.equal(first.bytes, 0);
	assert.equal(second.get("same"), "乙");
	second.clear();
	assert.equal(second.size, 0);
	assert.equal(second.bytes, 0);
});

test("销毁关闭唯一计时器并清空内容，可重复调用且拒绝迟到写入", t => {
	useClock(t);
	const original = globalThis.clearInterval;
	const spy = t.mock.method(globalThis, "clearInterval", original);
	const cache = cacheFor(t);
	cache.set("body", "正文");
	cache.dispose();
	assert.equal(spy.mock.calls.length, 1);
	assert.notEqual(spy.mock.calls[0].arguments[0], undefined);
	assert.equal(cache.size, 0);
	assert.equal(cache.bytes, 0);
	assert.equal(cache.set("late", "迟到结果"), false);
	cache.dispose();
	t.mock.timers.tick(EMAIL_CACHE_CONTENT_TTL_MS * 2);
	assert.equal(cache.size, 0);
});
