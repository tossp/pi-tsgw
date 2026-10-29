import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ImapFlow } from "imapflow";
import { EmailCache } from "./cache.ts";
import type { EmailConfig } from "./config.ts";
import type { ImapSessions } from "./imap-session.ts";
import { mutateEmail } from "./mutations.ts";
import { EmailError, type MessageBatch } from "./types.ts";

// 安全边界：能力、来源、目标、UIDVALIDITY、空清单、断开/取消与 NO/BAD 分类。
// 全部为本地合成值，不连接真实邮箱。

type Mode = "false" | "no" | "network";
interface Options {
	caps?: string[];
	enabled?: string[];
	uidValidity?: bigint;
	boxes?: { path: string; flags?: string[] }[];
	present?: number[];
	fail?: Partial<Record<"flagsAdd" | "flagsRemove" | "move" | "delete", Mode>>;
	deleteNoop?: boolean;
	onFlagsAdd?: (client: { usable: boolean; phase: number }) => void;
	onMove?: (client: { usable: boolean; phase: number }) => void;
	onDelete?: (client: { usable: boolean; phase: number }) => void;
	onFetch?: (client: { usable: boolean; phase: number }) => void;
}
interface Call { method: string; range?: unknown; options?: any; destination?: string }

function harness(options: Options = {}) {
	const calls: Call[] = [];
	const boxes = options.boxes ?? [{ path: "Trash" }, { path: "Junk" }];
	const present = new Set(options.present ?? [1, 2, 3]);
	const state = { usable: true, phase: 3 };
	const uids = (range: unknown): number[] => Array.isArray(range) ? range.map(Number) : [];
	const serverError = (): Error => Object.assign(new Error("Command failed"), { responseStatus: "NO" });
	const networkError = (): Error => Object.assign(new Error("connection lost"), { code: "NoConnection" });
	const client: any = {
		states: { LOGOUT: 4 },
		get state() { return state.phase; },
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
			options.onFetch?.(state);
			return uids(range).filter(uid => present.has(uid)).map(uid => ({ uid }));
		},
		async messageFlagsAdd(range: unknown, list: string[], opts: any) {
			calls.push({ method: "messageFlagsAdd", range, options: opts });
			options.onFlagsAdd?.(state);
			const mode = options.fail?.flagsAdd;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			return mode !== "false";
		},
		async messageFlagsRemove(range: unknown, list: string[], opts: any) {
			calls.push({ method: "messageFlagsRemove", range, options: opts });
			const mode = options.fail?.flagsRemove;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			return mode !== "false";
		},
		async messageMove(range: unknown, destination: string, opts: any) {
			calls.push({ method: "messageMove", range, options: opts, destination });
			options.onMove?.(state);
			const mode = options.fail?.move;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			if (mode === "false") return false;
			const map = new Map<number, number>();
			let next = 5000;
			for (const uid of uids(range)) if (present.delete(uid)) map.set(uid, next++);
			return { path: "INBOX", destination, uidValidity: 9n, uidMap: map };
		},
		async messageDelete(range: unknown, opts: any) {
			calls.push({ method: "messageDelete", range, options: opts });
			options.onDelete?.(state);
			const mode = options.fail?.delete;
			if (mode === "no") throw serverError();
			if (mode === "network") throw networkError();
			if (mode === "false") return false;
			if (!options.deleteNoop) for (const uid of uids(range)) present.delete(uid);
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
	return { client: client as ImapFlow, sessions: sessions as unknown as ImapSessions, calls, runs, present };
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

test("缺少原生 MOVE 能力时整批拒绝，不降级 COPY 或 EXPUNGE", async t => {
	const h = harness({ caps: ["UIDPLUS"] });
	const cache = cacheFor(t);
	await assert.rejects(
		mutateEmail("move", { ...batch([1]), targetMailbox: "Archive" }, emailConfig(), h.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "MOVE_UNSUPPORTED",
	);
	assert.deepEqual(h.calls, []);
	assert.equal(cache.size, 1);
});

test("IMAP4rev2 只在实际启用或仅支持 rev2 时折入 MOVE/UIDPLUS", async t => {
	const cache = cacheFor(t);
	const enabled = harness({ caps: ["IMAP4rev2"], enabled: ["IMAP4REV2"], boxes: [{ path: "Archive" }] });
	const moved = await mutateEmail(
		"move", { ...batch([1]), targetMailbox: "Archive" }, emailConfig(), enabled.sessions, cache,
	);
	assert.equal(moved.status, "success");
	assert.equal(callsOf(enabled.calls, "messageMove").length, 1);

	const rev2Only = harness({ caps: ["IMAP4rev2"] });
	const purged = await mutateEmail("purge", batch([2], "Trash"), emailConfig(), rev2Only.sessions, cache);
	assert.equal(purged.status, "success");
	assert.deepEqual(callsOf(rev2Only.calls, "messageDelete")[0]!.range, [2]);

	const dual = harness({ caps: ["IMAP4rev2", "IMAP4rev1", "UIDPLUS"], boxes: [{ path: "Archive" }] });
	await assert.rejects(
		mutateEmail("move", { ...batch([3]), targetMailbox: "Archive" }, emailConfig(), dual.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "MOVE_UNSUPPORTED",
	);
	assert.deepEqual(callsOf(dual.calls, "messageCopy"), []);
});

test("purge 严格限制在配置的回收站文件夹，不做大小写归一", async t => {
	const cache = cacheFor(t);
	for (const mailbox of ["INBOX", "trash", "Trash/Old"]) {
		const h = harness();
		await assert.rejects(
			mutateEmail("purge", batch([1], mailbox), emailConfig(), h.sessions, cache),
			(error: unknown) => error instanceof EmailError && error.code === "PURGE_SOURCE_INVALID",
		);
		assert.equal(h.runs.length, 0);
		assert.deepEqual(h.calls, []);
		assert.equal(cache.size, 1);
	}
});

test("缺少 UIDPLUS 时拒绝 purge，绝不执行普通 EXPUNGE", async t => {
	const h = harness({ caps: ["MOVE"] });
	const cache = cacheFor(t);
	await assert.rejects(
		mutateEmail("purge", batch([1], "Trash"), emailConfig(), h.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "UID_EXPUNGE_UNSUPPORTED",
	);
	assert.deepEqual(h.calls, []);
	assert.equal(cache.size, 1);
});

test("目标不存在、不可选择或大小写不一致时在写入前拒绝", async t => {
	const cache = cacheFor(t);
	const missing = harness({ boxes: [{ path: "Trash" }] });
	await assert.rejects(
		mutateEmail("move", { ...batch([1]), targetMailbox: "Archive" }, emailConfig(), missing.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "DESTINATION_MISSING",
	);
	assert.equal(callsOf(missing.calls, "list").length, 1);
	assert.deepEqual(callsOf(missing.calls, "fetchAll"), []);
	assert.deepEqual(callsOf(missing.calls, "messageMove"), []);

	const noselect = harness({ boxes: [{ path: "Archive", flags: ["\\Noselect", "\\NonExistent"] }] });
	await assert.rejects(
		mutateEmail("move", { ...batch([2]), targetMailbox: "Archive" }, emailConfig(), noselect.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "DESTINATION_MISSING",
	);

	const casing = harness({ boxes: [{ path: "Archive" }] });
	await assert.rejects(
		mutateEmail("move", { ...batch([3]), targetMailbox: "archive" }, emailConfig(), casing.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "DESTINATION_MISSING",
	);
	assert.equal(cache.size, 1);
});

test("UIDVALIDITY 不匹配时先拒绝，不做任何读取或写入", async t => {
	const h = harness({ uidValidity: 8n });
	const cache = cacheFor(t);
	await assert.rejects(
		mutateEmail("mark", { ...batch([1]), read: true }, emailConfig(), h.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "STALE_MAILBOX",
	);
	assert.deepEqual(h.calls, []);
	assert.equal(cache.size, 1);
});

test("调用前已取消时逐项报告未执行，且不建立会话", async t => {
	const controller = new AbortController();
	controller.abort();
	const h = harness();
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"mark", { ...batch([1, 2]), read: true }, emailConfig(), h.sessions, cache, controller.signal,
	);
	assert.equal(result.status, "failed");
	assert.deepEqual(result.items.map(item => [item.uid, item.status]), [[1, "failed"], [2, "failed"]]);
	for (const item of result.items) {
		assert.deepEqual(item.steps, []);
		assert.match(item.message ?? "", /取消/);
	}
	assert.equal(h.runs.length, 0);
	assert.deepEqual(h.calls, []);
	assert.equal(cache.size, 1);
});

test("空 UID 清单绝不发送 UID 集合", async t => {
	const h = harness();
	const cache = cacheFor(t);
	await assert.rejects(
		mutateEmail("mark", { ...batch([]), read: true }, emailConfig(), h.sessions, cache),
		(error: unknown) => error instanceof EmailError && error.code === "NO_MESSAGES",
	);
	assert.equal(h.runs.length, 0);
	assert.deepEqual(h.calls, []);
	assert.equal(cache.size, 1);
});

test("全部 UID 缺失时报告 failed，不写也不清缓存", async t => {
	const h = harness({ present: [] });
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"mark", { ...batch([1, 2]), read: true }, emailConfig(), h.sessions, cache,
	);
	assert.equal(result.status, "failed");
	for (const item of result.items) {
		assert.equal(item.status, "failed");
		assert.deepEqual(item.steps, []);
		assert.match(item.message ?? "", /不存在/);
	}
	assert.deepEqual(callsOf(h.calls, "messageFlagsAdd"), []);
	assert.equal(callsOf(h.calls, "fetchAll").length, 1);
	assert.equal(cache.size, 1);
});

test("STORE 收到服务器 NO 时判 failed，不当作 unknown", async t => {
	const h = harness({ fail: { flagsAdd: "no" } });
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"mark", { ...batch([1, 2]), read: true }, emailConfig(), h.sessions, cache,
	);
	assert.equal(result.status, "failed");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "read", status: "failed" }]);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 1);
	assert.equal(JSON.stringify(result).includes("Command failed"), false);
	assert.equal(cache.size, 0);
});

test("STORE 断线时判 unknown，且不重试", async t => {
	const h = harness({ fail: { flagsAdd: "network" } });
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"mark", { ...batch([1, 2]), read: true }, emailConfig(), h.sessions, cache,
	);
	assert.equal(result.status, "unknown");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "read", status: "unknown" }]);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 1);
	assert.equal(cache.size, 0);
});

