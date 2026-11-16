import type { MagpieCard, MagpieWindow } from "./data.ts";
import { groupCards } from "./view.ts";

const SHORT_NAMES: Readonly<Record<string, string>> = {
	"OpenAI / Codex": "OpenAI",
	"Anthropic / Claude": "Claude",
	"Moonshot / Kimi": "Kimi",
};

interface Reading {
	percent?: number;
	balances: string[];
	stale: boolean;
}

/** 同账户取瓶颈窗口，同厂商取已知账户最大值；金额只展示，不相加或折算。 */
export function quotaSummary(cards: readonly MagpieCard[]): string {
	const groups = groupCards(cards);
	if (!groups.length) return "剩余：?";
	return `剩余：${groups.map(group => {
		const readings = group.cards.filter(card => !card.held && !card.needsAccessKey).map(cardReading);
		const known = readings.filter(reading => reading.percent !== undefined || reading.balances.length);
		// 当前读数优先，避免一个失败账户的旧高值盖过正常账户的新低值。
		const fresh = known.filter(reading => !reading.stale);
		const usable = fresh.length ? fresh : known;
		const percentages = usable.flatMap(reading => reading.percent === undefined ? [] : [reading.percent]);
		const parts: string[] = [];
		if (percentages.length) {
			const best = Math.max(...percentages);
			parts.push(best === Infinity ? "∞" : `${Math.round(best * 100) / 100}%`);
		} else parts.push(...new Set(usable.flatMap(reading => reading.balances)));
		if (!parts.length) parts.push("?");
		else if (readings.some(reading => reading.percent === undefined && !reading.balances.length)) parts.push("?");
		const stale = usable.length && !fresh.length ? "（旧）" : "";
		return `${SHORT_NAMES[group.name] ?? group.name} ${parts.join("/")}${stale}`;
	}).join(" · ")}`.replace(/[\r\n]+/g, " ");
}

function cardReading(card: MagpieCard): Reading {
	const balances: string[] = [];
	if (card.balance?.trim()) balances.push(card.balance.trim());
	// 独立图片通道与额外消费行不是账户的共同额度限制。
	const windows = (card.windows ?? []).filter(window => !window.lane && !window.extra && !window.text);
	const percentages: number[] = [];
	let unknown = false;
	for (const window of windows) {
		if (window.balance !== undefined) balances.push(`${window.balance}${window.unit ? ` ${window.unit}` : ""}`);
		const percent = windowRemaining(window);
		if (percent !== undefined) percentages.push(percent);
		else if (window.balance === undefined) unknown = true;
	}
	return {
		percent: !unknown && percentages.length ? Math.min(...percentages) : undefined,
		balances,
		stale: Boolean(card.error?.trim() || card.asOf?.trim()),
	};
}

function windowRemaining(window: MagpieWindow): number | undefined {
	if (window.unlimited) return Infinity;
	// 没有总量的钱包 used/remaining 不是百分比。
	if (window.balance !== undefined && !(window.limit !== undefined && window.limit > 0)) return;
	const used = window.used;
	if (used !== undefined && (used < 0 || used > 100)) return;
	const remaining = window.remaining ?? (used === undefined ? undefined : 100 - used);
	if (remaining === undefined || remaining < 0 || remaining > 100) return;
	return remaining;
}
