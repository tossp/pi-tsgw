/**
 * Magpie 额度数据的入口解析与保真类型。
 *
 * 两个固定接口的响应外壳不同，但共用卡片外壳：
 * - `GET /v1/magpie/quotas/cards`：`{ object: "list", data: SubscriptionQuota[] }`。
 * - `GET /v1/magpie/statusline?format=json`：`{ text, model, accounts: Quota[] }`。
 *
 * 卡片窗口是 `QuotaWindow`（没有 `remaining`）；状态行账户是额度报告 `Quota`
 * （窗口另有 `remaining`），因此同一个保真卡片类型同时容纳两套窗口字段。
 * 解析只校验已知字段的类型与必需字段，未知字段原样保留并共享同一引用，
 * 不补窗口、不补读数，也不把缺失值当成 0 或 100%。
 */

/** 卡片已知字段均可缺失；未知字段通过索引签名原样保留。 */
export interface MagpieWindow extends Record<string, unknown> {
	name?: string;
	/** 普通窗口的已用百分比；文本行、无总量余额的占位值不是读数。 */
	used?: number;
	/** 厂商给出的展示文本，例如 “1.2k / 3k”；有值时优先展示。 */
	display?: string;
	text?: boolean;
	unlimited?: boolean;
	resetsAt?: string;
	/** 额度报告（statusline 账户）窗口的计算剩余百分比；卡片窗口没有此字段。 */
	remaining?: number;
	amount?: number;
	limit?: number;
	unit?: string;
	/** 窗口级钱包/积分余额；有值时 `used` 未必是占比。 */
	balance?: number;
	spent?: number;
	spentSince?: string;
	runsOutAt?: string;
	runsOut?: number;
	resetSecs?: number;
	pool?: string;
	lane?: string;
	family?: string;
	holdsWhy?: string;
	credits?: boolean;
	extra?: boolean;
	capped?: boolean;
}

export interface MagpieBalancePart extends Record<string, unknown> {
	text: string;
	label?: string;
	percent?: number;
	error?: string;
	expires?: string;
}

/** 用户自填余额减去网关已计费的估算值，不是厂商读数。 */
export interface MagpieEstimate extends Record<string, unknown> {
	set: number;
	at?: string;
	spent: number;
	currency?: string;
	rate?: number;
	left?: number | null;
	from?: string;
	next?: string;
}

export interface MagpieResetCard extends Record<string, unknown> {
	until?: string;
	window?: string;
	id?: string;
}

/** 尚持有的重置权益；列出不代表可以消费，消费入口不属于本扩展。 */
export interface MagpieResetCredits extends Record<string, unknown> {
	count: number;
	until?: string;
	byWindow?: boolean;
	fiveHour?: number;
	weekly?: number;
	team?: boolean;
	each?: MagpieResetCard[];
}

/**
 * 一张额度卡片。`provider` 是 Magpie 的渠道标识（订阅常是 Agent ID），
 * 不必等于厂商名；`from` 是远程 Magpie 名称。同一 `provider/user`
 * 仍可能对应多张独立卡片，调用方不得据此覆盖或相加。
 */
export interface MagpieCard extends Record<string, unknown> {
	provider: string;
	name?: string;
	user?: string;
	plan?: string;
	from?: string;
	kind?: string;
	readAt?: string;
	asOf?: string;
	error?: string;
	balance?: string;
	/** 协议未加 omitempty，窗口未提供时可能为 null；null 与缺失同为“未提供”，不是格式错误。 */
	windows?: MagpieWindow[] | null;
	alias?: string;
	seat?: string;
	sharedBalance?: string;
	balanceSplit?: MagpieBalancePart[];
	/** 与 balanceSplit 同结构的另一组分项（用户书写的多段余额），不得重复相加。 */
	balanceParts?: MagpieBalancePart[];
	estimate?: MagpieEstimate;
	resets?: MagpieResetCredits;
	readDeferred?: boolean;
	until?: string;
	renew?: string;
	lastServedAt?: string;
	held?: boolean;
	last?: boolean;
	pluginError?: boolean;
	needsAccessKey?: boolean;
}

/**
 * statusline 响应。`model` 可能回退为请求名，不证明实际成员；
 * `accounts` 是额度报告口径的卡片，窗口另含 `remaining`。
 */
export interface MagpieStatusline extends Record<string, unknown> {
	text: string;
	model: string;
	accounts: MagpieCard[];
}

/** 形状错误；消息只说明位置与字段，不回显原始值。 */
export class MagpieDataError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MagpieDataError";
	}
}

function invalid(where: string, detail: string): never {
	throw new MagpieDataError(`Magpie 数据无效：${where}${detail}`);
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(where, "必须是 JSON 对象。");
	return value as Record<string, unknown>;
}

function checkString(item: Record<string, unknown>, key: string, where: string): void {
	const value = item[key];
	if (value !== undefined && typeof value !== "string") invalid(where, `的 ${key} 必须是字符串。`);
}

function checkNumber(item: Record<string, unknown>, key: string, where: string): void {
	const value = item[key];
	if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) invalid(where, `的 ${key} 必须是有限数值。`);
}

function checkRequiredNumber(item: Record<string, unknown>, key: string, where: string): void {
	if (typeof item[key] !== "number" || !Number.isFinite(item[key] as number)) invalid(where, `缺少 ${key} 数值。`);
}

function checkBoolean(item: Record<string, unknown>, key: string, where: string): void {
	const value = item[key];
	if (value !== undefined && typeof value !== "boolean") invalid(where, `的 ${key} 必须是布尔值。`);
}

