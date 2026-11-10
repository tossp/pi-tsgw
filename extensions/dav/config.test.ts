import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readConfig } from "#tsgw/config";
import { DavConfigError, parseDavAccounts } from "./config.ts";

const account = { url: "https://dav.example.invalid/", user: "synthetic-login", password: " literal !${secret} \"ü " };

test("DAV 仅校验本组，允许跨类型同名并原样保留密码，不要求默认时区", () => {
	const dir = mkdtempSync(join(tmpdir(), "dav-config-"));
	try {
		const path = join(dir, "tsgw.json");
		writeFileSync(path, JSON.stringify({ imap: null, dav: { work: account } }), { mode: 0o600 });
		assert.deepEqual(readConfig("dav", dir), { status: "ready", config: { work: account } });
		assert.equal(readConfig("imap", dir).status, "invalid");
		writeFileSync(path, JSON.stringify({ dav: {} }));
		assert.deepEqual(readConfig("dav", dir), { status: "missing" });
		chmodSync(path, 0o644);
		assert.equal(readConfig("dav", dir).status, "invalid");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("DAV 拒绝无效字段与不安全入口，安全消息不回显键值", () => {
	const cases: unknown[] = [null, [], true,
		{ "synthetic-id": { ...account, password: "" } },
		{ "synthetic-id": { ...account, password: { command: ["secret-command"] } } },
		{ "synthetic-id": { ...account, url: "http://dav.example.invalid/" } },
		{ "synthetic-id": { ...account, url: "https://u:p@dav.example.invalid/" } },
		{ "synthetic-id": { ...account, url: `${account.url}#fragment` } },
		{ "synthetic-id": { ...account, url: `${account.url}?password=hidden` } },
		{ "synthetic-id": { ...account, user: "colon:login" } },
		{ "synthetic-id": { ...account, timeZone: "Invalid/Sensitive-Zone" } },
		{ "synthetic-id": { ...account, enabled: true } },
		{ "synthetic-id": [] }, { "": account },
	];
	for (const raw of cases) assert.throws(() => parseDavAccounts(raw), error => {
		assert.ok(error instanceof DavConfigError);
		assert.doesNotMatch(error.message, /synthetic|secret-command|hidden|Sensitive-Zone|example\.invalid|literal/);
		return true;
	});
	assert.deepEqual(parseDavAccounts({ work: { ...account, timeZone: "Asia/Shanghai" } }), { work: { ...account, timeZone: "Asia/Shanghai" } });
});
