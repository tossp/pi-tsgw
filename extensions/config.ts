import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	EmailConfigError, parseImapAccounts, parseSmtpConfigs,
	type ImapAccountConfig, type SmtpConfig,
} from "./email/config.ts";

export interface ConfigMap {
	imap: ImapAccountConfig;
	smtp: SmtpConfig;
}

export type ConfigResult<T> =
	| { status: "missing" }
	| { status: "invalid"; message: string }
	| { status: "ready"; config: T };

const factories: { [K in keyof ConfigMap]: (raw: unknown) => Record<string, ConfigMap[K]> } = {
	imap: parseImapAccounts,
	smtp: parseSmtpConfigs,
};

/** 只读统一文件并校验本次所需类型；不探测旧入口、不迁移、不联网。 */
export function readConfig<K extends keyof ConfigMap>(
	kind: K,
	agentDir?: string,
): ConfigResult<Record<string, ConfigMap[K]>> {
	let text: string;
	try {
		const path = join(agentDir ?? getAgentDir(), "tsgw.json");
		const stats = statSync(path);
		if (!stats.isFile()) return { status: "invalid", message: "扩展配置路径不是普通文件。" };
		if ((stats.mode & 0o777) !== 0o600)
			return { status: "invalid", message: "扩展配置文件权限必须是 0600。" };
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing" };
		return { status: "invalid", message: "扩展配置文件无法读取或定位。" };
	}

	let raw: unknown;
	try {
		raw = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text);
	} catch {
		// 原始解析错误可能包含凭据片段，不能回显。
		return { status: "invalid", message: "扩展配置文件不是有效的 JSON。" };
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		return { status: "invalid", message: "扩展配置顶层必须是 JSON 对象。" };
	if (Object.keys(raw).some(key => !["imap", "smtp", "dav"].includes(key)))
		return { status: "invalid", message: "扩展配置顶层包含不支持的字段。" };
	if (!Object.hasOwn(raw, kind)) return { status: "missing" };

	try {
		const config = factories[kind]((raw as Record<string, unknown>)[kind]);
		return Object.keys(config).length ? { status: "ready", config } : { status: "missing" };
	} catch (error) {
		return { status: "invalid", message: error instanceof EmailConfigError
			? error.message : "扩展配置类型无效。" };
	}
}
