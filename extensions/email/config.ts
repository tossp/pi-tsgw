import { normalizeFromDomain } from "./sender-domain.ts";

/** 仅负责账户字段校验；文件定位与按类型加载交给统一配置入口。返回值含凭据，不得普通记录。 */

export type EmailTls = "implicit" | "starttls";

/**
 * IMAP 账户。字段平铺，不设 address/inbox/auth 嵌套。
 * `trashMailbox`、`junkMailbox` 按原样保留（不 trim、不改大小写），仅要求不是 INBOX。
 */
export interface ImapAccountConfig {
	host: string;
	port: number;
	tls: EmailTls;
	user: string;
	password: string;
	trashMailbox: string;
	junkMailbox: string;
}

/**
 * SMTP 账户。字段平铺；`fromName`、`envelopeFrom` 仅在配置了才出现，
 * `allowSenderOverride` 缺省为 false。
 */
export interface SmtpConfig {
	host: string;
	port: number;
	tls: EmailTls;
	user: string;
	password: string;
	fromAddress: string;
	fromName?: string;
	allowSenderOverride: boolean;
	allowedFromDomains?: string[];
	envelopeFrom?: string;
}

/** IMAP 与 SMTP 独立配置；默认发信账户由 SMTP 映射首项决定。 */
export interface EmailConfig {
	imap: Record<string, ImapAccountConfig>;
	smtp: Record<string, SmtpConfig>;
}
const IMAP_FIELDS = [
	"host",
	"port",
	"tls",
	"user",
	"password",
	"trashMailbox",
	"junkMailbox",
] as const;
const SMTP_FIELDS = [
	"host",
	"port",
	"tls",
	"user",
	"password",
	"fromAddress",
	"fromName",
	"allowSenderOverride",
	"allowedFromDomains",
	"envelopeFrom",
] as const;
const ROOT_FIELDS = ["imap", "smtp", "dav"] as const;

