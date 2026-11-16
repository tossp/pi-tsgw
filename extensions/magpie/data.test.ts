import assert from "node:assert/strict";
import { test } from "node:test";
import { MagpieDataError, parseCards, parseStatusline } from "./data.ts";

/** 合成卡片：覆盖卡片与报告两套窗口字段，不读取任何真实账户。 */
function syntheticCard(): Record<string, unknown> {
	return {
		provider: "codex",
		name: "Codex 合成账户",
		user: "synthetic-user",
		plan: "Pro",
		kind: "subscription",
		readAt: "2026-11-16T03:04:05Z",
		asOf: "2026-11-16T02:00:00Z",
		readDeferred: true,
		balance: "¥12.34",
		sharedBalance: "synthetic-user",
		windows: [
			{
				name: "5h", used: 12.5, remaining: 87.5, resetsAt: "2026-11-16T08:00:00Z",
				display: "1.2k / 9.6k", amount: 1200, limit: 9600, unit: "credits",
				text: false, unlimited: false, lane: "images", pool: "synthetic-pool", family: "synthetic-family",
				balance: 3.5, spent: 1.25, spentSince: "2026-11-16T00:00:00Z",
				runsOutAt: "2026-12-01T00:00:00Z", runsOut: 40, holdsWhy: "none", credits: true, extra: false, capped: false,
			},
			{ name: "每日签到", used: 0, text: true, display: "已签到" },
		],
		balanceSplit: [{ text: "赠送 ¥5.00", label: "赠送", percent: 40, error: "分项读取失败", expires: "2026-12-31T00:00:00Z" }],
		balanceParts: [{ text: "充值 ¥20.00", label: "充值" }],
		estimate: { set: 20, at: "2026-11-15T00:00:00Z", spent: 3.5, currency: "cny", rate: 7.1, left: 16.5, from: "2026-11-15T00:00:00Z", next: "2026-12-15T00:00:00Z" },
		resets: { count: 2, until: "2026-12-01T00:00:00Z", byWindow: true, fiveHour: 1, weekly: 1, team: false, each: [{ until: "2026-11-20T00:00:00Z", window: "weekly", id: "synthetic-reset" }] },
		futureField: { nested: [1, 2, 3] },
	};
}

test("cards 解析保留全部原始字段与对象引用", () => {
	const first = syntheticCard();
	const second = syntheticCard();
	second.name = "同名第二张";
	const payload = { object: "list", data: [first, second], extra: "保留在响应层" };
	const cards = parseCards(payload);
	assert.equal(cards.length, 2);
	assert.equal(cards[0], first);
	assert.equal(cards[1], second);
	assert.deepEqual(cards[0], first);
	assert.equal(cards[0].windows?.[0], (first.windows as unknown[])[0]);
	assert.deepEqual(cards[0].futureField, { nested: [1, 2, 3] });
	assert.equal(cards[1].name, "同名第二张");
});

test("cards 解析不补窗口、不补读数、不把缺失值变成 100%", () => {
	const noWindows = { provider: "acme", name: "无窗口" };
	const emptyWindows = { provider: "acme", name: "空窗口", windows: [] };
	const usedZero = { provider: "acme", name: "占位零", windows: [{ name: "签到", used: 0, text: true }] };
	const cards = parseCards({ object: "list", data: [noWindows, emptyWindows, usedZero] });
	assert.equal(Object.hasOwn(cards[0], "windows"), false);
	assert.equal(Object.hasOwn(cards[0], "balance"), false);
	assert.deepEqual(cards[1].windows, []);
	const window = cards[2].windows?.[0];
	assert.ok(window);
	assert.equal(window.used, 0);
	assert.equal(Object.hasOwn(window, "remaining"), false);
});

test("windows 为 null 表示未提供窗口，不整份拒收也不改成空数组", () => {
	const withNull = { provider: "acme", name: "保留的旧余额卡", windows: null };
	const missing = { provider: "acme", name: "缺字段" };
	const cards = parseCards({ object: "list", data: [withNull, missing] });
	assert.equal(cards[0]?.windows, null);
	assert.equal(Object.hasOwn(cards[0] as object, "windows"), true);
	assert.equal(Object.hasOwn(cards[1] as object, "windows"), false);
});

