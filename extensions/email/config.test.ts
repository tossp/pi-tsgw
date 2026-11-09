import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEmailConfig } from "./config.ts";

// 全部使用本地合成值：不读取个人配置、不连接邮箱、不外发任何内容。
const IMAP_PASSWORD = "imap-pw-1/\"ü";
const SMTP_PASSWORD = " smtp-pw-2@example ";

function validInput(): Record<string, unknown> {
	return {
		imap: {
			work: {
				host: "imap.example.invalid",
				port: 993,
				tls: "implicit",
				user: "work-user",
				password: IMAP_PASSWORD,
				trashMailbox: "Trash",
				junkMailbox: "Junk",
			},
			personal: {
				host: "imap2.example.invalid",
				port: 143,
				tls: "starttls",
				user: "personal-user",
				password: "imap-pw-2",
				trashMailbox: "Deleted Items",
				junkMailbox: "Spam",
			},
		},
		smtp: {
			work: {
				host: "smtp.example.invalid",
				port: 465,
				tls: "implicit",
				user: "work-user",
				password: SMTP_PASSWORD,
				fromAddress: "work@example.invalid",
			},
			personal: {
				host: "smtp2.example.invalid",
				port: 587,
				tls: "starttls",
				user: "personal-user",
				password: "smtp-pw-2",
				fromAddress: "Me@Example.invalid",
				fromName: "发件人",
				allowSenderOverride: true,
				envelopeFrom: "bounce@example.invalid",
			},
		},
	};
}

type Json = Record<string, unknown>;

function input(): Json {
	return structuredClone(validInput());
}

function imapAccount(value: Json, id: string): Record<string, unknown> {
	return (value.imap as Record<string, Record<string, unknown>>)[id]!;
}

function smtpAccount(value: Json, id: string): Record<string, unknown> {
	return (value.smtp as Record<string, Record<string, unknown>>)[id]!;
}

function leafStrings(value: unknown, found: string[] = []): string[] {
	if (typeof value === "string") found.push(value);
	else if (Array.isArray(value)) for (const item of value) leafStrings(item, found);
	else if (value !== null && typeof value === "object")
		for (const item of Object.values(value)) leafStrings(item, found);
	return found;
}

// 消息中合法出现的固定字面量（枚举值与 IMAP 保留名），不算回显配置值。
const MESSAGE_LITERALS = new Set(["implicit", "starttls", "INBOX"]);

/** 错误消息不得出现任何配置字段值（含凭据）。 */
function assertNoLeak(message: string, ...sources: unknown[]): void {
	for (const text of sources.flatMap(source => leafStrings(source)))
		if (text.length >= 4 && !MESSAGE_LITERALS.has(text))
			assert.ok(!message.includes(text), "错误消息不得包含配置值");
}

function rejectMessage(value: unknown): string {
	try {
		parseEmailConfig(value);
	} catch (error) {
		assert.ok(error instanceof Error, "应以 Error 拒绝");
		return error.message;
	}
	return assert.fail("应拒绝非法配置");
}

function reject(edit: (value: Json) => void, pattern: RegExp): string {
	const value = input();
	edit(value);
	const message = rejectMessage(value);
	assert.match(message, pattern);
	assertNoLeak(message, value);
	return message;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

test("解析任意数量的平铺账户并补齐默认值", () => {
	const raw = input();
	const config = parseEmailConfig(raw);
	assert.deepEqual(config, {
		imap: {
			work: {
				host: "imap.example.invalid", port: 993, tls: "implicit", user: "work-user",
				password: IMAP_PASSWORD, trashMailbox: "Trash", junkMailbox: "Junk",
			},
			personal: {
				host: "imap2.example.invalid", port: 143, tls: "starttls", user: "personal-user",
				password: "imap-pw-2", trashMailbox: "Deleted Items", junkMailbox: "Spam",
			},
		},
		smtp: {
			work: {
				host: "smtp.example.invalid", port: 465, tls: "implicit", user: "work-user",
				password: SMTP_PASSWORD, fromAddress: "work@example.invalid", allowSenderOverride: false,
			},
			personal: {
				host: "smtp2.example.invalid", port: 587, tls: "starttls", user: "personal-user",
				password: "smtp-pw-2", fromAddress: "Me@Example.invalid", fromName: "发件人",
				allowSenderOverride: true, envelopeFrom: "bounce@example.invalid",
			},
		},
	});
	assert.equal("defaultSmtp" in config, false);
	// 未配置的可选项不凭空出现，避免消费者误判“已设置但为空”。
	assert.equal("fromName" in config.smtp.work!, false);
	assert.equal("envelopeFrom" in config.smtp.work!, false);
});

test("账户与出口按任意 ID 扩展，不限两个或固定名称", () => {
	const raw = input();
	const imap = imapAccount(raw, "work");
	const smtp = smtpAccount(raw, "work");
	raw.imap = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`收件-${i}`, { ...imap }]));
	raw.smtp = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`发送-${i}`, { ...smtp }]));
	const config = parseEmailConfig(raw);
	assert.equal(Object.keys(config.imap).length, 7);
	assert.equal(Object.keys(config.smtp).length, 5);
});