test("库把断线折成 false 时按连接状态判 unknown", async t => {
	const h = harness({
		fail: { flagsAdd: "false" },
		onFlagsAdd: client => { client.usable = false; },
	});
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"mark", { ...batch([1, 2]), read: true }, emailConfig(), h.sessions, cache,
	);
	assert.equal(result.status, "unknown");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "read", status: "unknown" }]);
	assert.equal(callsOf(h.calls, "fetchAll").length, 1);
	assert.equal(cache.size, 0);
});

test("BYE 已进入 LOGOUT 但 usable 尚为 true：写入 false 不能误判服务器拒绝", async t => {
	for (const action of ["trash", "move", "purge"] as const) {
		const bye = (client: { phase: number }) => { client.phase = 4; };
		const h = harness({
			boxes: [{ path: "Archive" }, { path: "Trash" }],
			fail: { flagsAdd: "false", move: "false", delete: "false" },
			onFlagsAdd: bye, onMove: bye, onDelete: bye,
		});
		const input = action === "purge" ? batch([1, 2], "Trash")
			: action === "move" ? { ...batch([1, 2]), targetMailbox: "Archive" }
				: { ...batch([1, 2]), markRead: true };
		const result = await mutateEmail(action, input, emailConfig(), h.sessions, cacheFor(t));
		assert.equal(h.client.usable, true);
		assert.equal(result.status, "unknown");
		assert.equal(result.items[0]!.steps[0]!.status, "unknown");
		assert.equal(callsOf(h.calls, "fetchAll").length, 1);
		if (action === "trash") {
			assert.equal(callsOf(h.calls, "messageMove").length, 0);
			assert.equal(result.items[0]!.steps[1]!.status, "failed");
		}
	}
});

