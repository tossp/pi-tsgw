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
	assert.equal(cards, payload.data);
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

test("顶层列表缺失或不可识别时明确失败", () => {
	const bad: Array<[string, unknown]> = [
		["null", null],
		["数组响应", []],
		["data 非数组", { object: "list", data: {} }],
		["data 为 null", { object: "list", data: null }],
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

test("外壳展示标记增删或变化不影响卡片消费", () => {
	const record = { provider: "codex", windows: [{ used: 20 }] };
	const data = [record];
	for (const payload of [{ data }, { object: "item", data }, { object: 7, data, future: true }]) {
		assert.equal(parseCards(payload), data);
		assert.equal(parseCards(payload)[0], record);
	}
});

test("无法识别 provider 的卡片跳过，其他卡片保持原引用", () => {
	const valid = syntheticCard();
	const secret = "sk-synthetic-bad-card-secret";
	const cards = parseCards({
		object: "list",
		data: [null, [], { name: "无来源" }, { provider: "" }, { provider: "  " }, { provider: 7, token: secret }, valid],
	});
	assert.equal(cards.length, 1);
	assert.equal(cards[0], valid);
	assert.ok(!JSON.stringify(cards).includes(secret));
});

test("已知附加字段异常时局部剔除，未知字段保留引用", () => {
	const future = { nested: [1, 2, 3] };
	const original = {
		provider: "acme",
		name: 7,
		user: { secret: "sk-synthetic-user" },
		plan: null,
		readAt: 1,
		balance: 12,
		readDeferred: "yes",
		last: "no",
		windows: null,
		future,
	};
	const [card] = parseCards({ object: "list", data: [original] });
	assert.ok(card);
	assert.notEqual(card, original);
	for (const key of ["name", "user", "plan", "readAt", "balance", "readDeferred", "last"]) {
		assert.equal(Object.hasOwn(card, key), false, key);
	}
	assert.equal(card.windows, null);
	assert.equal(card.future, future);
	assert.ok(!JSON.stringify(card).includes("sk-synthetic-user"));
});

test("卡片局部降级时，合法嵌套数组保持原引用", () => {
	const windows = [{ name: "week", used: 20 }];
	const parts = [{ text: "赠送 ¥5" }];
	const original = { provider: "codex", name: 7, windows, balanceSplit: parts };
	const [card] = parseCards({ object: "list", data: [original] });
	assert.ok(card);
	assert.notEqual(card, original);
	assert.equal(card.windows, windows);
	assert.equal(card.balanceSplit, parts);
});

test("坏展示字段不拖累窗口读数，未知窗口字段保留引用", () => {
	const futureWindow = { nested: true };
	const futureCard = { nested: false };
	const window = { name: "Weekly", used: 20, remaining: 80, display: 42, resetsAt: 7, unit: false, futureWindow };
	const original = { provider: "codex", name: 99, windows: [window], futureCard };
	const [card] = parseCards({ object: "list", data: [original] });
	assert.ok(card);
	assert.equal(Object.hasOwn(card, "name"), false);
	const parsed = card.windows?.[0];
	assert.ok(parsed);
	assert.notEqual(parsed, window);
	assert.equal(parsed.used, 20);
	assert.equal(parsed.remaining, 80);
	assert.equal(Object.hasOwn(parsed, "display"), false);
	assert.equal(Object.hasOwn(parsed, "resetsAt"), false);
	assert.equal(Object.hasOwn(parsed, "unit"), false);
	assert.equal(parsed.futureWindow, futureWindow);
	assert.equal(card.futureCard, futureCard);
});

test("窗口语义标记异常时读数降为未知，不伪造成满额", () => {
	const cases: Array<[string, Record<string, unknown>, string | undefined]> = [
		["text", { name: "text", text: "yes", used: 0, display: "已签到" }, "已签到"],
		["unlimited", { name: "unlimited", unlimited: "yes", used: 0 }, undefined],
		["extra", { name: "extra", extra: "yes", used: 0 }, undefined],
		["lane", { name: "lane", lane: 7, used: 0 }, undefined],
		["balance", { name: "wallet", balance: "12", used: 0 }, undefined],
	];
	for (const [label, window, display] of cases) {
		const [card] = parseCards({ object: "list", data: [{ provider: "codex", windows: [window] }] });
		assert.ok(card, label);
		const parsed = card.windows?.[0];
		assert.ok(parsed, label);
		assert.equal(Object.hasOwn(parsed, "used"), false, `${label}: used`);
		assert.equal(Object.hasOwn(parsed, "remaining"), false, `${label}: remaining`);
		assert.equal(Object.hasOwn(parsed, "text"), false, `${label}: text`);
		if (display === undefined) assert.equal(Object.hasOwn(parsed, "display"), false, label);
		else assert.equal(parsed.display, display, label);
	}
});

test("非对象窗口保留为未知窗口，不丢有效窗口", () => {
	const valid = { name: "5h", used: 20, futureWindow: { nested: 1 } };
	const [card] = parseCards({ object: "list", data: [{ provider: "codex", windows: [valid, 7, null] }] });
	assert.ok(card);
	assert.equal(card.windows?.length, 3);
	assert.equal(card.windows?.[0], valid);
	assert.deepEqual(card.windows?.[1], {});
	assert.deepEqual(card.windows?.[2], {});
});

test("windows 非数组时局部降级为未提供", () => {
	const original = { provider: "acme", name: "保留", windows: "[]" };
	const [card] = parseCards({ object: "list", data: [original] });
	assert.ok(card);
	assert.equal(Object.hasOwn(card, "windows"), false);
	assert.equal(card.name, "保留");
});

test("余额分项异常项剔除或字段降级，未知字段保留", () => {
	const good = { text: "赠送 ¥5", label: "赠送", percent: 40, futurePart: { nested: 1 } };
	const badPercent = { text: "充值 ¥20", percent: "40" };
	const [card] = parseCards({
		object: "list",
		data: [{ provider: "acme", balanceSplit: [good, { label: "缺 text" }, 7, badPercent], balanceParts: "bad" }],
	});
	assert.ok(card);
	assert.equal(card.balanceSplit?.length, 2);
	assert.equal(card.balanceSplit?.[0], good);
	const second = card.balanceSplit?.[1];
	assert.ok(second);
	assert.equal(second.text, "充值 ¥20");
	assert.equal(Object.hasOwn(second, "percent"), false);
	assert.equal(Object.hasOwn(card, "balanceParts"), false);
});

test("估算与重置权益的异常字段局部降级，核心项不可解释时整项剔除", () => {
	const estimateFuture = { nested: 1 };
	const resetFuture = { nested: 2 };
	const estimate = { set: 20, spent: 3.5, at: 123, left: "x", rate: "7.1", future: estimateFuture };
	const resets = {
		count: 2, until: 5, byWindow: "yes",
		each: [{ until: 1, window: "weekly", id: "r", future: resetFuture }, 7, { until: "2026-11-20T00:00:00Z", window: "weekly" }],
	};
	const [card] = parseCards({ object: "list", data: [{ provider: "acme", estimate, resets }] });
	assert.ok(card);
	assert.equal(card.estimate?.set, 20);
	assert.equal(card.estimate?.spent, 3.5);
	assert.equal(Object.hasOwn(card.estimate ?? {}, "at"), false);
	assert.equal(Object.hasOwn(card.estimate ?? {}, "left"), false);
	assert.equal(Object.hasOwn(card.estimate ?? {}, "rate"), false);
	assert.equal(card.estimate?.future, estimateFuture);
	assert.equal(card.resets?.count, 2);
	assert.equal(Object.hasOwn(card.resets ?? {}, "until"), false);
	assert.equal(Object.hasOwn(card.resets ?? {}, "byWindow"), false);
	assert.equal(card.resets?.each?.length, 2);
	assert.equal(card.resets?.each?.[0]?.window, "weekly");
	assert.equal(Object.hasOwn(card.resets?.each?.[0] ?? {}, "until"), false);
	assert.equal(card.resets?.each?.[0]?.future, resetFuture);
	assert.equal(card.resets?.each?.[1]?.until, "2026-11-20T00:00:00Z");

	const [dropped] = parseCards({
		object: "list",
		data: [{ provider: "acme", estimate: { set: "20", spent: 1 }, resets: { count: "2", each: [] } }],
	});
	assert.ok(dropped);
	assert.equal(Object.hasOwn(dropped, "estimate"), false);
	assert.equal(Object.hasOwn(dropped, "resets"), false);
});

test("error／asOf 异常时保留旧读数语义，不回显原始值", () => {
	const secret = "sk-synthetic-error-secret";
	const [errorCard] = parseCards({
		object: "list",
		data: [{ provider: "codex", error: { secret }, windows: [{ name: "week", used: 0 }] }],
	});
	assert.ok(errorCard);
	assert.equal(typeof errorCard.error, "string");
	assert.ok(!JSON.stringify(errorCard).includes(secret));

	const [asOfCard] = parseCards({
		object: "list",
		data: [{ provider: "codex", asOf: { secret }, windows: [{ name: "week", used: 0 }] }],
	});
	assert.ok(asOfCard);
	assert.equal(typeof asOfCard.error, "string");
	assert.ok(!JSON.stringify(asOfCard).includes(secret));
});

test("派发与读取密钥标记异常时保留参考值，不编造账户状态", () => {
	const [held] = parseCards({ object: "list", data: [{ provider: "codex", held: "yes", windows: [{ name: "week", used: 20 }] }] });
	assert.ok(held);
	assert.equal(held.held, undefined);
	assert.equal(held.windows?.[0].used, 20);
	assert.match(held.error ?? "", /状态字段异常/);
	const [key] = parseCards({ object: "list", data: [{ provider: "codex", needsAccessKey: 1, windows: [{ name: "week", used: 20 }] }] });
	assert.ok(key);
	assert.equal(key.needsAccessKey, undefined);
	assert.match(key.error ?? "", /状态字段异常/);
});

test("顶层解析错误与降级结果都不复述原始响应内容", () => {
	const secret = "sk-synthetic-secret-do-not-echo";
	assert.throws(() => parseCards({ object: "item", data: {}, token: secret }), (error: unknown) => {
		assert.ok(error instanceof MagpieDataError);
		assert.ok(!error.message.includes(secret));
		assert.ok(!error.message.includes("{"));
		return true;
	});
	const [card] = parseCards({
		object: "list",
		data: [{ provider: "acme", name: { secret }, windows: [{ name: "w", display: { secret } }] }],
	});
	assert.ok(card);
	assert.ok(!JSON.stringify(card).includes(secret));
});

test("statusline 解析保留报告窗口字段与顶层未知字段", () => {
	const account = syntheticCard();
	const payload = { text: "codex 周已用 20%", model: "synthetic-model", accounts: [account], generatedAt: "synthetic-time" };
	const status = parseStatusline(payload);
	assert.equal(status, payload);
	assert.equal(status.text, "codex 周已用 20%");
	assert.equal(status.model, "synthetic-model");
	assert.equal(status.accounts.length, 1);
	assert.equal(status.accounts[0], account);
	assert.equal(status.accounts[0].windows?.[0]?.remaining, 87.5);
	assert.equal((status as Record<string, unknown>).generatedAt, "synthetic-time");
});

test("statusline 顶层账户列表缺失或不可识别时明确失败", () => {
	const bad: Array<[string, unknown]> = [
		["null", null],
		["数组响应", []],
		["缺少 accounts", { text: "t", model: "m" }],
		["accounts 非数组", { text: "t", model: "m", accounts: {} }],
		["accounts 为 null", { text: "t", model: "m", accounts: null }],
	];
	for (const [name, payload] of bad) {
		assert.throws(() => parseStatusline(payload), (error: unknown) => {
			assert.ok(error instanceof MagpieDataError);
			assert.match(error.message, /statusline/);
			return true;
		}, name);
	}
});

test("statusline 展示字段缺失或异常时降级，账户读数保留", () => {
	const futureTop = { nested: [1] };
	const validAccount = syntheticCard();
	const account = { provider: "codex", name: 7, windows: [{ name: "week", used: 20 }] };
	const payload = {
		text: 42,
		model: null,
		accounts: [account, validAccount, { name: "无来源" }],
		futureTop,
	};
	const status = parseStatusline(payload);
	assert.notEqual(status, payload);
	assert.equal(Object.hasOwn(status, "text"), false);
	assert.equal(Object.hasOwn(status, "model"), false);
	assert.equal(status.accounts.length, 2);
	assert.notEqual(status.accounts[0], account);
	assert.equal(status.accounts[0]?.windows?.[0]?.used, 20);
	assert.equal(status.accounts[1], validAccount);
	assert.equal((status as Record<string, unknown>).futureTop, futureTop);

	const missing = parseStatusline({ accounts: [] });
	assert.equal(Object.hasOwn(missing, "text"), false);
	assert.equal(Object.hasOwn(missing, "model"), false);
	assert.equal(missing.accounts.length, 0);
});