test("未知字段的键名也不进入错误，避免误填秘密时泄露", () => {
	const secret = "synthetic-sensitive-key-7b45";
	for (const area of ["root", "imap", "smtp"]) {
		const raw = input();
		const target = area === "root" ? raw : area === "imap" ? imapAccount(raw, "work") : smtpAccount(raw, "work");
		target[secret] = "synthetic-value";
		const message = rejectMessage(raw);
		assert.match(message, /不支持的字段/);
		assert.ok(!message.includes(secret));
		assertNoLeak(message, raw);
	}
});

test("账户 ID 与字段值原样保留，不 trim、不改大小写", () => {
	const raw = input();
	const account = imapAccount(raw, "work");
	account.user = " Work User ";
	account.password = " p@ss:w/rd \"x\" ünïcode ";
	account.trashMailbox = " Trash ";
	account.junkMailbox = "junk ";
	const smtp = smtpAccount(raw, "work");
	smtp.fromAddress = "Work@Example.Invalid";
	const config = parseEmailConfig(raw);
	assert.equal(config.imap.work!.user, " Work User ");
	assert.equal(config.imap.work!.password, " p@ss:w/rd \"x\" ünïcode ");
	assert.equal(config.imap.work!.trashMailbox, " Trash ");
	assert.equal(config.imap.work!.junkMailbox, "junk ");
	assert.equal(config.smtp.work!.fromAddress, "Work@Example.Invalid");
	assert.deepEqual(Object.keys(config.imap), ["work", "personal"]);
	assert.deepEqual(Object.keys(config.smtp), ["work", "personal"]);
});

test("解析不修改调用方传入的对象", () => {
	const raw = deepFreeze(input());
	const before = structuredClone(raw);
	assert.doesNotThrow(() => parseEmailConfig(raw));
	assert.deepEqual(raw, before);
});

test("顶层只接受 JSON 对象且不含未知字段", () => {
	for (const value of [null, [], "{}", 42, true]) {
		const message = rejectMessage(value);
		assert.match(message, /顶层必须是 JSON 对象/);
	}
	assert.match(rejectMessage(new Map()), /顶层必须是 JSON 对象/);
	const message = rejectMessage({ ...input(), activeProfile: "work", secretValue: "leak-token" });
	assert.match(message, /不支持的字段/);
	assert.ok(!message.includes("leak-token"), "未知字段错误不得回显字段值");
	reject(value => { value.enabled = true; }, /不支持的字段/);
});

test("账户对象内不允许嵌套结构或其他未知字段", () => {
	reject(value => { imapAccount(value, "work").auth = { user: "u", password: "nested-secret" }; },
		/不支持的字段/);
	reject(value => { smtpAccount(value, "work").inbox = "INBOX"; }, /不支持的字段/);
	reject(value => { (value.imap as Record<string, unknown>).work = ["host"]; }, /必须是对象/);
	reject(value => { (value.smtp as Record<string, unknown>).work = null; }, /必须是对象/);
	reject(value => { (value.imap as Record<string, unknown>)[""] = imapAccount(value, "work"); },
		/ID 必须是非空/);
});

