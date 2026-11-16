/**
 * Magpie 额度卡片的纯展示投影：分组、标签与逐条明细。
 *
 * 这里不读取配置、不发请求，也不补充读数：输入是 data.ts 已校验的保真卡片，
 * 输出是给菜单/详情直接使用的文本。数组顺序、对象引用和未知字段都保持原样，
 * 同一 provider/user 的多张卡片各自渲染，绝不相加或去重。
 */
import type {
	MagpieBalancePart,
	MagpieCard,
	MagpieEstimate,
	MagpieResetCredits,
	MagpieStatusline,
	MagpieWindow,
} from "./data.ts";

export interface MagpieCardGroup {
	name: string;
	cards: MagpieCard[];
}

/** 已证实的厂商/产品族。Magpie 的 provider 对订阅常是产品标识（codex、kimi-code），
 * 对套餐/余额是渠道标识；远程卡片被改写成 `远程/provider`（可能链式），
 * 真实产品在最后一个路径段，因此只据末段与已知产品对照，不做启发式猜测。 */
const VENDOR_FAMILIES: Readonly<Record<string, string>> = {
	codex: "OpenAI / Codex",
	claude: "Anthropic / Claude",
	minimax: "MiniMax",
	"minimax-cn": "MiniMax",
	deepseek: "DeepSeek",
	kimi: "Moonshot / Kimi",
	"kimi-code": "Moonshot / Kimi",
	"kimi-code-cn": "Moonshot / Kimi",
	moonshot: "Moonshot / Kimi",
	"moonshot-cn": "Moonshot / Kimi",
};

function nonEmpty(value: string | undefined): string | undefined {
	const text = value?.trim();
	return text ? text : undefined;
}

/** 完整来源：远程卡片保留“远程 Magpie 名/provider”，不按展示名改写成厂商。 */
function sourceOf(card: MagpieCard): string {
	const from = nonEmpty(card.from);
	if (from && !card.provider.startsWith(`${from}/`)) return `${from}/${card.provider}`;
	return card.provider;
}

function isRemote(card: MagpieCard): boolean {
	return Boolean(nonEmpty(card.from)) || card.provider.includes("/");
}

/** 远程 provider 形如 `远程/product`，可链式；末段与 provider 自身同属于产品标识。 */
function productSegment(provider: string): string {
	return provider.slice(provider.lastIndexOf("/") + 1);
}

/** 已知产品族优先：远程 codex 与本地 codex 同属 OpenAI / Codex，来源由组内再分。 */
function groupName(card: MagpieCard): string {
	const family = VENDOR_FAMILIES[productSegment(card.provider).toLowerCase()];
	if (family) return family;
	return isRemote(card) ? sourceOf(card) : card.provider;
}

/** 按厂商/产品族分组；未知产品与未知远程来源保持自身名称，组内顺序按首次出现。 */
export function groupCards(cards: readonly MagpieCard[]): MagpieCardGroup[] {
	const groups = new Map<string, MagpieCardGroup>();
	for (const card of cards) {
		const name = groupName(card);
		let group = groups.get(name);
		if (!group) {
			group = { name, cards: [] };
			groups.set(name, group);
		}
		group.cards.push(card);
	}
	return [...groups.values()];
}

/** 卡片标签；同名卡片由调用方传入的列表下标区分，不合并记录。 */
export function cardLabel(card: MagpieCard, index?: number): string {
	const parts: string[] = [];
	const add = (value: string | undefined): void => {
		const text = nonEmpty(value);
		if (text && !parts.includes(text)) parts.push(text);
	};
	add(card.name);
	add(card.alias);
	add(card.user);
	add(card.plan);
	if (isRemote(card)) add(sourceOf(card));
	if (!parts.length) add(card.provider);
	const label = parts.join(" · ");
	return index === undefined ? label : `${label}（#${index + 1}）`;
}

function kindLabel(kind: string | undefined): string | undefined {
	switch (kind) {
		case "subscription": return "订阅账户";
		case "plan": return "密钥套餐";
		case "balance": return "密钥余额";
		default: return nonEmpty(kind);
	}
}

