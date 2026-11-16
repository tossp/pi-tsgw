import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCards } from "./data.ts";
import { quotaSummary } from "./summary.ts";

test("底部仅保留 OpenAI，同账户取最紧窗口再取账户最大值", () => {
	const cards = [
		{ provider: "minimax", windows: [{ used: 10 }, { used: 80 }] },
		{ provider: "office/codex", windows: [{ used: 15 }, { used: 40 }] },
		{ provider: "codex", windows: [{ used: 70 }, { used: 20 }] },
		{ provider: "claude", windows: [{ used: 100 }] },
		{ provider: "deepseek", balance: "¥10.00" },
	];
	const before = structuredClone(cards);
	const summary = quotaSummary(cards);
	assert.ok(summary);
	assert.match(summary, /OpenAI 60%/);
	assert.doesNotMatch(summary, /MiniMax|Claude|DeepSeek|¥10| · /);
	assert.deepEqual(cards, before);
});

test("OpenAI 有有效读数时忽略无读数账户，余额留在详情", () => {
	const summary = quotaSummary([{ provider: "codex", windows: [{ used: 20 }] }, { provider: "codex", balance: "$10.00" }]);
	assert.ok(summary);
	assert.match(summary, /80%/);
	assert.doesNotMatch(summary, /\$10|\?/);
});

test("零值、剩余字段、小数和无限额各自保真", () => {
	for (const [windows, expected] of [
		[[{ used: 0 }, { used: 12.345 }], /87\.66%/],
		[[{ remaining: 0 }], /0%/],
		[[{ unlimited: true }, { used: 40 }], /60%/],
		[[{ unlimited: true }], /∞/],
	] as const) {
		const summary = quotaSummary([{ provider: "codex", windows: [...windows] }]);
		assert.ok(summary);
		assert.match(summary, expected);
	}
});

test("余额、钱包和文本占位不产生百分比，也不展开到底部", () => {
	for (const card of [
		{ provider: "codex", balance: "$10.00", windows: null },
		{ provider: "codex", windows: [{ balance: 0, unit: "credits", used: 0, remaining: 100 }] },
		{ provider: "codex", windows: [{ used: 0, text: true, display: "已用 50%" }] },
	]) assert.equal(quotaSummary([card]), undefined);
});

test("缺失或无效限制窗口不展示，不用部分窗口冒充完整额度", () => {
	for (const windows of [null, [], [{}], [{ used: 140 }], [{ remaining: -1 }], [{ used: 0 }, {}]]) {
		assert.equal(quotaSummary([{ provider: "codex", windows }]), undefined);
	}
	assert.equal(quotaSummary([]), undefined);
});

test("正常读数优先于旧高值，只有旧读数时保留旧标记", () => {
	const old = { provider: "codex", error: "timeout", asOf: "2026-11-16", windows: [{ used: 0 }] };
	const current = quotaSummary([old, { provider: "codex", windows: [{ used: 70 }] }]);
	assert.ok(current);
	assert.match(current, /30%/);
	assert.doesNotMatch(current, /100%|旧/);
	const stale = quotaSummary([old]);
	assert.ok(stale);
	assert.match(stale, /100%（旧）/);
});

test("停派和缺读取密钥的账户不展示，独立通道不挤占主额度", () => {
	const unavailable = [
		{ provider: "codex", held: true, windows: [{ used: 0 }] },
		{ provider: "codex", needsAccessKey: true, windows: [{ used: 0 }] },
	];
	assert.equal(quotaSummary(unavailable), undefined);
	const summary = quotaSummary([...unavailable,
		{ provider: "codex", windows: [{ used: 40 }, { lane: "images", used: 100 }, { extra: true, used: 100 }] },
	]);
	assert.ok(summary);
	assert.match(summary, /60%/);
	assert.doesNotMatch(summary, /(?:^|\s)(?:100|0)%/);
});

test("没有 OpenAI 时不展示，不按展示名猜测产品", () => {
	assert.equal(quotaSummary([
		{ provider: "office/acme", name: "OpenAI / Codex", balance: "$3" },
		{ provider: "minimax", windows: [{ used: 0 }] },
	]), undefined);
});

test("坏展示字段、坏卡片与未知窗口不拖累有效读数，也不冒充满额", () => {
	const cards = parseCards({
		object: "list",
		data: [
			{ provider: "codex", name: 7, windows: [{ name: "week", used: 20, display: 99 }] },
			{ name: "无来源" },
			{ provider: "codex", windows: [{ name: "bad", text: "yes", used: 0 }] },
			{ provider: "minimax", windows: [{ name: "week", used: 80 }] },
		],
	});
	const summary = quotaSummary(cards);
	assert.ok(summary);
	assert.match(summary, /OpenAI 80%/);
	assert.doesNotMatch(summary, /100%|MiniMax/);
});

test("坏窗口不拿剩余有效窗口冒充完整额度", () => {
	const [card] = parseCards({
		object: "list",
		data: [{ provider: "codex", windows: [{ name: "week", used: 20 }, 7] }],
	});
	assert.ok(card);
	assert.equal(quotaSummary([card]), undefined);
});

test("账户状态和错误标记异常时保留参考值，并优先使用正常读数", () => {
	const [held] = parseCards({
		object: "list",
		data: [{ provider: "codex", held: "yes", windows: [{ name: "week", used: 20 }] }],
	});
	assert.ok(held);
	assert.match(quotaSummary([held]) ?? "", /80%（旧）/);
	assert.match(quotaSummary([held, { provider: "codex", windows: [{ used: 70 }] }]) ?? "", /OpenAI 30%$/);

	const [errorCard] = parseCards({
		object: "list",
		data: [{ provider: "codex", error: { secret: "sk-synthetic" }, windows: [{ name: "week", used: 0 }] }],
	});
	assert.ok(errorCard);
	assert.match(quotaSummary([errorCard]) ?? "", /100%（旧）/);
});
