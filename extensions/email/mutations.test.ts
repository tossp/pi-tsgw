import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ImapFlow } from "imapflow";
import { EmailCache } from "./cache.ts";
import type { EmailConfig } from "./config.ts";
import type { ImapSessions } from "./imap-session.ts";
import { mutateEmail } from "./mutations.ts";
import type { MessageBatch } from "./types.ts";

// 全部为本地合成值：不读取个人配置、不连接真实邮箱、不外发内容。

type Mode = "false" | "no" | "network";
interface Options {
	caps?: string[];
	enabled?: string[];
	uidValidity?: bigint;
	boxes?: { path: string; flags?: string[] }[];
	present?: number[];
	flags?: Record<number, string[]>;
	noUidMap?: boolean;
	ignoreFlags?: boolean;
	moveNoop?: boolean;
	deleteNoop?: boolean;
	fail?: Partial<Record<"flagsAdd" | "flagsRemove" | "move" | "delete", Mode>>;
	failFetchAt?: number;
	fetchFailMode?: "no" | "network";
	onFlagsAdd?: (client: { usable: boolean }) => void;
	onMove?: (client: { usable: boolean }) => void;
}
interface Call { method: string; range?: unknown; options?: any; flags?: string[]; destination?: string }

function harness(options: Options = {}) {
	const calls: Call[] = [];
	const boxes = options.boxes ?? [{ path: "Trash" }, { path: "Junk" }];
	const present = new Set(options.present ?? [1, 2, 3]);
	const flags = new Map<number, Set<string>>();
	for (const uid of present) flags.set(uid, new Set(options.flags?.[uid] ?? []));
	const state = { usable: true };
	let fetchCount = 0;
	let nextUid = 5000;
	const uids = (range: unknown): number[] => Array.isArray(range)
		? range.map(Number)
		: typeof range === "number" ? [range]
			: typeof range === "string" ? range.split(",").filter(Boolean).map(Number) : [];
	const serverError = (): Error => Object.assign(new Error("Command failed"), { responseStatus: "NO" });
	const networkError = (): Error => Object.assign(new Error("connection lost"), { code: "NoConnection" });
	const client: any = {
		states: { LOGOUT: 4 }, state: 3,
		get usable() { return state.usable; },
		set usable(value: boolean) { state.usable = value; },
		capabilities: new Map((options.caps ?? ["MOVE", "UIDPLUS"]).map(name => [name, true])),
		enabled: new Set(options.enabled ?? []),
		mailbox: {
			path: "INBOX", delimiter: "/", flags: new Set<string>(),
			uidValidity: options.uidValidity ?? 7n, uidNext: 500, exists: present.size,
		},
		async list() {
			calls.push({ method: "list" });
			return boxes.map(box => ({
				path: box.path, pathAsListed: box.path, name: box.path, delimiter: "/",
				parent: [], parentPath: "", flags: new Set(box.flags ?? []), listed: true, subscribed: true,
			}));
		},
		async fetchAll(range: unknown, query: any, opts: any) {
			calls.push({ method: "fetchAll", range, options: { query, opts } });
			fetchCount += 1;
			if (options.failFetchAt === fetchCount)
				throw options.fetchFailMode === "no" ? serverError() : networkError();
			return uids(range).filter(uid => present.has(uid))
				.map(uid => ({ uid, flags: new Set(flags.get(uid) ?? []) }));
		},
		async messageFlagsAdd(range: unknown, list: string[], opts: any) {
			calls.push({ method: "messageFlagsAdd", range, options: opts, flags: list });
			options.onFlagsAdd?.(state);
			const mode = options.fail?.flagsAdd;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			if (mode === "false") return false;
			if (!options.ignoreFlags)
				for (const uid of uids(range)) if (present.has(uid)) for (const flag of list) flags.get(uid)?.add(flag);
			return true;
		},
		async messageFlagsRemove(range: unknown, list: string[], opts: any) {
			calls.push({ method: "messageFlagsRemove", range, options: opts, flags: list });
			const mode = options.fail?.flagsRemove;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			if (mode === "false") return false;
			for (const uid of uids(range)) if (present.has(uid)) for (const flag of list) flags.get(uid)?.delete(flag);
			return true;
		},
		async messageMove(range: unknown, destination: string, opts: any) {
			calls.push({ method: "messageMove", range, options: opts, destination });
			options.onMove?.(state);
			const mode = options.fail?.move;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			if (mode === "false") return false;
			const map = new Map<number, number>();
			if (!options.moveNoop)
				for (const uid of uids(range)) if (present.delete(uid)) { flags.delete(uid); map.set(uid, nextUid++); }
			return options.noUidMap ? { destination } : { path: "INBOX", destination, uidValidity: 9n, uidMap: map };
		},
		async messageDelete(range: unknown, opts: any) {
			calls.push({ method: "messageDelete", range, options: opts });
			const mode = options.fail?.delete;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			if (mode === "false") return false;
			if (!options.deleteNoop)
				for (const uid of uids(range)) { present.delete(uid); flags.delete(uid); }
			return true;
		},
		async search(): Promise<never> { throw new Error("不得 SEARCH"); },
		async messageCopy(): Promise<never> { throw new Error("不得 COPY"); },
		async messageFlagsSet(): Promise<never> { throw new Error("不得整组替换"); },
	};
	const runs: { account: string; mailbox: string | undefined }[] = [];
	const sessions = {
		async run<T>(
			account: string, mailbox: string | undefined, signal: AbortSignal | undefined,
			action: (active: ImapFlow) => Promise<T>,
		): Promise<T> {
			runs.push({ account, mailbox });
			signal?.throwIfAborted();
			return await action(client as ImapFlow);
		},
	};
	return { client: client as ImapFlow, sessions: sessions as unknown as ImapSessions, calls, runs, present, flags };
}

