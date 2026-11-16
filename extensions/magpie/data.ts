/**
 * Magpie 额度数据的入口解析与保真类型。
 *
 * 两个固定接口的响应外壳不同，但共用卡片外壳：
 * - `GET /v1/magpie/quotas/cards`：`{ object: "list", data: SubscriptionQuota[] }`。
 * - `GET /v1/magpie/statusline?format=json`：`{ text, model, accounts: Quota[] }`。
 *
 * 卡片窗口是 `QuotaWindow`（没有 `remaining`）；状态行账户是额度报告 `Quota`
 * （窗口另有 `remaining`），因此同一个保真卡片类型同时容纳两套窗口字段。
 *
 * 额度是参考快照：厂商身份和可解释读数是核心，附加展示／辅助字段允许陈旧、
 * 缺失或类型漂移。入口只做一次校验，已知字段异常时局部剔除或把读数降为未知，
 * 无法识别 provider 的卡片跳过；顶层列表缺失或不可识别仍明确失败，避免无效
 * 响应冒充空成功。合法对象保持原引用，需要修改时最小 copy-on-write，未知字段
 * 随浅拷贝保留引用；不补窗口、不补读数，也不把缺失值当成 0 或 100%。
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
 * `provider` 缺失或不可识别的卡片在入口跳过；其余已知字段异常只做局部降级。
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
 * statusline 响应。`text`／`model` 只是展示信息，缺失或类型异常按未提供处理；
 * `accounts` 是额度报告口径的卡片列表，缺失或非数组仍视为顶层形状错误。
 * `model` 可能回退为请求名，不证明实际成员。
 */
export interface MagpieStatusline extends Record<string, unknown> {
	text?: string;
	model?: string;
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
	if (!isRecord(value)) invalid(where, "必须是 JSON 对象。");
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * 惰性 copy-on-write：只有确实需要剔除或替换字段时才复制对象。
 * 浅拷贝保留未知字段及其引用；没有改动时调用方继续返回原对象。
 */
function editor(record: Record<string, unknown>) {
	let copy: Record<string, unknown> | undefined;
	const current = (): Record<string, unknown> => copy ?? record;
	return {
		value: current,
		changed: (): boolean => copy !== undefined,
		drop(key: string): void {
			if (!Object.hasOwn(current(), key)) return;
			copy ??= { ...record };
			delete copy[key];
		},
		set(key: string, value: unknown): void {
			if (Object.hasOwn(current(), key) && current()[key] === value) return;
			copy ??= { ...record };
			copy[key] = value;
		},
	};
}

function dropWrongStrings(target: ReturnType<typeof editor>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = target.value()[key];
		if (value !== undefined && typeof value !== "string") target.drop(key);
	}
}

function dropWrongNumbers(target: ReturnType<typeof editor>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = target.value()[key];
		if (value !== undefined && !isFiniteNumber(value)) target.drop(key);
	}
}

function dropWrongBooleans(target: ReturnType<typeof editor>, keys: readonly string[]): void {
	for (const key of keys) {
		const value = target.value()[key];
		if (value !== undefined && typeof value !== "boolean") target.drop(key);
	}
}

const WINDOW_STRINGS = ["name", "display", "resetsAt", "unit", "pool", "lane", "family", "holdsWhy", "spentSince", "runsOutAt"] as const;
const WINDOW_NUMBERS = ["used", "remaining", "amount", "limit", "balance", "spent", "runsOut", "resetSecs"] as const;
const WINDOW_BOOLEANS = ["text", "unlimited", "credits", "extra", "capped"] as const;