test("cards 解析拒绝形状与已知字段类型错误", () => {
	const bad: Array<[string, unknown]> = [
		["null", null],
		["数组响应", []],
		["data 非数组", { object: "list", data: {} }],
		["object 非 list", { object: "item", data: [] }],
		["缺少 object", { data: [] }],
		["卡片非对象", { object: "list", data: [null] }],
		["缺少 provider", { object: "list", data: [{ name: "x" }] }],
		["provider 空白", { object: "list", data: [{ provider: "  " }] }],
		["provider 非字符串", { object: "list", data: [{ provider: 7 }] }],
		["name 非字符串", { object: "list", data: [{ provider: "acme", name: 1 }] }],
		["windows 非数组", { object: "list", data: [{ provider: "acme", windows: {} }] }],
		["窗口非对象", { object: "list", data: [{ provider: "acme", windows: [1] }] }],
		["used 非数值", { object: "list", data: [{ provider: "acme", windows: [{ name: "周", used: "20" }] }] }],
		["used 非有限数", { object: "list", data: [{ provider: "acme", windows: [{ name: "周", used: Number.POSITIVE_INFINITY }] }] }],
		["text 非布尔", { object: "list", data: [{ provider: "acme", windows: [{ name: "周", text: "yes" }] }] }],
		["remaining 为 null", { object: "list", data: [{ provider: "acme", windows: [{ name: "周", remaining: null }] }] }],
		["balance 非字符串", { object: "list", data: [{ provider: "acme", balance: 12 }] }],
		["resets 缺少 count", { object: "list", data: [{ provider: "acme", resets: {} }] }],
		["estimate.set 非数值", { object: "list", data: [{ provider: "acme", estimate: { set: "20", spent: 1 } }] }],
		["balanceSplit 项缺 text", { object: "list", data: [{ provider: "acme", balanceSplit: [{ label: "赠送" }] }] }],
		["windows 非数组非 null", { object: "list", data: [{ provider: "acme", windows: "[]" }] }],
		["balanceParts 非数组", { object: "list", data: [{ provider: "acme", balanceParts: {} }] }],
		["balanceParts 项缺 text", { object: "list", data: [{ provider: "acme", balanceParts: [{ label: "充值" }] }] }],
		["readDeferred 非布尔", { object: "list", data: [{ provider: "acme", readDeferred: "yes" }] }],
	];
	for (const [name, payload] of bad) {
		assert.throws(() => parseCards(payload), (error: unknown) => {
			assert.ok(error instanceof MagpieDataError);
			assert.match(error.message, /Magpie 数据无效：/);
			assert.match(error.message, /[\u4e00-\u9fa5]/);
			return true;
		}, name);
	}
});

test("解析错误不复述原始响应内容", () => {
	const secret = "sk-synthetic-secret-do-not-echo";
	const payload = { object: "list", data: [{ provider: "acme", name: 7, token: secret }] };
	assert.throws(() => parseCards(payload), (error: unknown) => {
		assert.ok(error instanceof MagpieDataError);
		assert.ok(!error.message.includes(secret));
		assert.ok(!error.message.includes("{"));
		return true;
	});
});

test("statusline 解析保留报告窗口字段与顶层未知字段", () => {
	const account = syntheticCard();
	const payload = { text: "codex 周已用 20%", model: "synthetic-model", accounts: [account], generatedAt: "synthetic-time" };
	const status = parseStatusline(payload);
	assert.equal(status.text, "codex 周已用 20%");
	assert.equal(status.model, "synthetic-model");
	assert.equal(status.accounts.length, 1);
	assert.equal(status.accounts[0], account);
	assert.equal(status.accounts[0].windows?.[0]?.remaining, 87.5);
	assert.equal((status as Record<string, unknown>).generatedAt, "synthetic-time");
});

test("statusline 解析拒绝缺失字段与非法账户", () => {
	const bad: Array<[string, unknown]> = [
		["null", null],
		["缺少 text", { model: "m", accounts: [] }],
		["text 非字符串", { text: 1, model: "m", accounts: [] }],
		["缺少 model", { text: "t", accounts: [] }],
		["model 为 null", { text: "t", model: null, accounts: [] }],
		["accounts 非数组", { text: "t", model: "m", accounts: {} }],
		["账户非法", { text: "t", model: "m", accounts: [{ name: "无来源" }] }],
	];
	for (const [name, payload] of bad) {
		assert.throws(() => parseStatusline(payload), (error: unknown) => {
			assert.ok(error instanceof MagpieDataError);
			assert.match(error.message, /statusline/);
			return true;
		}, name);
	}
});