function emailConfig(): EmailConfig {
	return {
		imap: {
			work: {
				host: "imap.example.invalid", port: 993, tls: "implicit", user: "work-user",
				password: "imap-pw", trashMailbox: "Trash", junkMailbox: "Junk",
			},
		},
		smtp: {
			work: {
				host: "smtp.example.invalid", port: 465, tls: "implicit", user: "work-user",
				password: "smtp-pw", fromAddress: "work@example.invalid", allowSenderOverride: false,
			},
		},
		defaultSmtp: "work",
	};
}

function cacheFor(t: TestContext): EmailCache {
	const cache = new EmailCache();
	cache.set("state", "旧状态", "state");
	assert.equal(cache.size, 1);
	t.after(() => cache.dispose());
	return cache;
}

function batch(uids: number[], mailbox = "INBOX"): MessageBatch {
	return { account: "work", mailbox, uidValidity: "7", uids };
}

function callsOf(calls: Call[], method: string): Call[] {
	return calls.filter(call => call.method === method);
}

function hundred(): number[] {
	return Array.from({ length: 100 }, (_, index) => 1001 + index);
}

test("100 封 trash+markRead 只发一次会话、一次 STORE、一次 MOVE 和两次 FETCH", async t => {
	const uids = hundred();
	const h = harness({ present: uids });
	const cache = cacheFor(t);
	const result = await mutateEmail("trash", { ...batch(uids), markRead: true }, emailConfig(), h.sessions, cache);

	assert.equal(result.status, "success");
	assert.equal(result.items.length, 100);
	assert.ok(result.items.every(item => item.status === "success"
		&& item.steps.length === 2
		&& item.steps[0]!.action === "read" && item.steps[0]!.status === "success"
		&& item.steps[1]!.action === "move" && item.steps[1]!.status === "success"
		&& item.destination?.mailbox === "Trash" && typeof item.destination.uid === "number"));
	assert.equal(h.runs.length, 1);
	assert.equal(callsOf(h.calls, "list").length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 1);
	assert.equal(callsOf(h.calls, "messageFlagsRemove").length, 0);
	assert.equal(callsOf(h.calls, "messageMove").length, 1);
	assert.equal(callsOf(h.calls, "messageDelete").length, 0);
	// 只约束本 fixture 的固定上限，不锁定未来实现的全部往返。
	assert.ok(h.calls.length <= 6);

	const store = callsOf(h.calls, "messageFlagsAdd")[0]!;
	assert.deepEqual(store.range, uids);
	assert.deepEqual(store.flags, ["\\Seen"]);
	assert.deepEqual(store.options, { uid: true });
	const move = callsOf(h.calls, "messageMove")[0]!;
	assert.deepEqual(move.range, uids);
	assert.equal(move.destination, "Trash");
	assert.deepEqual(move.options, { uid: true });
	for (const fetch of callsOf(h.calls, "fetchAll")) {
		assert.deepEqual(fetch.range, uids);
		assert.equal(fetch.options.query.uid, true);
		assert.equal(fetch.options.query.flags, true);
		assert.deepEqual(fetch.options.opts, { uid: true });
	}
	assert.equal(cache.size, 0);
});

