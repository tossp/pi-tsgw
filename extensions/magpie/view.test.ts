import assert from "node:assert/strict";
import { test } from "node:test";
import type { MagpieCard, MagpieStatusline } from "./data.ts";
import { cardDetails, cardLabel, groupCards, statusDetails } from "./view.ts";

function card(fields: Partial<MagpieCard> & { provider: string }): MagpieCard {
	return { ...fields };
}

test("已知产品族内合并本地与远程卡片，未知来源保持完整名称", () => {
	const codex = card({ provider: "codex", name: "Codex 合成账户", user: "a@example.invalid" });
	const remote = card({ provider: "office/codex", from: "office" });
	const remoteBare = card({ provider: "codex", from: "office" });
	// 远程 provider 可能链式叠加前缀，产品是最后一段。
	const chained = card({ provider: "hq/office/deepseek", from: "hq" });
	const localDeepseek = card({ provider: "deepseek" });
	const kimi = card({ provider: "kimi-code" });
	// 展示名带厂商字样，也不能据此猜厂商。
	const unknown = card({ provider: "acme-gateway", name: "OpenAI 官方" });
	const unknownRemote = card({ provider: "office/acme-gateway", from: "office" });
	const groups = groupCards([codex, remote, remoteBare, chained, localDeepseek, kimi, unknown, unknownRemote]);
	assert.deepEqual(groups.map(group => group.name), ["OpenAI / Codex", "DeepSeek", "Moonshot / Kimi", "acme-gateway", "office/acme-gateway"]);
	// 同族远程与本地卡片同组，但保留各自源记录与顺序。
	assert.deepEqual(groups[0]?.cards, [codex, remote, remoteBare]);
	assert.equal(groups[0]?.cards[0], codex);
	assert.deepEqual(groups[1]?.cards, [chained, localDeepseek]);
	assert.equal(groups[4]?.cards[0], unknownRemote);
	assert.equal(groupCards([]).length, 0);
});

test("同 provider/user 的卡片不去重、不覆盖、不相加", () => {
	const first = card({ provider: "codex", name: "Codex", user: "same" });
	const second = card({ provider: "codex", name: "Codex", user: "same", error: "读取失败" });
	const groups = groupCards([first, second]);
	assert.equal(groups.length, 1);
	assert.equal(groups[0]?.cards.length, 2);
	assert.equal(groups[0]?.cards[0], first);
	assert.equal(groups[0]?.cards[1], second);
});

test("卡片标签包含账户与套餐，可用下标区分同名卡片", () => {
	const first = card({ provider: "codex", name: "Codex", user: "same", plan: "Pro" });
	const second = card({ provider: "codex", name: "Codex", user: "same", plan: "Pro" });
	const label = cardLabel(first);
	assert.match(label, /Codex/);
	assert.match(label, /same/);
	assert.match(label, /Pro/);
	assert.equal(cardLabel(card({ provider: "acme" })), "acme");
	assert.notEqual(cardLabel(first, 0), cardLabel(second, 1));
	assert.match(cardLabel(card({ provider: "codex", from: "office", name: "Codex" })), /office\/codex/);
});

test("文本窗口保留 display，不把 used=0 当成剩余 100%", () => {
	const details = cardDetails(card({
		provider: "codex",
		windows: [{ name: "每日签到", used: 0, text: true, display: "已签到，积分 5" }],
	})).join("\n");
	assert.match(details, /每日签到/);
	assert.match(details, /已签到，积分 5/);
	assert.match(details, /used 不是占比/);
	assert.ok(!details.includes("100%"));
	assert.ok(!details.includes("已用 0%"));
});

test("无 display 的文本窗口标为未知，不推断读数", () => {
	const details = cardDetails(card({ provider: "codex", windows: [{ name: "文本行", used: 0, text: true }] })).join("\n");
	assert.match(details, /文本读数未知/);
	assert.ok(!details.includes("100%"));
	assert.ok(!details.includes("剩余"));
});

test("无限额窗口只声明无限额，不产生百分比", () => {
	const details = cardDetails(card({ provider: "codex", windows: [{ name: "Images", used: 0, unlimited: true, display: "按量" }] })).join("\n");
	assert.match(details, /Images/);
	assert.match(details, /无限额/);
	assert.match(details, /按量/);
	assert.ok(!details.includes("剩余 100%"));
	assert.ok(!details.includes("已用 0%"));
});