function sanitizeWindow(value: unknown): MagpieWindow {
	// 窗口本身无法识别时保留一个未知窗口占位，避免汇总把剩余窗口当成完整额度。
	if (!isRecord(value)) return {};
	const target = editor(value);
	const original = target.value();
	// 文本行、无限额、独立通道、额外消费和钱包都会改变 used 的语义。标记存在但
	// 类型异常时不能只删标记，否则 used=0 可能被误算成剩余 100%；清空读数降为未知。
	const readingsUnknown =
		(original.text !== undefined && typeof original.text !== "boolean") ||
		(original.unlimited !== undefined && typeof original.unlimited !== "boolean") ||
		(original.extra !== undefined && typeof original.extra !== "boolean") ||
		(original.lane !== undefined && typeof original.lane !== "string") ||
		(original.balance !== undefined && !isFiniteNumber(original.balance));
	dropWrongStrings(target, WINDOW_STRINGS);
	dropWrongNumbers(target, WINDOW_NUMBERS);
	dropWrongBooleans(target, WINDOW_BOOLEANS);
	if (readingsUnknown) {
		target.drop("used");
		target.drop("remaining");
	}
	return target.value() as MagpieWindow;
}

function sanitizeWindows(value: unknown): { value: MagpieWindow[] | null | undefined; changed: boolean } {
	// null 是协议可能输出的“未提供窗口”，保留原值，不改成 []、也不当作满额。
	if (value === undefined || value === null) return { value, changed: false };
	if (!Array.isArray(value)) return { value: undefined, changed: true };
	let changed = false;
	const windows = value.map(item => {
		const window = sanitizeWindow(item);
		if (window !== item) changed = true;
		return window;
	});
	return { value: changed ? windows : value as MagpieWindow[], changed };
}

function sanitizeBalanceParts(value: unknown): MagpieBalancePart[] | undefined {
	if (value === undefined) return;
	if (!Array.isArray(value)) return;
	let changed = false;
	const parts: MagpieBalancePart[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.text !== "string") {
			changed = true;
			continue;
		}
		const target = editor(item);
		dropWrongStrings(target, ["label", "error", "expires"]);
		dropWrongNumbers(target, ["percent"]);
		if (target.changed()) changed = true;
		parts.push(target.value() as MagpieBalancePart);
	}
	return changed ? parts : value as MagpieBalancePart[];
}

function sanitizeEstimate(value: unknown): MagpieEstimate | undefined {
	// set／spent 是估算可解释的最小前提；缺失或异常时整项降级，不编造读数。
	if (!isRecord(value) || !isFiniteNumber(value.set) || !isFiniteNumber(value.spent)) return;
	const target = editor(value);
	dropWrongNumbers(target, ["rate"]);
	dropWrongStrings(target, ["at", "currency", "from", "next"]);
	const left = target.value().left;
	if (left !== undefined && left !== null && !isFiniteNumber(left)) target.drop("left");
	return target.value() as MagpieEstimate;
}

function sanitizeResets(value: unknown): MagpieResetCredits | undefined {
	// count 是重置权益条目的核心；不可解释时整项降级，不凭 each 长度补 count。
	if (!isRecord(value) || !isFiniteNumber(value.count)) return;
	const target = editor(value);
	dropWrongStrings(target, ["until"]);
	dropWrongNumbers(target, ["fiveHour", "weekly"]);
	dropWrongBooleans(target, ["byWindow", "team"]);
	const each = target.value().each;
	if (each !== undefined) {
		if (!Array.isArray(each)) target.drop("each");
		else {
			let changed = false;
			const cards: MagpieResetCard[] = [];
			for (const item of each) {
				if (!isRecord(item)) {
					changed = true;
					continue;
				}
				const card = editor(item);
				dropWrongStrings(card, ["until", "window", "id"]);
				if (card.changed()) changed = true;
				cards.push(card.value() as MagpieResetCard);
			}
			if (changed) target.set("each", cards);
		}
	}
	return target.value() as MagpieResetCredits;
}

const CARD_STRINGS = ["name", "user", "plan", "from", "kind", "readAt", "asOf", "error", "balance", "alias", "seat", "sharedBalance", "until", "renew", "lastServedAt"] as const;
const CARD_BOOLEANS = ["readDeferred", "held", "last", "pluginError", "needsAccessKey"] as const;
const MALFORMED_READING = "记录字段异常，读数按旧读数处理。";

