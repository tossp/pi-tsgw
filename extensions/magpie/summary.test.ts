import assert from "node:assert/strict";
import { test } from "node:test";
import { quotaSummary } from "./summary.ts";

test("同账户取最紧窗口，同厂商取最大值，厂商之间不合并", () => {
	const cards = [
		{ provider: "minimax", windows: [{ used: 10 }, { used: 80 }] },
		{ provider: "office/minimax-cn", windows: [{ used: 15 }, { used: 40 }] },
		{ provider: "codex", windows: [{ used: 70 }, { used: 20 }] },
		{ provider: "claude", windows: [{ used: 100 }] },
	];
	const before = structuredClone(cards);
	const summary = quotaSummary(cards);
	assert.match(summary, /MiniMax 60%/);
	assert.match(summary, /OpenAI 30%/);
	assert.match(summary, /Claude 0%/);
	assert.deepEqual(cards, before);
});

test("厂商组有百分比时优先展示单值，余额留在详情", () => {
	const summary = quotaSummary([{ provider: "deepseek", windows: [{ used: 20 }] }, { provider: "deepseek", balance: "¥10.00" }]);
	assert.match(summary, /80%/);
	assert.doesNotMatch(summary, /¥10/);
});

test("零值、剩余字段、小数和无限额各自保真", () => {
	assert.match(quotaSummary([{ provider: "codex", windows: [{ used: 0 }, { used: 12.345 }] }]), /87\.66%/);
	assert.match(quotaSummary([{ provider: "codex", windows: [{ remaining: 0 }] }]), /0%/);
	assert.match(quotaSummary([{ provider: "codex", windows: [{ unlimited: true }, { used: 40 }] }]), /60%/);
	assert.match(quotaSummary([{ provider: "codex", windows: [{ unlimited: true }] }]), /∞/);
});

test("余额、钱包和文本占位不能产生满额百分比", () => {
	const summary = quotaSummary([
		{ provider: "deepseek", balance: "¥10.00", windows: null },
		{ provider: "wallet", windows: [{ balance: 0, unit: "credits", used: 0, remaining: 100 }] },
		{ provider: "text", windows: [{ used: 0, text: true, display: "已用 50%" }] },
	]);
	assert.match(summary, /DeepSeek ¥10\.00/);
	assert.match(summary, /wallet 0 credits/);
	assert.match(summary, /text \?/);
	assert.doesNotMatch(summary, /100%|已用/);
});

test("缺失或无效限制窗口保留未知，不用已知窗口冒充完整额度", () => {
	for (const windows of [null, [], [{}], [{ used: 140 }], [{ remaining: -1 }], [{ used: 0 }, {}]]) {
		assert.match(quotaSummary([{ provider: "minimax", windows }]), /MiniMax \?/);
	}
	assert.match(quotaSummary([]), /\?/);
	assert.match(quotaSummary([{ provider: "codex", windows: [{ used: 20 }] }, { provider: "codex" }]), /80%\/\?/);
});

test("正常读数优先于旧高值，只有旧读数时保留旧标记", () => {
	const old = { provider: "codex", error: "timeout", asOf: "2026-11-16", windows: [{ used: 0 }] };
	assert.match(quotaSummary([old, { provider: "codex", windows: [{ used: 70 }] }]), /30%/);
	assert.doesNotMatch(quotaSummary([old, { provider: "codex", windows: [{ used: 70 }] }]), /100%|旧/);
	assert.match(quotaSummary([old]), /100%（旧）/);
});

test("停派和缺读取密钥的账户不能成为最高值，独立通道不挤占主额度", () => {
	const summary = quotaSummary([
		{ provider: "codex", held: true, windows: [{ used: 0 }] },
		{ provider: "codex", needsAccessKey: true, windows: [{ used: 0 }] },
		{ provider: "codex", windows: [{ used: 40 }, { lane: "images", used: 100 }, { extra: true, used: 100 }] },
	]);
	assert.match(summary, /60%/);
	assert.doesNotMatch(summary, /(?:^|\s)(?:100|0)%/);
});

test("未知渠道不借展示名归厂商，多账户余额与货币不相加", () => {
	const summary = quotaSummary([
		{ provider: "office/acme", name: "MiniMax", balance: "$3" },
		{ provider: "office/acme", name: "MiniMax", balance: "¥5" },
	]);
	assert.match(summary, /office\/acme \$3\/¥5/);
	assert.doesNotMatch(summary, /MiniMax|8/);
});