test("协议组缺省或空映射合法，显式 null 与非映射类型拒绝", () => {
	assert.deepEqual(parseEmailConfig({}), { imap: {}, smtp: {} });
	assert.deepEqual(parseEmailConfig({ imap: {}, smtp: {} }), { imap: {}, smtp: {} });
	const raw = input();
	assert.deepEqual(parseEmailConfig({ imap: raw.imap }).smtp, {});
	assert.deepEqual(parseEmailConfig({ smtp: raw.smtp }).imap, {});
	for (const kind of ["imap", "smtp"] as const)
		for (const invalid of [null, [], true, "mapping", 1])
			reject(value => { value[kind] = invalid; }, /映射对象/);
});

test("校验端口、TLS 与必填字符串字段", () => {
	for (const port of [0, 65536, -1, 993.5, "993", null])
		reject(value => { imapAccount(value, "work").port = port; }, /port 必须是 1 到 65535 之间的整数/);
	for (const tls of ["ssl", "tls", "none", 993, undefined])
		reject(value => { smtpAccount(value, "work").tls = tls; }, /tls 必须是 "implicit" 或 "starttls"/);
	reject(value => { delete imapAccount(value, "work").host; }, /host 必须是非空字符串/);
	reject(value => { smtpAccount(value, "work").user = ""; }, /user 必须是非空字符串/);
	reject(value => { imapAccount(value, "work").password = ""; }, /password 必须是非空字符串/);
	reject(value => { imapAccount(value, "work").password = 12345; }, /password 必须是非空字符串/);
	reject(value => { imapAccount(value, "work").user = "user\ninjected"; }, /不能包含控制字符/);
	// 边界值合法。
	const raw = input();
	imapAccount(raw, "work").port = 1;
	smtpAccount(raw, "work").port = 65535;
	const config = parseEmailConfig(raw);
	assert.equal(config.imap.work!.port, 1);
	assert.equal(config.smtp.work!.port, 65535);
});

test("allowSenderOverride 只接受布尔值且缺省为 false", () => {
	reject(value => { smtpAccount(value, "work").allowSenderOverride = "true"; },
		/allowSenderOverride 必须是布尔值/);
	const raw = input();
	smtpAccount(raw, "work").allowSenderOverride = false;
	assert.equal(parseEmailConfig(raw).smtp.work!.allowSenderOverride, false);
});

test("可用发件域按大小写和 IDN 归一化，不修改原始配置或发件地址", () => {
	const raw = input();
	const smtp = smtpAccount(raw, "work");
	smtp.allowedFromDomains = ["EXAMPLE.INVALID", "屮.test", "XN--OHT.TEST"];
	const before = structuredClone(raw);
	const parsed = parseEmailConfig(deepFreeze(raw));
	assert.deepEqual(parsed.smtp.work!.allowedFromDomains, ["example.invalid", "xn--oht.test", "xn--oht.test"]);
	assert.equal(parsed.smtp.work!.fromAddress, "work@example.invalid");
	assert.equal(parsed.smtp.personal!.allowedFromDomains, undefined);
	assert.deepEqual(raw, before);
	const unicode = input();
	smtpAccount(unicode, "work").fromAddress = "sender@屮.test";
	smtpAccount(unicode, "work").allowedFromDomains = ["xn--oht.test"];
	assert.equal(parseEmailConfig(unicode).smtp.work!.fromAddress, "sender@屮.test");
});

test("可用发件域拒绝非法值且不回显配置内容，默认地址必须匹配", () => {
	for (const domains of [null, true, "example.invalid", [], [null], [1], [""], [" "],
		["*.example.invalid"], ["@example.invalid"], ["https://example.invalid"],
		["example.invalid/path"], ["example.invalid?query"], ["example.invalid#fragment"],
		["example.invalid%2fpath"], ["example.invalid\\path"], ["example.invalid\n"],
		[".example.invalid"], ["example.invalid."], ["example..invalid"],
		["-example.invalid"], ["example-.invalid"], ["exam_ple.invalid"],
		[`${"a".repeat(64)}.invalid`]])
		reject(value => { smtpAccount(value, "work").allowedFromDomains = domains; }, /allowedFromDomains/);
	reject(value => { smtpAccount(value, "work").allowedFromDomains = ["other.invalid"]; }, /默认 fromAddress 域必须属于/);
	reject(value => { smtpAccount(value, "work").allowedFromDomains = ["sub.example.invalid"]; }, /默认 fromAddress 域必须属于/);
});