const WINDOW_STRINGS = ["name", "display", "resetsAt", "unit", "pool", "lane", "family", "holdsWhy", "spentSince", "runsOutAt"] as const;
const WINDOW_NUMBERS = ["used", "remaining", "amount", "limit", "balance", "spent", "runsOut", "resetSecs"] as const;
const WINDOW_BOOLEANS = ["text", "unlimited", "credits", "extra", "capped"] as const;

function checkWindow(value: unknown, where: string): MagpieWindow {
	const window = asRecord(value, where);
	for (const key of WINDOW_STRINGS) checkString(window, key, where);
	for (const key of WINDOW_NUMBERS) checkNumber(window, key, where);
	for (const key of WINDOW_BOOLEANS) checkBoolean(window, key, where);
	return window as MagpieWindow;
}

function checkWindows(item: Record<string, unknown>, where: string): void {
	const value = item.windows;
	// null 是协议可能输出的“未提供窗口”，保留原值，不改成 []、也不当作满额。
	if (value === undefined || value === null) return;
	if (!Array.isArray(value)) invalid(where, "的 windows 必须是数组或 null。");
	value.forEach((window, index) => checkWindow(window, `${where}第 ${index + 1} 个窗口`));
}

function checkBalanceParts(item: Record<string, unknown>, key: string, where: string): void {
	const value = item[key];
	if (value === undefined) return;
	if (!Array.isArray(value)) invalid(where, `的 ${key} 必须是数组。`);
	value.forEach((part, index) => {
		const at = `${where}的 ${key} 第 ${index + 1} 项`;
		const record = asRecord(part, at);
		if (typeof record.text !== "string") invalid(at, "缺少 text 字符串。");
		for (const field of ["label", "error", "expires"]) checkString(record, field, at);
		checkNumber(record, "percent", at);
	});
}

function checkEstimate(item: Record<string, unknown>, where: string): void {
	const value = item.estimate;
	if (value === undefined) return;
	const at = `${where}的 estimate`;
	const estimate = asRecord(value, at);
	checkRequiredNumber(estimate, "set", at);
	checkRequiredNumber(estimate, "spent", at);
	for (const key of ["rate"]) checkNumber(estimate, key, at);
	for (const key of ["at", "currency", "from", "next"]) checkString(estimate, key, at);
	const left = estimate.left;
	if (left !== undefined && left !== null && (typeof left !== "number" || !Number.isFinite(left))) invalid(at, "的 left 必须是有限数值或 null。");
}

function checkResets(item: Record<string, unknown>, where: string): void {
	const value = item.resets;
	if (value === undefined) return;
	const at = `${where}的 resets`;
	const resets = asRecord(value, at);
	checkRequiredNumber(resets, "count", at);
	checkString(resets, "until", at);
	for (const key of ["fiveHour", "weekly"]) checkNumber(resets, key, at);
	for (const key of ["byWindow", "team"]) checkBoolean(resets, key, at);
	const each = resets.each;
	if (each === undefined) return;
	if (!Array.isArray(each)) invalid(at, "的 each 必须是数组。");
	each.forEach((card, index) => {
		const whereCard = `${at} 第 ${index + 1} 项`;
		const record = asRecord(card, whereCard);
		for (const key of ["until", "window", "id"]) checkString(record, key, whereCard);
	});
}

const CARD_STRINGS = ["name", "user", "plan", "from", "kind", "readAt", "asOf", "error", "balance", "alias", "seat", "sharedBalance", "until", "renew", "lastServedAt"] as const;
const CARD_BOOLEANS = ["readDeferred", "held", "last", "pluginError", "needsAccessKey"] as const;

function checkCard(value: unknown, where: string): MagpieCard {
	const card = asRecord(value, where);
	if (typeof card.provider !== "string" || !card.provider.trim()) invalid(where, "缺少非空的 provider 字符串。");
	for (const key of CARD_STRINGS) checkString(card, key, where);
	for (const key of CARD_BOOLEANS) checkBoolean(card, key, where);
	checkWindows(card, where);
	checkBalanceParts(card, "balanceSplit", where);
	checkBalanceParts(card, "balanceParts", where);
	checkEstimate(card, where);
	checkResets(card, where);
	return card as MagpieCard;
}

/** 解析 `/v1/magpie/quotas/cards` 响应；返回的卡片与原始对象共享引用。 */
export function parseCards(value: unknown): MagpieCard[] {
	const payload = asRecord(value, "cards 响应");
	if (payload.object !== "list") invalid("cards 响应", "缺少 object:\"list\"。");
	if (!Array.isArray(payload.data)) invalid("cards 响应", "data 必须是数组。");
	payload.data.forEach((card, index) => checkCard(card, `cards 响应第 ${index + 1} 条卡片`));
	return payload.data as MagpieCard[];
}

/** 解析 `/v1/magpie/statusline?format=json` 响应；账户按保真卡片校验。 */
export function parseStatusline(value: unknown): MagpieStatusline {
	const payload = asRecord(value, "statusline 响应");
	for (const key of ["text", "model"]) {
		if (typeof payload[key] !== "string") invalid("statusline 响应", `缺少 ${key} 字符串。`);
	}
	if (!Array.isArray(payload.accounts)) invalid("statusline 响应", "accounts 必须是数组。");
	payload.accounts.forEach((account, index) => checkCard(account, `statusline 响应 accounts 第 ${index + 1} 条卡片`));
	return payload as MagpieStatusline;
}