test("存在性 FETCH 后 BYE，尚未发出的 purge 明确失败", async t => {
	const h = harness({ onFetch: client => { client.phase = 4; } });
	const result = await mutateEmail("purge", batch([1, 2], "Trash"), emailConfig(), h.sessions, cacheFor(t));
	assert.equal(result.status, "failed");
	assert.equal(callsOf(h.calls, "messageDelete").length, 0);
	assert.equal(result.items[0]!.steps[0]!.status, "failed");
});

test("trash 标已读时断线：已读 unknown，未发出的 move 明确 failed", async t => {
	const controller = new AbortController();
	const h = harness({
		fail: { flagsAdd: "network" },
		onFlagsAdd: () => controller.abort(),
	});
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"trash", { ...batch([1, 2]), markRead: true }, emailConfig(), h.sessions, cache, controller.signal,
	);
	assert.equal(result.status, "unknown");
	for (const item of result.items) {
		assert.equal(item.status, "unknown");
		assert.deepEqual(
			item.steps.map(step => [step.action, step.status]),
			[["read", "unknown"], ["move", "failed"]],
		);
	}
	assert.equal(callsOf(h.calls, "messageMove").length, 0);
	assert.equal(callsOf(h.calls, "messageFlagsAdd").length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 1);
	assert.equal(cache.size, 0);
});

test("purge 返回 OK 但 FETCH 发现 UID 仍在时判 failed", async t => {
	const h = harness({ deleteNoop: true });
	const cache = cacheFor(t);
	const result = await mutateEmail("purge", batch([1, 2], "Trash"), emailConfig(), h.sessions, cache);
	assert.equal(result.status, "failed");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "purge", status: "failed" }]);
	assert.equal(callsOf(h.calls, "messageDelete").length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 2);
	assert.equal(cache.size, 0);
});

test("MOVE 收到服务器 NO 时判 failed，不当作 unknown", async t => {
	const h = harness({ boxes: [{ path: "Archive" }], fail: { move: "no" } });
	const cache = cacheFor(t);
	const result = await mutateEmail(
		"move", { ...batch([1, 2]), targetMailbox: "Archive" }, emailConfig(), h.sessions, cache,
	);
	assert.equal(result.status, "failed");
	for (const item of result.items)
		assert.deepEqual(item.steps, [{ action: "move", status: "failed" }]);
	assert.equal(callsOf(h.calls, "messageMove").length, 1);
	assert.equal(callsOf(h.calls, "fetchAll").length, 1);
	assert.equal(cache.size, 0);
});