test("有效百分比窗口展示已用与剩余，并保留重置时间", () => {
	const withReport = cardDetails(card({
		provider: "codex",
		windows: [{ name: "Weekly", used: 20, remaining: 80, resetsAt: "2026-11-20T00:00:00Z" }],
	})).join("\n");
	assert.match(withReport, /Weekly/);
	assert.match(withReport, /已用 20%/);
	assert.match(withReport, /剩余 80%/);
	assert.match(withReport, /2026-11-20T00:00:00Z/);

	const computed = cardDetails(card({ provider: "codex", windows: [{ name: "5h", used: 12.5 }] })).join("\n");
	assert.match(computed, /已用 12.5%/);
	assert.match(computed, /剩余 87.5%/);
});

test("超出范围的 used 不作为百分比读数", () => {
	const details = cardDetails(card({ provider: "codex", windows: [{ name: "Odd", used: 140 }] })).join("\n");
	assert.match(details, /140/);
	assert.match(details, /不是有效读数/);
	assert.ok(!details.includes("剩余"));
});

test("display 优先于百分比，且与金额/积分读数区分", () => {
	const details = cardDetails(card({
		provider: "codex",
		windows: [{ name: "5h", used: 20, display: "1.2k / 6k", amount: 1200, limit: 6000, unit: "credits" }],
	})).join("\n");
	assert.ok(details.indexOf("1.2k / 6k") < details.indexOf("已用 20%"));
	assert.match(details, /计量 1200 credits \/ 6000 credits/);
});

test("钱包余额窗口的 used 无总量时不当作占比", () => {
	const details = cardDetails(card({
		provider: "deepseek",
		windows: [{ name: "Wallet", used: 0, balance: 12.5, unit: "credits" }],
	})).join("\n");
	assert.match(details, /钱包余额 12.5 credits/);
	assert.ok(!details.includes("剩余 100%"));
	assert.ok(!details.includes("已用 0%"));
});

test("有消费上限的钱包窗口仍可展示占比、计量与余额", () => {
	const details = cardDetails(card({
		provider: "deepseek",
		windows: [{ name: "Capped", used: 40, balance: 3, amount: 4, limit: 10, unit: "credits" }],
	})).join("\n");
	assert.match(details, /已用 40%/);
	assert.match(details, /剩余 60%/);
	assert.match(details, /钱包余额 3 credits/);
	assert.match(details, /计量 4 credits \/ 10 credits/);
});

test("窗口的到期、花费、共享池与通道分别展示", () => {
	const details = cardDetails(card({
		provider: "codex",
		windows: [{
			name: "5h", used: 20, unit: "credits", runsOut: 40, runsOutAt: "2026-12-01T00:00:00Z",
			spent: 1.5, spentSince: "2026-11-16T00:00:00Z", pool: "synthetic-pool", lane: "images", family: "synthetic-family",
		}],
	})).join("\n");
	assert.match(details, /40 credits/);
	assert.match(details, /2026-12-01T00:00:00Z/);
	assert.match(details, /本周期已花费 1.5 credits（自 2026-11-16T00:00:00Z）/);
	assert.match(details, /共享池 synthetic-pool/);
	assert.match(details, /通道 images/);
	assert.match(details, /族 synthetic-family/);
});

test("卡片明细区分读数时间、旧读数、本次错误与未主动读取", () => {
	const details = cardDetails(card({
		provider: "codex",
		readAt: "2026-11-16T03:00:00Z",
		asOf: "2026-11-16T01:00:00Z",
		readDeferred: true,
		error: "上游超时",
	})).join("\n");
	assert.match(details, /读数时间：2026-11-16T03:00:00Z/);
	assert.match(details, /旧读数时间：2026-11-16T01:00:00Z/);
	assert.match(details, /本次未主动读取/);
	assert.match(details, /本次记录错误：上游超时/);

	const clean = cardDetails(card({ provider: "codex" })).join("\n");
	assert.doesNotMatch(clean, /旧读数时间|本次记录错误|未主动读取/);
});