test("100 封 mark read+flagged 用两次批量 STORE 和一次 FETCH flags 核对", async t => {
	const uids = hundred();
	const h = harness({ present: uids });
	const cache = cacheFor(t);
	const result = await mutateEmail("mark", { ...batch(uids), read: true, flagged: true }, emailConfig(), h.sessions, cache);

	assert.equal(result.status, "success");
	assert.ok(result.items.every(item => item.status === "success"
		&& item.steps.length === 2 && item.steps.every(step => step.status === "success")));
	assert.equal(h.runs.length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 2);
	assert.equal(callsOf(h.calls, "messageFlagsRemove").length, 0);
	assert.equal(callsOf(h.calls, "messageMove").length, 0);
	assert.ok(h.calls.length <= 5);
	for (const call of callsOf(h.calls, "messageFlagsAdd")) {
		assert.deepEqual(call.range, uids);
		assert.deepEqual(call.options, { uid: true });
	}
	assert.deepEqual(callsOf(h.calls, "messageFlagsAdd").map(call => call.flags![0]), ["\\Seen", "\\Flagged"]);
	assert.equal(cache.size, 0);
});

test("100 封 purge 用一次批量 UID EXPUNGE 和一次 FETCH 核对", async t => {
	const uids = hundred();
	const h = harness({ present: uids });
	const cache = cacheFor(t);
	const result = await mutateEmail("purge", batch(uids, "Trash"), emailConfig(), h.sessions, cache);

	assert.equal(result.status, "success");
	assert.ok(result.items.every(item => item.status === "success"
		&& item.steps[0]!.action === "purge" && item.steps[0]!.status === "success"));
	assert.equal(h.runs.length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.equal(callsOf(h.calls, "messageDelete").length, 1);
	assert.deepEqual(callsOf(h.calls, "messageDelete")[0]!.range, uids);
	assert.deepEqual(callsOf(h.calls, "messageDelete")[0]!.options, { uid: true });
	assert.ok(h.calls.length <= 4);
	assert.equal(cache.size, 0);
});

test("批量 FETCH 发现缺失 UID 时只对仍存在的 UID 写入", async t => {
	const h = harness({ present: [1, 2] });
	const cache = cacheFor(t);
	const result = await mutateEmail("mark", { ...batch([1, 2, 3, 4]), read: true }, emailConfig(), h.sessions, cache);

	assert.equal(result.status, "partial");
	assert.deepEqual(
		result.items.map(item => [item.uid, item.status]),
		[[1, "success"], [2, "success"], [3, "failed"], [4, "failed"]],
	);
	assert.deepEqual(result.items[2]!.steps, []);
	assert.deepEqual(result.items[3]!.steps, []);
	assert.match(result.items[2]!.message ?? "", /不存在/);
	assert.deepEqual(callsOf(h.calls, "fetchAll")[0]!.range, [1, 2, 3, 4]);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 1);
	assert.deepEqual(callsOf(h.calls, "messageFlagsAdd")[0]!.range, [1, 2]);
	assert.equal(cache.size, 0);
});