test("只接受平铺协议组，不接受旧默认出口、email 包装或逐账户 type", () => {
	for (const field of ["defaultSmtp", "email"])
		reject(value => { value[field] = "synthetic-obsolete-config"; }, /不支持的字段/);
	reject(value => { imapAccount(value, "work").type = "synthetic-imap-account-type"; }, /不支持的字段/);
	reject(value => { smtpAccount(value, "work").type = "synthetic-smtp-account-type"; }, /不支持的字段/);
});

test("dav 仅允许占据根分区，不由邮件组合解析器消费", () => {
	const raw = input();
	const expected = parseEmailConfig(raw);
	for (const dav of [null, [], "not-consumed", { work: { password: "synthetic-dav-secret" } }])
		assert.deepEqual(parseEmailConfig({ ...raw, dav }), expected);
});

test("垃圾箱与垃圾邮件文件夹不能是 INBOX，也不能相同", () => {
	for (const name of ["INBOX", "inbox", "InBoX", "iNbOx"])
		reject(value => { imapAccount(value, "work").trashMailbox = name; }, /trashMailbox 不能是 INBOX/);
	reject(value => { imapAccount(value, "work").junkMailbox = "inbox"; }, /junkMailbox 不能是 INBOX/);
	reject(value => {
		imapAccount(value, "work").trashMailbox = "Trash";
		imapAccount(value, "work").junkMailbox = "Trash";
	}, /trashMailbox 与 junkMailbox 不能相同/);
	reject(value => { imapAccount(value, "work").trashMailbox = ""; }, /trashMailbox 必须是非空字符串/);
	const raw = input();
	imapAccount(raw, "work").trashMailbox = "INBOX.Sent";
	imapAccount(raw, "work").junkMailbox = "INBOX/Junk";
	const config = parseEmailConfig(raw);
	assert.equal(config.imap.work!.trashMailbox, "INBOX.Sent");
	assert.equal(config.imap.work!.junkMailbox, "INBOX/Junk");
});

test("邮件地址只做基础格式与头注入校验", () => {
	for (const address of ["no-at-sign", "@example.invalid", "user@", "user name@example.invalid",
		"user@@example.invalid", "user@exa<mple.invalid", "user@example.invalid,evil@example.invalid"])
		reject(value => { smtpAccount(value, "work").fromAddress = address; },
			/fromAddress 必须是基础格式的邮件地址/);
	// 换行注入在字符串校验处就被拦下，不等同于格式错误。
	reject(value => { smtpAccount(value, "work").fromAddress = "user@example.invalid\nBcc: other@example.invalid"; },
		/fromAddress 不能包含控制字符/);
	reject(value => { smtpAccount(value, "work").envelopeFrom = "not-an-address"; },
		/envelopeFrom 必须是基础格式的邮件地址/);
	reject(value => { smtpAccount(value, "work").fromName = ""; }, /fromName 必须是非空字符串/);
	reject(value => { smtpAccount(value, "work").fromName = "名称\r\nBcc: other@example.invalid"; },
		/fromName 不能包含控制字符/);
	const raw = input();
	smtpAccount(raw, "work").envelopeFrom = "Bounce+tag@Example.invalid";
	assert.equal(parseEmailConfig(raw).smtp.work!.envelopeFrom, "Bounce+tag@Example.invalid");
	smtpAccount(raw, "work").fromAddress = "sender@internal";
	smtpAccount(raw, "work").envelopeFrom = "bounce@internal";
	const internal = parseEmailConfig(raw).smtp.work!;
	assert.equal(internal.fromAddress, "sender@internal");
	assert.equal(internal.envelopeFrom, "bounce@internal");
});

test("密码按凭据原样保留，错误消息不出现任何字段值", () => {
	const config = parseEmailConfig(input());
	assert.equal(config.imap.work!.password, IMAP_PASSWORD);
	assert.equal(config.smtp.work!.password, SMTP_PASSWORD);
	// reject 内部断言：错误消息只暴露字段名，不回显凭据或其他字段值。
	reject(value => { imapAccount(value, "work").port = "993"; }, /port/);
});