function withUnit(value: number, unit: string | undefined): string {
	return unit ? `${value} ${unit}` : String(value);
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

// 输入已由 data.ts 校验，这里只按语义判断（文本行、无总量钱包、有效百分比），不重复校验类型。
function windowLine(window: MagpieWindow): string {
	const name = nonEmpty(window.name) ?? "未命名窗口";
	const details: string[] = [];
	const display = nonEmpty(window.display);
	if (display) details.push(display);
	const unlimited = window.unlimited === true;
	const isText = window.text === true;
	const wallet = window.balance;
	const limit = window.limit !== undefined && window.limit > 0 ? window.limit : undefined;
	const unit = nonEmpty(window.unit);
	const used = window.used;

	if (unlimited) details.push("无限额");
	if (isText) {
		// 文本行的 used 不是占比；没有 display 时只能说读数未知，不能补成满额。
		details.push(display ? "文本行（used 不是占比）" : "文本读数未知（used 不是占比）");
	} else if (!unlimited) {
		// 钱包窗口没有总量时，used=0 不代表未使用，只有 amount/limit 才构成占比。
		const percentReadable = used !== undefined && used >= 0 && used <= 100 && (wallet === undefined || limit !== undefined);
		if (used !== undefined && percentReadable) {
			details.push(`已用 ${used}%`);
			const remaining = window.remaining ?? round2(100 - used);
			details.push(`剩余 ${remaining}%`);
		} else if (used !== undefined && (used < 0 || used > 100)) {
			details.push(`used=${used}（超出百分比范围，不是有效读数）`);
		}
		if (wallet !== undefined) details.push(`钱包余额 ${withUnit(wallet, unit)}`);
		if (limit !== undefined) details.push(`计量 ${withUnit(window.amount ?? 0, unit)} / ${withUnit(limit, unit)}`);
		if (!display && wallet === undefined && limit === undefined && used === undefined) details.push("读数未知");
	}
	if (window.resetsAt) details.push(`重置 ${window.resetsAt}`);
	if (window.runsOut !== undefined || window.runsOutAt) {
		const runsOut = window.runsOut !== undefined ? withUnit(window.runsOut, unit) : "数量未知";
		details.push(`到期失效 ${runsOut}${window.runsOutAt ? `（${window.runsOutAt}）` : "（时间未知）"}`);
	}
	if (window.spent !== undefined || window.spentSince) {
		const spent = window.spent !== undefined ? withUnit(window.spent, unit) : "数量未知";
		details.push(`本周期已花费 ${spent}${window.spentSince ? `（自 ${window.spentSince}）` : ""}`);
	}
	if (window.pool) details.push(`共享池 ${window.pool}`);
	if (window.lane) details.push(`通道 ${window.lane}`);
	if (window.family) details.push(`族 ${window.family}`);
	return `${name}：${details.join("；")}`;
}

function balancePartLine(part: MagpieBalancePart): string {
	const label = nonEmpty(part.label);
	const percent = part.percent !== undefined ? `（${part.percent}%）` : "";
	const error = nonEmpty(part.error) ? `；读取错误：${part.error}` : "";
	const expires = nonEmpty(part.expires) ? `；到期 ${part.expires}` : "";
	return `余额分项：${part.text}${label ? `（${label}）` : ""}${percent}${expires}${error}`;
}

function estimateLine(estimate: MagpieEstimate): string {
	const since = nonEmpty(estimate.from) ?? nonEmpty(estimate.at) ?? "未知时间";
	const currency = nonEmpty(estimate.currency);
	const currencyNote = currency ? `（${currency}）` : "";
	const left = estimate.left !== null && estimate.left !== undefined ? withUnit(estimate.left, undefined) : undefined;
	return `估算余额（非厂商读数）：设定 ${estimate.set}，自 ${since} 起已用 ${estimate.spent}${left === undefined ? "" : `，剩余 ${left}`}${currencyNote}`;
}

function renewLabel(renew: string | undefined): string {
	if (renew === "auto") return "自动续期";
	if (renew === "off") return "不续期";
	return "续期状态未知";
}

function resetsLine(resets: MagpieResetCredits): string {
	const parts = [`重置权益：${resets.count} 次`];
	if (resets.until) parts.push(`最近至 ${resets.until}`);
	if (resets.byWindow) {
		const windows: string[] = [];
		if (resets.fiveHour !== undefined) windows.push(`五小时 ${resets.fiveHour}`);
		if (resets.weekly !== undefined) windows.push(`每周 ${resets.weekly}`);
		if (windows.length) parts.push(`按窗口（${windows.join("，")}）`);
	}
	if (resets.team) parts.push("团队套餐");
	return parts.join("；");
}

/** 余额、分项、共享余额、估算与重置权益；都按源记录各自展示，不相加。 */
function fundsLines(card: MagpieCard): string[] {
	const lines: string[] = [];
	if (nonEmpty(card.balance)) lines.push(`余额：${card.balance}（仅此记录，不与同厂商其他卡片相加）`);
	const parts = [...(card.balanceSplit ?? []), ...(card.balanceParts ?? [])];
	if (parts.length) {
		lines.push("余额分项（同一笔余额的拆分，不与余额或其他卡片相加）：");
		for (const part of parts) lines.push(balancePartLine(part));
	}
	if (card.sharedBalance) lines.push(`共享余额：与「${card.sharedBalance}」共用，不能按卡片重复相加。`);
	if (card.estimate) lines.push(estimateLine(card.estimate));
	if (card.resets) {
		lines.push(resetsLine(card.resets));
		for (const reset of card.resets.each ?? []) {
			const window = nonEmpty(reset.window);
			lines.push(`权益项：${nonEmpty(reset.until) ?? "无到期时间"}${window ? `（${window}）` : ""}`);
		}
	}
	return lines;
}

/** 逐条卡片明细；账户、读数时间、错误、余额与权益都按源记录展示。 */
export function cardDetails(card: MagpieCard): string[] {
	const lines: string[] = [];
	lines.push(`来源：${sourceOf(card)}`);
	const kind = kindLabel(card.kind);
	if (kind) lines.push(`类型：${kind}`);
	lines.push(`账户：${nonEmpty(card.user) ?? "未提供"}`);
	if (card.alias) lines.push(`账户别名：${card.alias}`);
	if (card.seat) lines.push(`代替的密钥套餐：${card.seat}`);
	lines.push(`套餐：${nonEmpty(card.plan) ?? "未提供"}`);
	if (card.until) lines.push(`付费有效期至：${card.until}（${renewLabel(card.renew)}）`);
	if (card.held) lines.push("该账户当前未被网关派发（held）。");
	if (card.needsAccessKey) lines.push("缺少该账户的读取密钥，额度未取得。");
	lines.push(`读数时间：${nonEmpty(card.readAt) ?? "未提供"}`);
	if (card.asOf) lines.push(`旧读数时间：${card.asOf}（沿用此前读数）`);
	if (card.readDeferred) lines.push("本次未主动读取（沿用缓存）。");
	if (nonEmpty(card.error)) lines.push(`本次记录错误：${card.error}`);
	lines.push(...fundsLines(card));
	const windows = card.windows;
	if (windows == null) lines.push("窗口：未提供（不能视为无限额或满额）");
	else if (!windows.length) lines.push("窗口：未返回（可能是余额卡、尚无读数或未取得窗口）");
	else for (const window of windows) lines.push(`窗口：${windowLine(window)}`);
	if (card.lastServedAt) lines.push(`最近经网关答复：${card.lastServedAt}`);
	return lines;
}

/** 状态行明细；模型名只称为网关报告值，成员判定留给路由数据。 */
export function statusDetails(status: MagpieStatusline): string[] {
	const lines: string[] = [];
	lines.push(`模型（网关状态报告值）：${status.model || "未提供"}`);
	lines.push("该模型名可能是请求名回退，不能证明实际执行的成员。");
	const text = nonEmpty(status.text);
	if (text) lines.push(`网关状态行：${text}`);
	if (!status.accounts.length) lines.push("账户卡片：未返回（不代表没有账户或额度）。");
	else {
		const failed = status.accounts.filter(account => nonEmpty(account.error)).length;
		lines.push(`账户卡片：${status.accounts.length} 条${failed ? `，其中 ${failed} 条带本次错误` : ""}。`);
		for (const [index, account] of status.accounts.entries()) {
			lines.push(`${cardLabel(account, index)} · 读数时间：${account.readAt || account.asOf || "未提供"}`);
			if (account.asOf) lines.push(`沿用旧读数：${account.asOf}`);
			if (account.error) lines.push(`本次记录错误：${account.error}`);
		}
	}
	return lines;
}
