import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEmailConfig, readEmailConfig } from "./config.ts";

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
		defaultSmtp: "work",
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

function sandbox(run: (agentDir: string, root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "tsgw-email-config-"));
	try {
		run(join(root, "agent"), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function readMessage(agentDir: string): string {
	const result = readEmailConfig(agentDir);
	assert.equal(result.status, "invalid");
	return result.status === "invalid" ? result.message : "";
}

function writeConfig(agentDir: string, content: string, mode = 0o600): string {
	mkdirSync(agentDir, { recursive: true });
	const path = join(agentDir, "tsgw-email.json");
	writeFileSync(path, content, { encoding: "utf8", mode });
	chmodSync(path, mode);
	return path;
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
		defaultSmtp: "work",
	});
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
	raw.defaultSmtp = "发送-4";
	const config = parseEmailConfig(raw);
	assert.equal(Object.keys(config.imap).length, 7);
	assert.equal(Object.keys(config.smtp).length, 5);
	assert.equal(config.defaultSmtp, "发送-4");
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

test("imap 与 smtp 各自至少需要一个账户", () => {
	reject(value => { value.imap = {}; }, /imap 至少需要一个账户/);
	reject(value => { value.smtp = {}; }, /smtp 至少需要一个账户/);
	reject(value => { delete value.imap; }, /imap 必须是账户 ID 到账户配置的映射对象/);
	reject(value => { delete value.smtp; }, /smtp 必须是账户 ID 到账户配置的映射对象/);
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

test("defaultSmtp 必须是 smtp 的自有键，不能依赖原型", () => {
	reject(value => { delete value.defaultSmtp; }, /defaultSmtp/);
	reject(value => { value.defaultSmtp = ""; }, /defaultSmtp/);
	reject(value => { value.defaultSmtp = 7; }, /defaultSmtp/);
	reject(value => { value.defaultSmtp = "missing"; }, /defaultSmtp 必须是 smtp 中已定义的账户 ID/);
	reject(value => { value.defaultSmtp = "toString"; }, /defaultSmtp 必须是 smtp 中已定义的账户 ID/);
	reject(value => { value.defaultSmtp = "constructor"; }, /defaultSmtp 必须是 smtp 中已定义的账户 ID/);
	reject(value => { value.defaultSmtp = "hasOwnProperty"; }, /defaultSmtp 必须是 smtp 中已定义的账户 ID/);
	const raw = input();
	raw.defaultSmtp = "personal";
	assert.equal(parseEmailConfig(raw).defaultSmtp, "personal");
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

test("无配置文件时关闭，且不创建任何文件或目录", () => sandbox((agentDir, root) => {
	assert.deepEqual(readEmailConfig(agentDir), { status: "disabled" });
	assert.deepEqual(readdirSync(root), [], "不创建 agent 目录或配置文件");
	mkdirSync(agentDir);
	assert.deepEqual(readEmailConfig(agentDir), { status: "disabled" });
	assert.deepEqual(readdirSync(agentDir), [], "不创建配置文件");
}));

test("读取 0600 的有效配置", () => sandbox(agentDir => {
	const path = writeConfig(agentDir, `${JSON.stringify(validInput(), null, 2)}\n`);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const result = readEmailConfig(agentDir);
	assert.equal(result.status, "ready");
	assert.ok(result.status === "ready");
	assert.equal(result.config.defaultSmtp, "work");
	assert.equal(result.config.imap.work!.password, IMAP_PASSWORD);
	assert.deepEqual(readdirSync(agentDir), ["tsgw-email.json"]);
	// 带 BOM 的 UTF-8 文件也按 JSON 读取。
	writeConfig(agentDir, `\uFEFF${JSON.stringify(validInput())}`);
	assert.equal(readEmailConfig(agentDir).status, "ready");
}));

test("文件权限必须是 0600", () => sandbox(agentDir => {
	writeConfig(agentDir, JSON.stringify(validInput()), 0o644);
	const result = readEmailConfig(agentDir);
	assert.equal(result.status, "invalid");
	assert.ok(result.status === "invalid");
	assert.match(result.message, /0600/);
	writeConfig(agentDir, JSON.stringify(validInput()), 0o660);
	assert.match(readMessage(agentDir), /0600/);
}));

test("非普通文件与空文件返回安全错误", () => sandbox(agentDir => {
	mkdirSync(join(agentDir, "tsgw-email.json"), { recursive: true });
	assert.match(readMessage(agentDir), /不是普通文件/);
}));

test("空文件不是有效 JSON", () => sandbox(agentDir => {
	writeConfig(agentDir, "");
	assert.match(readMessage(agentDir), /不是有效的 JSON/);
}));

test("无效 JSON 与非法配置都不泄露原文", () => sandbox(agentDir => {
	const broken = `{"imap":{"work":{"password":"${IMAP_PASSWORD}"`;
	writeConfig(agentDir, broken);
	const message = readMessage(agentDir);
	assert.match(message, /不是有效的 JSON/);
	assert.ok(!message.includes(IMAP_PASSWORD), "不泄露 JSON 片段");
	assert.ok(!message.includes("Unexpected"), "不回显 JSON.parse 原始错误");
	writeConfig(agentDir, JSON.stringify({ ...input(), extra: "leak-token" }));
	const unknown = readMessage(agentDir);
	assert.match(unknown, /不支持的字段/);
	assert.ok(!unknown.includes("leak-token"), "不回显未知字段值");
	writeConfig(agentDir, JSON.stringify({ ...input(), defaultSmtp: "missing" }));
	const invalid = readMessage(agentDir);
	assert.match(invalid, /defaultSmtp/);
	assert.ok(!invalid.includes(SMTP_PASSWORD));
	assert.ok(!invalid.includes(IMAP_PASSWORD));
}));