// 控制字符会污染邮件头或日志，凭据以外的一切字符串都在入口拒绝。
const CONTROL = /[\u0000-\u001f\u007f]/;
// 只做基础格式与头注入防护，不实现 RFC 5322 解析器。
const ADDRESS_FORBIDDEN = /[\s<>(),;:\\"[\]]/;

/** 只有入口主动构造的安全消息可进入配置或工具结果。 */
export class EmailConfigError extends Error {}

function fail(message: string): never {
	throw new EmailConfigError(`邮件配置无效：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(
	value: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
): void {
	for (const key of Object.keys(value))
		if (!allowed.includes(key)) fail(`${where}包含不支持的字段。`);
}

/** 非空字符串；`password` 之外的字段额外拒绝控制字符。 */
function stringField(
	source: Record<string, unknown>,
	key: string,
	where: string,
	options: { secret?: boolean } = {},
): string {
	const value = source[key];
	if (typeof value !== "string" || value.length === 0)
		fail(`${where}的 ${key} 必须是非空字符串。`);
	// 凭据按原样保留，其余字段拒绝会破坏头部或日志的控制字符。
	if (!options.secret && CONTROL.test(value))
		fail(`${where}的 ${key} 不能包含控制字符。`);
	return value;
}

function portField(source: Record<string, unknown>, key: string, where: string): number {
	const value = source[key];
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535)
		fail(`${where}的 ${key} 必须是 1 到 65535 之间的整数。`);
	return value as number;
}

function tlsField(source: Record<string, unknown>, key: string, where: string): EmailTls {
	const value = source[key];
	if (value !== "implicit" && value !== "starttls")
		fail(`${where}的 ${key} 必须是 "implicit" 或 "starttls"。`);
	return value;
}

function booleanField(source: Record<string, unknown>, key: string, where: string): boolean {
	const value = source[key];
	if (typeof value !== "boolean") fail(`${where}的 ${key} 必须是布尔值。`);
	return value;
}

/** 特殊用途文件夹使用服务器上的精确路径，不猜名称、不改写路径。 */
function mailboxField(source: Record<string, unknown>, key: string, where: string): string {
	const value = stringField(source, key, where);
	if (value.toUpperCase() === "INBOX") fail(`${where}的 ${key} 不能是 INBOX。`);
	return value;
}

/** 基础邮件地址校验：恰一个 @、两侧非空、无空白/控制/分隔符；允许内部域名。 */
function addressField(source: Record<string, unknown>, key: string, where: string): string {
	const value = stringField(source, key, where);
	const at = value.indexOf("@");
	const domain = at < 0 ? "" : value.slice(at + 1);
	if (at <= 0 || at !== value.lastIndexOf("@") || domain.length === 0
		|| ADDRESS_FORBIDDEN.test(value))
		fail(`${where}的 ${key} 必须是基础格式的邮件地址。`);
	return value;
}

function accountWhere(channel: string, index: number): string {
	return `${channel} 第 ${index + 1} 个账户`;
}

function checkAccountId(channel: string, index: number, id: string): void {
	if (id.length === 0 || CONTROL.test(id))
		fail(`${channel} 第 ${index + 1} 个账户的 ID 必须是非空且不含控制字符的字符串。`);
}

export function parseImapAccounts(raw: unknown): Record<string, ImapAccountConfig> {
	if (!isRecord(raw)) fail("imap 必须是账户 ID 到账户配置的映射对象。");
	const ids = Object.keys(raw);
	const entries: [string, ImapAccountConfig][] = [];
	for (const [index, id] of ids.entries()) {
		checkAccountId("imap", index, id);
		const where = accountWhere("imap", index);
		const value = raw[id];
		if (!isRecord(value)) fail(`${where}必须是对象。`);
		rejectUnknownFields(value, IMAP_FIELDS, where);
		const account: ImapAccountConfig = {
			host: stringField(value, "host", where),
			port: portField(value, "port", where),
			tls: tlsField(value, "tls", where),
			user: stringField(value, "user", where),
			password: stringField(value, "password", where, { secret: true }),
			trashMailbox: mailboxField(value, "trashMailbox", where),
			junkMailbox: mailboxField(value, "junkMailbox", where),
		};
		if (account.trashMailbox === account.junkMailbox)
			fail(`${where}的 trashMailbox 与 junkMailbox 不能相同。`);
		entries.push([id, account]);
	}
	return Object.fromEntries(entries);
}

export function parseSmtpConfigs(raw: unknown): Record<string, SmtpConfig> {
	if (!isRecord(raw)) fail("smtp 必须是账户 ID 到账户配置的映射对象。");
	const ids = Object.keys(raw);
	const entries: [string, SmtpConfig][] = [];
	for (const [index, id] of ids.entries()) {
		checkAccountId("smtp", index, id);
		const where = accountWhere("smtp", index);
		const value = raw[id];
		if (!isRecord(value)) fail(`${where}必须是对象。`);
		rejectUnknownFields(value, SMTP_FIELDS, where);
		const config: SmtpConfig = {
			host: stringField(value, "host", where),
			port: portField(value, "port", where),
			tls: tlsField(value, "tls", where),
			user: stringField(value, "user", where),
			password: stringField(value, "password", where, { secret: true }),
			fromAddress: addressField(value, "fromAddress", where),
			allowSenderOverride: "allowSenderOverride" in value
				? booleanField(value, "allowSenderOverride", where)
				: false,
		};
		if ("allowedFromDomains" in value) {
			config.allowedFromDomains = fromDomainsField(value.allowedFromDomains, where);
			if (!config.allowedFromDomains.includes(normalizeFromDomain(config.fromAddress.split("@")[1]) ?? ""))
				fail(`${where}的默认 fromAddress 域必须属于 allowedFromDomains。`);
		}
		if ("fromName" in value) config.fromName = stringField(value, "fromName", where);
		if ("envelopeFrom" in value) config.envelopeFrom = addressField(value, "envelopeFrom", where);
		entries.push([id, config]);
	}
	return Object.fromEntries(entries);
}

function fromDomainsField(raw: unknown, where: string): string[] {
	if (!Array.isArray(raw) || raw.length === 0)
		fail(`${where}的 allowedFromDomains 必须是非空域名数组。`);
	return raw.map(value => {
		const domain = typeof value === "string" ? normalizeFromDomain(value) : undefined;
		if (!domain)
			fail(`${where}的 allowedFromDomains 必须包含有效域名，不支持通配符或地址。`);
		return domain;
	});
}

/**
 * 解析并校验邮件配置值。非法时抛出不含字段值的安全中文错误，
 * 合法的凭据按原样保留，不做 trim、大小写或编码转换。
 */
export function parseEmailConfig(raw: unknown): EmailConfig {
	if (!isRecord(raw)) fail("顶层必须是 JSON 对象。");
	rejectUnknownFields(raw, ROOT_FIELDS, "顶层");
	return {
		imap: Object.hasOwn(raw, "imap") ? parseImapAccounts(raw.imap) : {},
		smtp: Object.hasOwn(raw, "smtp") ? parseSmtpConfigs(raw.smtp) : {},
	};
}
