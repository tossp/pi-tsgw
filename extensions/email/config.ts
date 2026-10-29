import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * 邮件配置只读取宿主 agent 目录下的 `tsgw-email.json`。
 * 文件不存在表示邮件功能关闭；配置无效时只让邮件不可用，不抛错影响其他功能。
 * 文件与返回值都含明文凭据：调用方不得普通记录 ready 的 config 或原始文件内容。
 */

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
	envelopeFrom?: string;
}

/** 顶层 `imap`、`smtp` 是账户 ID 映射；`defaultSmtp` 必须是 `smtp` 的自有键。 */
export interface EmailConfig {
	imap: Record<string, ImapAccountConfig>;
	smtp: Record<string, SmtpConfig>;
	defaultSmtp: string;
}

const CONFIG_FILE = "tsgw-email.json";
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
	"envelopeFrom",
] as const;
const ROOT_FIELDS = ["imap", "smtp", "defaultSmtp"] as const;

// 控制字符会污染邮件头或日志，凭据以外的一切字符串都在入口拒绝。
const CONTROL = /[\u0000-\u001f\u007f]/;
// 只做基础格式与头注入防护，不实现 RFC 5322 解析器。
const ADDRESS_FORBIDDEN = /[\s<>(),;:\\"[\]]/;

/** 内部错误类型：`readEmailConfig` 只向调用方转发本类型的安全消息。 */
class EmailConfigError extends Error {}

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

function parseImapAccounts(raw: unknown): Record<string, ImapAccountConfig> {
	if (!isRecord(raw)) fail("imap 必须是账户 ID 到账户配置的映射对象。");
	const ids = Object.keys(raw);
	if (ids.length === 0) fail("imap 至少需要一个账户。");
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

function parseSmtpConfigs(raw: unknown): Record<string, SmtpConfig> {
	if (!isRecord(raw)) fail("smtp 必须是账户 ID 到账户配置的映射对象。");
	const ids = Object.keys(raw);
	if (ids.length === 0) fail("smtp 至少需要一个账户。");
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
		if ("fromName" in value) config.fromName = stringField(value, "fromName", where);
		if ("envelopeFrom" in value) config.envelopeFrom = addressField(value, "envelopeFrom", where);
		entries.push([id, config]);
	}
	return Object.fromEntries(entries);
}

/**
 * 解析并校验邮件配置值。非法时抛出不含字段值的安全中文错误，
 * 合法的凭据按原样保留，不做 trim、大小写或编码转换。
 */
export function parseEmailConfig(raw: unknown): EmailConfig {
	if (!isRecord(raw)) fail("顶层必须是 JSON 对象。");
	rejectUnknownFields(raw, ROOT_FIELDS, "顶层");
	const imap = parseImapAccounts(raw.imap);
	const smtp = parseSmtpConfigs(raw.smtp);
	const defaultSmtp = raw.defaultSmtp;
	if (typeof defaultSmtp !== "string" || defaultSmtp.length === 0)
		fail("defaultSmtp 必须是已定义 SMTP 账户的 ID。");
	// 用自有键判断，避免 toString、constructor 等原型属性冒充已定义账户。
	if (!Object.hasOwn(smtp, defaultSmtp))
		fail("defaultSmtp 必须是 smtp 中已定义的账户 ID。");
	return { imap, smtp, defaultSmtp };
}

/**
 * 读取宿主 agent 目录中的邮件配置（测试可显式传入 agentDir）。
 * 只读批准文件：不创建目录或文件、不扫描旧配置、不迁移凭据、不联网。
 */
export function readEmailConfig(agentDir?: string):
	| { status: "disabled" }
	| { status: "invalid"; message: string }
	| { status: "ready"; config: EmailConfig } {
	let path: string;
	try {
		path = join(agentDir ?? getAgentDir(), CONFIG_FILE);
	} catch {
		return { status: "invalid", message: "无法定位邮件配置文件。" };
	}
	let text: string;
	try {
		const stats = statSync(path);
		if (!stats.isFile()) return { status: "invalid", message: "邮件配置路径不是普通文件。" };
		if ((stats.mode & 0o777) !== 0o600)
			return { status: "invalid", message: "邮件配置文件权限必须是 0600。" };
		text = readFileSync(path, "utf8");
	} catch (error) {
		// 无文件（含 agent 目录尚不存在）视为关闭，其余读取失败视为配置无效。
		const code = (error as { code?: unknown } | null)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") return { status: "disabled" };
		return { status: "invalid", message: "邮件配置文件无法读取。" };
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
	} catch {
		// 不回显 JSON.parse 的原始错误，避免带出文件内容片段。
		return { status: "invalid", message: "邮件配置文件不是有效的 JSON。" };
	}
	try {
		return { status: "ready", config: parseEmailConfig(raw) };
	} catch (error) {
		if (error instanceof EmailConfigError) return { status: "invalid", message: error.message };
		return { status: "invalid", message: "邮件配置无效。" };
	}
}