function replaceNested(target: ReturnType<typeof editor>, key: string, original: unknown, next: unknown): void {
	if (original === undefined) return;
	if (next === undefined) target.drop(key);
	else if (next !== original) target.set(key, next);
}

function sanitizeCard(value: unknown): MagpieCard | undefined {
	// provider 是卡片身份；无法识别时无法分组、刷新或解释读数，只跳过这一条。
	if (!isRecord(value) || typeof value.provider !== "string" || !value.provider.trim()) return;
	const target = editor(value);
	const original = target.value();
	const errorMalformed = original.error !== undefined && typeof original.error !== "string";
	const asOfMalformed = original.asOf !== undefined && typeof original.asOf !== "string";
	const heldMalformed = original.held !== undefined && typeof original.held !== "boolean";
	const accessKeyMalformed = original.needsAccessKey !== undefined && typeof original.needsAccessKey !== "boolean";
	dropWrongStrings(target, CARD_STRINGS);
	dropWrongBooleans(target, CARD_BOOLEANS);
	// error／asOf 是“读数可能陈旧”的语义标记；类型异常时保留一个通用错误标记，
	// 避免删掉后旧读数被当成新鲜读数展示。
	if (errorMalformed || (asOfMalformed && original.error === undefined)) target.set("error", MALFORMED_READING);
	// 派发／密钥状态无法解释时保留参考读数并标记不确定，不能编造停派或缺密钥事实。
	if (heldMalformed || accessKeyMalformed)
		target.set("error", "账户状态字段异常，额度仅供参考。");

	if (original.windows !== undefined) {
		const windows = sanitizeWindows(original.windows);
		if (windows.value === undefined) target.drop("windows");
		else if (windows.changed) target.set("windows", windows.value);
	}
	replaceNested(target, "balanceSplit", original.balanceSplit, sanitizeBalanceParts(original.balanceSplit));
	replaceNested(target, "balanceParts", original.balanceParts, sanitizeBalanceParts(original.balanceParts));
	replaceNested(target, "estimate", original.estimate, sanitizeEstimate(original.estimate));
	replaceNested(target, "resets", original.resets, sanitizeResets(original.resets));
	return target.value() as MagpieCard;
}

/**
 * 解析 `/v1/magpie/quotas/cards` 响应。无法识别 provider 的卡片跳过；其余卡片
 * 局部降级。全部合法时返回原始数组及卡片引用，否则返回保留原引用的新数组。
 */
export function parseCards(value: unknown): MagpieCard[] {
	const payload = asRecord(value, "cards 响应");
	if (!Array.isArray(payload.data)) invalid("cards 响应", "data 必须是数组。");
	let changed = false;
	const cards: MagpieCard[] = [];
	for (const item of payload.data) {
		const card = sanitizeCard(item);
		if (!card) {
			changed = true;
			continue;
		}
		if (card !== item) changed = true;
		cards.push(card);
	}
	return changed ? cards : payload.data as MagpieCard[];
}

/** 解析 `/v1/magpie/statusline?format=json` 响应；展示字段降级，账户按保真卡片处理。 */
export function parseStatusline(value: unknown): MagpieStatusline {
	const payload = asRecord(value, "statusline 响应");
	if (!Array.isArray(payload.accounts)) invalid("statusline 响应", "accounts 必须是数组。");
	const target = editor(payload);
	for (const key of ["text", "model"] as const) {
		const current = target.value()[key];
		if (current !== undefined && typeof current !== "string") target.drop(key);
	}
	let accountsChanged = false;
	const accounts: MagpieCard[] = [];
	for (const item of payload.accounts) {
		const card = sanitizeCard(item);
		if (!card) {
			accountsChanged = true;
			continue;
		}
		if (card !== item) accountsChanged = true;
		accounts.push(card);
	}
	if (accountsChanged) target.set("accounts", accounts);
	return target.value() as MagpieStatusline;
}
