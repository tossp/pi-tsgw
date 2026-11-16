import type { MagpieCard, MagpieWindow } from "./data.ts";
import { groupCards } from "./view.ts";

interface Reading {
	percent?: number;
	stale: boolean;
}

/** 底部仅展示 OpenAI：同账户取瓶颈窗口，再取已知账户最大值。 */
export function quotaSummary(cards: readonly MagpieCard[]): string | undefined {
	const group = groupCards(cards).find(group => group.name === "OpenAI / Codex");
	const readings = (group?.cards ?? []).filter(card => !card.held && !card.needsAccessKey).map(cardReading);
	const known = readings.filter((reading): reading is Reading & { percent: number } => reading.percent !== undefined);
	// 当前读数优先，避免一个失败账户的旧高值盖过正常账户的新低值。
	const fresh = known.filter(reading => !reading.stale);
	const usable = fresh.length ? fresh : known;
	if (!usable.length) return;
	const best = Math.max(...usable.map(reading => reading.percent));
	const value = best === Infinity ? "∞" : `${Math.round(best * 100) / 100}%`;
	return `剩余：OpenAI ${value}${fresh.length ? "" : "（旧）"}`;
}

function cardReading(card: MagpieCard): Reading {
	// 独立图片通道与额外消费行不是账户的共同额度限制。
	const windows = (card.windows ?? []).filter(window => !window.lane && !window.extra && !window.text);
	const percentages = windows.map(windowRemaining);
	return {
		percent: percentages.length && percentages.every(percent => percent !== undefined)
			? Math.min(...percentages) : undefined,
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
