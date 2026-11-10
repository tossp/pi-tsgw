export interface DavAccountConfig {
	url: string;
	user: string;
	password: string;
	timeZone?: string;
}

export class DavConfigError extends Error {}

/** 只校验 dav 组，不读文件或连接服务器；错误不得包含账户键值。 */
export function parseDavAccounts(raw: unknown): Record<string, DavAccountConfig> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw new DavConfigError("DAV 配置无效：dav 必须是账户 ID 到配置的映射对象。");
	const entries: [string, DavAccountConfig][] = [];
	for (const [id, value] of Object.entries(raw)) {
		const fail = (): never => { throw new DavConfigError("DAV 配置无效：请核对账户 ID、HTTPS url、user、非空 password 及可选的 IANA timeZone；不要在聊天中提交密码。"); };
		if (!id || /[\u0000-\u001f\u007f]/.test(id) || value === null || typeof value !== "object" || Array.isArray(value)) fail();
		const item = value as Record<string, unknown>;
		if (Object.keys(item).some(key => !["url", "user", "password", "timeZone"].includes(key))) fail();
		const { url, user, password, timeZone } = item;
		if (typeof url !== "string" || typeof user !== "string" || typeof password !== "string" || !password.length) fail();
		if (!user || /[:\u0000-\u001f\u007f]/.test(user as string) || /[\s\u0000-\u001f\u007f]/.test(url as string)) fail();
		try {
			const address = new URL(url as string);
			if (address.protocol !== "https:" || address.username || address.password || address.hash || address.search) fail();
			if (timeZone !== undefined) {
				if (typeof timeZone !== "string" || !timeZone) fail();
				new Intl.DateTimeFormat("en", { timeZone: timeZone as string });
			}
		} catch { fail(); }
		entries.push([id, { url: url as string, user: user as string, password: password as string,
			...(timeZone === undefined ? {} : { timeZone: timeZone as string }) }]);
	}
	return Object.fromEntries(entries);
}
