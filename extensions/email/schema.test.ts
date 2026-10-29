import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { schemas } from "./schema.ts";

type Name = keyof typeof schemas;
function validate(name: Name, args: Parameters<typeof validateToolArguments>[1]["arguments"]) {
	return validateToolArguments({ name: `tsgw_email_${name}`, description: "邮件隔离 schema 验证", parameters: schemas[name] },
		{ id: "fixture", type: "toolCall", name: `tsgw_email_${name}`, arguments: args });
}
const ref = { account: "custom-inbound", mailbox: "INBOX", uidValidity: "123456", uid: 42 };
const batch = { account: ref.account, mailbox: ref.mailbox, uidValidity: ref.uidValidity, uids: [42, 55] };

test("真实宿主验证器接受平铺定位、明确批量清单与分页", () => {
	assert.deepEqual(validate("accounts", {}), {});
	assert.deepEqual(validate("read", ref), ref);
	assert.deepEqual(validate("headers", { ...ref, refresh: true }), { ...ref, refresh: true });
	assert.deepEqual(validate("list", { account: ref.account, limit: 100, beforeUid: 55 }), { account: ref.account, limit: 100, beforeUid: 55 });
	assert.deepEqual(validate("trash", { ...batch, markRead: true }), { ...batch, markRead: true });
	assert.deepEqual(validate("mark", { ...batch, read: false, flagged: true }), { ...batch, read: false, flagged: true });
});

test("批量整理拒绝空清单、重复 UID、序号或通配符及任意删除标记", () => {
	for (const uids of [[], [42, 42], ["*"], [0], [-1], [4294967296]])
		assert.throws(() => validate("purge", { ...batch, uids }));
	assert.throws(() => validate("mark", batch));
	assert.throws(() => validate("mark", { ...batch, deleted: true }));
	assert.throws(() => validate("mark", { ...batch, read: true, flags: ["\\Deleted"] }));
	assert.throws(() => validate("trash", { ...batch, query: { all: true } }));
});

test("搜索支持标准条件及 catch-all 头部，不允许空查询或原始协议注入", () => {
	const input = { account: ref.account, query: { from: "sender@example.invalid", since: "2026-01-02", before: "2026-02-03", unread: true, headers: { "Delivered-To": "alias@example.invalid" } } };
	assert.deepEqual(validate("search", input), input);
	assert.throws(() => validate("search", { account: ref.account, query: {} }));
	assert.throws(() => validate("search", { account: ref.account, query: { raw: "ALL" } }));
	assert.throws(() => validate("search", { account: ref.account, query: { before: "not-a-date" } }));
	assert.throws(() => validate("search", { account: ref.account, query: { headers: { "Header\r\nOther": "injected" } } }));
});

test("读取和下载拒绝越界分页、任意部分名与混入的未定义参数", () => {
	for (const limit of [0, 101]) assert.throws(() => validate("list", { account: ref.account, limit }));
	for (const uidValidity of ["0", "previous", "1\r\nUID STORE"]) assert.throws(() => validate("read", { ...ref, uidValidity }));
	for (const maxChars of [0, 262145]) assert.throws(() => validate("read", { ...ref, maxChars }));
	assert.throws(() => validate("read", { ...ref, offset: -1 }));
	assert.deepEqual(validate("attachment", { ...ref, part: "2.1", path: "attachment.bin" }), { ...ref, part: "2.1", path: "attachment.bin" });
	for (const part of ["HEADER", "1.MIME", "../file", "1\r\nNOOP"])
		assert.throws(() => validate("attachment", { ...ref, part, path: "attachment.bin" }));
	assert.throws(() => validate("headers", { ...ref, markRead: true }));
});

test("发送只接受已定义字段和明确收件人，拒绝头注入及库选项透传", () => {
	const input = { to: ["recipient@internal"], subject: "fixture", text: "body\r\nnext line" };
	assert.deepEqual(validate("send", input), input);
	assert.throws(() => validate("send", { ...input, to: [] }));
	assert.throws(() => validate("send", { to: input.to, subject: "fixture" }));
	assert.throws(() => validate("send", { ...input, subject: "subject\r\nBcc: hidden@example.invalid" }));
	assert.throws(() => validate("send", { ...input, fromAddress: "a@example.invalid\nBcc: b@example.invalid" }));
	assert.throws(() => validate("send", { ...input, envelope: { from: "other@example.invalid" } }));
	assert.throws(() => validate("send", { ...input, raw: "unapproved raw source" }));
	assert.throws(() => validate("send", { ...input, attachments: [{ path: "file", href: "https://example.invalid/file" }] }));
});