test("windows 为 null 与缺失同样标为未提供，不当成空窗口或满额", () => {
	const missing = cardDetails(card({ provider: "deepseek" })).join("\n");
	const nullWindows = cardDetails(card({ provider: "deepseek", windows: null })).join("\n");
	const empty = cardDetails(card({ provider: "deepseek", windows: [] })).join("\n");
	assert.match(missing, /窗口：未提供/);
	assert.equal(nullWindows, missing);
	assert.match(empty, /窗口：未返回/);
	assert.ok(!nullWindows.includes("100%"));
	assert.equal(nullWindows.split("\n").filter(line => line.startsWith("窗口：")).length, 1);
});

test("余额、共享余额、估算与重置权益如实列出且不相加", () => {
	const details = cardDetails(card({
		provider: "deepseek",
		balance: "¥10.00",
		sharedBalance: "first-key",
		balanceSplit: [{ text: "赠送 ¥5.00", label: "赠送", percent: 50 }],
		balanceParts: [{ text: "充值 ¥20.00", label: "充值" }],
		estimate: { set: 20, at: "2026-11-15T00:00:00Z", spent: 3.5, currency: "cny", left: 16.5 },
		resets: { count: 2, until: "2026-12-01T00:00:00Z", each: [{ until: "2026-11-20T00:00:00Z", window: "weekly" }] },
	})).join("\n");
	assert.match(details, /余额：¥10.00/);
	assert.match(details, /余额分项（同一笔余额的拆分，不与余额或其他卡片相加）：/);
	assert.match(details, /余额分项：赠送 ¥5.00（赠送）（50%）/);
	assert.match(details, /余额分项：充值 ¥20.00（充值）/);
	assert.match(details, /共享余额：与「first-key」共用/);
	assert.match(details, /估算余额（非厂商读数）：设定 20，自 2026-11-15T00:00:00Z 起已用 3.5，剩余 16.5（cny）/);
	assert.match(details, /重置权益：2 次；最近至 2026-12-01T00:00:00Z/);
	assert.match(details, /权益项：2026-11-20T00:00:00Z（weekly）/);
});

test("同 provider/user 的两张卡片各自独立展示，不互相覆盖或求和", () => {
	const first = card({ provider: "codex", name: "Codex", user: "same", balance: "¥1.00", error: "失败 A" });
	const second = card({ provider: "codex", name: "Codex", user: "same", balance: "¥2.00", error: "失败 B" });
	const firstText = cardDetails(first).join("\n");
	const secondText = cardDetails(second).join("\n");
	assert.match(firstText, /¥1\.00/);
	assert.match(firstText, /失败 A/);
	assert.ok(!firstText.includes("¥2.00"));
	assert.ok(!firstText.includes("失败 B"));
	assert.match(secondText, /¥2.00/);
	assert.match(secondText, /失败 B/);
	assert.ok(!secondText.includes("¥1.00"));
	assert.ok(!secondText.includes("失败 A"));
});

test("缺失字段明确标为未提供，且不输出原始 JSON", () => {
	const details = cardDetails(card({ provider: "acme" })).join("\n");
	assert.match(details, /来源：acme/);
	assert.match(details, /账户：未提供/);
	assert.match(details, /套餐：未提供/);
	assert.match(details, /读数时间：未提供/);
	assert.match(details, /窗口：未提供/);
	assert.doesNotMatch(details, /[{}]/);

	const empty = cardDetails(card({ provider: "acme", windows: [] })).join("\n");
	assert.match(empty, /窗口：未返回/);
});

test("状态行标明模型名可能回退，并汇总账户卡片而不冒充成员证据", () => {
	const status: MagpieStatusline = {
		text: "codex 周已用 20%",
		model: "gpt-5-codex",
		accounts: [card({ provider: "codex", error: "上游超时", readAt: "2026-11-16T01:23:00Z" }), card({ provider: "deepseek" })],
	};
	const details = statusDetails(status).join("\n");
	assert.match(details, /gpt-5-codex/);
	assert.match(details, /请求名回退/);
	assert.match(details, /不能证明实际执行的成员/);
	assert.match(details, /codex 周已用 20%/);
	assert.match(details, /2 条/);
	assert.match(details, /1 条带本次错误/);
	assert.match(details, /2026-11-16T01:23:00Z/);
	assert.doesNotMatch(details, /[{}]/);

	const empty = statusDetails({ text: "", model: "", accounts: [] }).join("\n");
	assert.match(empty, /模型（网关状态报告值）：未提供/);
	assert.match(empty, /账户卡片：未返回/);
});