test("已读成功但 MOVE 被拒时保留已读成功并报告 partial", async t => {
	const h = harness({ present: [1, 2], fail: { move: "false" } });
	const cache = cacheFor(t);
	const result = await mutateEmail("trash", { ...batch([1, 2]), markRead: true }, emailConfig(), h.sessions, cache);

	assert.equal(result.status, "partial");
	for (const item of result.items) {
		assert.equal(item.status, "failed");
		assert.deepEqual(
			item.steps.map(step => [step.action, step.status]),
			[["read", "success"], ["move", "failed"]],
		);
		assert.match(item.message ?? "", /部分/);
	}
	assert.equal(callsOf(h.calls, "messageMove").length, 1);
	assert.equal(cache.size, 0);
});

test("STORE 返回 OK 但 FETCH flags 未生效时逐项判失败", async t => {
	const h = harness({ present: [1, 2], ignoreFlags: true });
	const cache = cacheFor(t);
	const result = await mutateEmail("mark", { ...batch([1, 2]), read: true }, emailConfig(), h.sessions, cache);

	assert.equal(result.status, "failed");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "read", status: "failed" }]);
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 1);
});

test("MOVE 无 uidMap 时用一次源 FETCH 证明成功，不伪造目标 UID", async t => {
	const h = harness({ present: [1, 2], boxes: [{ path: "Archive" }], noUidMap: true });
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"move", { ...batch([1, 2]), targetMailbox: "Archive" }, emailConfig(), h.sessions, cache,
	);

	assert.equal(result.status, "success");
	for (const item of result.items) {
		assert.deepEqual(item.steps, [{ action: "move", status: "success" }]);
		assert.equal(item.destination?.mailbox, "Archive");
		assert.equal(item.destination?.uid, undefined);
	}
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.deepEqual(callsOf(h.calls, "fetchAll")[1]!.range, [1, 2]);
	assert.equal(callsOf(h.calls, "messageMove").length, 1);
});

test("MOVE 无 uidMap 且源 UID 仍在时判失败", async t => {
	const h = harness({ present: [1, 2], boxes: [{ path: "Archive" }], noUidMap: true, moveNoop: true });
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"move", { ...batch([1, 2]), targetMailbox: "Archive" }, emailConfig(), h.sessions, cache,
	);

	assert.equal(result.status, "failed");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "move", status: "failed" }]);
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
});

test("MOVE 无 uidMap 且源核对失败时保留 unknown，不假造目标 ID", async t => {
	const h = harness({
		present: [1, 2], boxes: [{ path: "Archive" }], noUidMap: true,
		failFetchAt: 2, fetchFailMode: "network",
	});
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"move", { ...batch([1, 2]), targetMailbox: "Archive" }, emailConfig(), h.sessions, cache,
	);

	assert.equal(result.status, "unknown");
	for (const item of result.items) {
		assert.equal(item.status, "unknown");
		assert.equal(item.destination, undefined);
	}
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.equal(callsOf(h.calls, "messageMove").length, 1);
});

test("junk 与 not_junk 批量移动到配置目录和 INBOX", async t => {
	const junk = harness({ present: [1, 2] });
	const inbox = harness({ present: [3, 4] });
	const cache = cacheFor(t);

	const junkResult = await mutateEmail("junk", batch([1, 2]), emailConfig(), junk.sessions, cache);
	const inboxResult = await mutateEmail("not_junk", batch([3, 4]), emailConfig(), inbox.sessions, cache);

	assert.equal(junkResult.status, "success");
	assert.equal(inboxResult.status, "success");
	assert.deepEqual(callsOf(junk.calls, "messageMove")[0]!.range, [1, 2]);
	assert.equal(callsOf(junk.calls, "messageMove")[0]!.destination, "Junk");
	assert.deepEqual(callsOf(inbox.calls, "messageMove")[0]!.range, [3, 4]);
	assert.equal(callsOf(inbox.calls, "messageMove")[0]!.destination, "INBOX");
	assert.equal(callsOf(junk.calls, "list").length, 1);
	assert.equal(callsOf(inbox.calls, "list").length, 0);
});
