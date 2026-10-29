import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImapFlow } from "imapflow";
import { mimeParts, queryPage, serverQuery, summary } from "./query.ts";

test("默认分页 50 封，游标基于 UID 且不把服务端乱序当作顺序", async () => {
	let fetched: unknown;
	const client = {
		mailbox: { uidValidity: 555n },
		async search() { return Array.from({ length: 60 }, (_, i) => i + 1); },
		async *fetch(uids: number[]) { fetched = uids; for (const uid of [...uids].reverse()) yield { uid, seq: uid }; },
	} as unknown as ImapFlow;
	const result = await queryPage(client, { account: "test" }, { all: true });
	assert.equal((result.messages as unknown[]).length, 50);
	assert.equal(result.nextBeforeUid, 11);
	assert.equal(result.uidValidity, "555");
	assert.equal((fetched as number[])[0], 60);
	assert.equal((result.messages as { uid: number }[])[0]?.uid, 60);
});

test("服务器 SEARCH 拒绝或缺失结果不能误报为空集合", async () => {
	let fetched = false;
	for (const result of [false, undefined]) {
		const client = { mailbox: { uidValidity: 1n }, async search() { return result; },
			async *fetch() { fetched = true; } } as unknown as ImapFlow;
		await assert.rejects(queryPage(client, { account: "test" }, {}), { code: "SEARCH_FAILED" });
	}
	const client = { mailbox: { uidValidity: 1n }, async search() { return []; },
		async *fetch() { fetched = true; } } as unknown as ImapFlow;
	const empty = await queryPage(client, { account: "test" }, {});
	assert.deepEqual(empty.messages, []);
	assert.equal(empty.nextBeforeUid, null);
	assert.equal(fetched, false);
});

test("单节点 text/plain 仅根节点缺省 part 时补标准编号", () => {
	assert.deepEqual(mimeParts({ type: "text/plain" }), [{ part: "1", name: undefined, type: "text/plain", size: undefined, attachment: false,
		charset: undefined, disposition: undefined, format: undefined }]);
	assert.equal(mimeParts({ type: "text/plain", part: "7" })[0]?.part, "7");
	assert.deepEqual(mimeParts({ type: "multipart/mixed", childNodes: [{ type: "text/plain" }] }), []);
});

test("搜索映射可明确查询已读；摘要忽略非公开协议对象", () => {
	assert.deepEqual(serverQuery({ account: "test", query: { unread: false } }), { seen: true });
	const result = summary({ seq: 1, uid: 99, modseq: 3n, source: Buffer.from("private"), flags: new Set(["\\Flagged"]),
		envelope: { date: new Date("invalid"), from: [{ name: "甲", address: "a@test" }] } });
	assert.deepEqual(result.flags, ["\\Flagged"]);
	assert.equal(result.date, undefined);
	assert.doesNotThrow(() => JSON.stringify(result));
	assert.equal("source" in result, false);
	assert.equal("modseq" in result, false);
});

test("MIME 附件内嵌文本不能误选为外层正文，拒绝非数字协议 section", () => {
	const parts = mimeParts({ type: "multipart/mixed", childNodes: [
		{ part: "1", type: "text/plain" },
		{ part: "2", type: "message/rfc822", disposition: "attachment", childNodes: [{ part: "2.1", type: "text/plain" }] },
		{ part: "3", type: "text/plain", parameters: { name: "attached.txt" } },
		{ part: "HEADER", type: "text/plain" },
	] });
	assert.deepEqual(parts.filter(p => !p.attachment).map(p => p.part), ["1"]);
	assert.equal(parts.find(p => p.part === "2.1")?.attachment, true);
	assert.equal(parts.find(p => p.part === "3")?.attachment, true);
	assert.equal(parts.some(p => p.part === "HEADER"), false);
});
