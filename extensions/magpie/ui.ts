import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MagpieCard, MagpieStatusline } from "./data.ts";
import { cardDetails, cardLabel, groupCards, statusDetails } from "./view.ts";
import type { MagpieSnapshot, RefreshTarget } from "./service.ts";

export function snapshotLines<T>(snapshot: MagpieSnapshot<T>): string[] {
	return [
		...(snapshot.error ? [snapshot.error] : []),
		...(snapshot.fetchedAt === undefined ? [] : [`状态获取时间：${new Date(snapshot.fetchedAt).toLocaleString()}`]),
		...(snapshot.data === undefined ? ["尚无可用读数。"] : []),
	];
}

export async function showStatus(ui: ExtensionUIContext, snapshot: MagpieSnapshot<MagpieStatusline>, signal: AbortSignal) {
	if (signal.aborted) return;
	await ui.select("Magpie 状态（选择任一行关闭）", [
		...snapshotLines(snapshot), ...(snapshot.data ? statusDetails(snapshot.data) : []),
	], { signal });
}

export async function showCards(ui: ExtensionUIContext, snapshot: MagpieSnapshot<MagpieCard[]>, signal: AbortSignal) {
	const cards = snapshot.data;
	if (!cards?.length) {
		if (!signal.aborted) await ui.select("Magpie 额度", [...snapshotLines(snapshot), "当前没有可见额度卡片。"], { signal });
		return;
	}
	const groups = groupCards(cards);
	while (!signal.aborted) {
		const labels = groups.map((group, i) => `${i + 1}. ${group.name} · ${group.cards.length} 条源记录`);
		const choice = await ui.select(`Magpie 额度${snapshot.error ? "（沿用旧读数，本次查询失败）" : ""}`,
			[...labels, "查看读取信息", "返回"], { signal });
		if (signal.aborted || !choice || choice === "返回") return;
		if (choice === "查看读取信息") {
			await ui.select("读取信息", [...snapshotLines(snapshot), "各卡片读数时间见详情；比例与不同账户资源不相加。"], { signal });
			continue;
		}
		const group = groups[labels.indexOf(choice)];
		if (!group) return;
		const sources = new Map<string, MagpieCard[]>();
		for (const card of group.cards) {
			const source = card.from || (card.provider.includes("/") ? card.provider.slice(0, card.provider.lastIndexOf("/")) : "当前网关");
			const entries = sources.get(source) ?? [];
			entries.push(card);
			sources.set(source, entries);
		}
		const names = [...sources.keys()];
		const source = await ui.select(`${group.name} · 来源`, [...names, "返回"], { signal });
		if (signal.aborted || !source || source === "返回") continue;
		const entries = sources.get(source)!;
		const accounts = entries.map((card, i) => cardLabel(card, i));
		const account = await ui.select(`${group.name} · ${source}`, [...accounts, "返回"], { signal });
		if (signal.aborted || !account || account === "返回") continue;
		const card = entries[accounts.indexOf(account)];
		if (card) await ui.select("额度详情（选择任一行返回）", cardDetails(card), { signal });
	}
}

/** 选择的是协议匹配范围；同名卡片和未展示的匹配记录都可能被刷新。 */
export async function chooseRefresh(ui: ExtensionUIContext, cards: MagpieCard[], signal: AbortSignal):
	Promise<{ target?: RefreshTarget } | undefined> {
	const labels = cards.map((card, i) => cardLabel(card, i));
	const choice = await ui.select("刷新上游额度 · 选择影响范围", ["全部可见额度", ...labels], { signal });
	if (signal.aborted || !choice) return;
	const card = cards[labels.indexOf(choice)];
	const target = card ? { provider: card.provider, ...(card.user ? { user: card.user } : {}) } : undefined;
	const description = target
		? `provider=${target.provider}\n${target.user ? `账户匹配：${target.user}（忽略大小写，同名多卡可能共同刷新）` : "未限定账户，将刷新该 provider 的全部可见账户"}`
		: "将刷新当前密钥可见的全部额度卡片";
	if (await ui.confirm("确认刷新上游额度", `${description}\n这是请求供应商重读，不保证读数时间变化；不消耗重置权益。`, { signal }) && !signal.aborted)
		return { target };
}

export function unchangedReadTimes(previous: MagpieCard[] | undefined, next: MagpieCard[] | undefined): boolean {
	if (!previous?.length || !next || previous.length !== next.length) return false;
	const signature = (cards: MagpieCard[]) => cards.map(card =>
		JSON.stringify([card.provider, card.user, card.plan, card.kind, card.from, card.readAt, card.asOf])).sort();
	const before = signature(previous);
	return signature(next).every((value, index) => value === before[index]);
}
