import type { FetchMessageObject, ImapFlow } from "imapflow";
import type { EmailCache } from "./cache.ts";
import type { EmailConfig, ImapAccountConfig } from "./config.ts";
import type { ImapSessions } from "./imap-session.ts";
import { assertMailbox } from "./message.ts";
import {
	EmailError, type MarkInput, type MessageBatch, type MoveInput, type MutationAction,
	type MutationInput, type MutationItem, type MutationResult, type OperationStatus, type TrashInput,
} from "./types.ts";

/** 明确 UID 清单只发固定次数的 UID FETCH/STORE/MOVE/EXPUNGE；不逐封往返、不 SEARCH 扩单、不用序号。 */
const SAFE = {
	canceled: "操作已取消，未执行。",
	missing: "指定邮件已不存在，未执行操作。",
	notStarted: "连接已中断，未执行操作。",
	rejected: "服务器拒绝执行该操作。",
	partial: "部分步骤未完成，请重新查询确认。",
	unknown: "连接中断或无法核对结果，请重新查询确认。",
	startFailed: "邮件操作未能开始，请稍后重试。",
	destinationMissing: "目标文件夹不存在或不可选择，未执行操作。",
	destinationUnknown: "无法确认目标文件夹，未执行操作。",
} as const;

interface Change { action: string; flag: string; add: boolean }
interface Work { uid: number; present: boolean; item: MutationItem }
type Halt = "canceled" | "disconnected" | undefined;
/** 与 imapflow 2.9.1 的 hasCapability 一致：显式通告，或真实启用 rev2／服务器仅支持 rev2。 */
function supports(client: ImapFlow, capability: "MOVE" | "UIDPLUS"): boolean {
	return client.capabilities.has(capability)
		|| client.enabled.has("IMAP4REV2")
		|| (client.capabilities.has("IMAP4rev2") && !client.capabilities.has("IMAP4rev1"));
}
/** tagged NO/BAD 在 imapflow 错误对象上带 responseStatus；NoConnection/BYE 不走该分支。 */
function refused(error: unknown): boolean {
	const status = (error as { responseStatus?: unknown } | null)?.responseStatus;
	return status === "NO" || status === "BAD";
}
/** BYE 先进入 LOGOUT，传输层延迟关闭时 usable 可能还未清除。 */
function connected(client: ImapFlow): boolean {
	return client.usable && client.state !== client.states.LOGOUT;
}
/** STORE/MOVE/EXPUNGE 对命令异常也返回 false；连接已不可用或已取消时按 unknown。 */
function falseStatus(client: ImapFlow, signal: AbortSignal | undefined): OperationStatus {
	return !connected(client) || signal?.aborted ? "unknown" : "failed";
}

/** 目标必须已存在且可选择；INBOX 由协议保证，其余用一次 LIST 精确匹配，不创建目录。 */
async function requireDestination(client: ImapFlow, destination: string): Promise<void> {
	if (destination.toUpperCase() === "INBOX") return;
	const entries = await client.list({ listOnly: true })
		.catch(() => { throw new EmailError("DESTINATION_UNKNOWN", SAFE.destinationUnknown); });
	const target = entries.find(entry => entry.path === destination);
	if (!target) throw new EmailError("DESTINATION_MISSING", SAFE.destinationMissing);
	// \Noselect 不能选择；\NonExistent 只是子目录占位名，本身不存在。
	if ([...target.flags].some(flag => ["\\NOSELECT", "\\NONEXISTENT"].includes(flag.toUpperCase())))
		throw new EmailError("DESTINATION_MISSING", SAFE.destinationMissing);
}

function planFor(action: MutationAction, input: MutationInput, settings: ImapAccountConfig): { destination?: string; changes: Change[] } {
	const changes: Change[] = [];
	const mark = input as MarkInput;
	if (action === "mark") {
		if (mark.read !== undefined) changes.push({ action: "read", flag: "\\Seen", add: mark.read });
		if (mark.flagged !== undefined) changes.push({ action: "flagged", flag: "\\Flagged", add: mark.flagged });
	} else if (action === "trash" && (input as TrashInput).markRead === true) {
		changes.push({ action: "read", flag: "\\Seen", add: true });
	}
	const destinations: Partial<Record<MutationAction, string>> = {
		move: (input as MoveInput).targetMailbox,
		trash: settings.trashMailbox,
		junk: settings.junkMailbox,
		not_junk: "INBOX",
	};
	const destination = destinations[action];
	// 未知 action 或缺失移动目标都不应静默变成空操作。
	if (action !== "mark" && action !== "purge" && !destination)
		throw new EmailError("INVALID_ACTION", "不支持的邮件操作。");
	return { destination, changes };
}
async function fetchAll(client: ImapFlow, uids: number[], flags = false): Promise<FetchMessageObject[]> {
	return client.fetchAll(uids, flags ? { uid: true, flags: true } : { uid: true }, { uid: true });
}

async function fetchUids(client: ImapFlow, uids: number[]): Promise<Set<number>> {
	return new Set((await fetchAll(client, uids)).map(row => row.uid));
}
function hasFlag(flags: Set<string> | undefined, flag: string): boolean | undefined {
	if (!flags) return undefined;
	for (const value of flags) if (value.toUpperCase() === flag.toUpperCase()) return true;
	return false;
}

function markStep(work: Work[], index: number, status: OperationStatus): void {
	for (const w of work) w.item.steps[index]!.status = status;
}
/** 批量 STORE 后用一次 FETCH flags 逐项核对；返回是否因断线/取消中止后续阶段。 */
async function flagBatch(client: ImapFlow, signal: AbortSignal | undefined, uids: number[], changes: Change[], work: Work[], clear: () => void): Promise<boolean> {
	const pending: number[] = [];
	let halted = false;
	for (let index = 0; index < changes.length; index += 1) {
		const change = changes[index]!;
		if (signal?.aborted || !connected(client)) {
			halted = true;
			break;
		}
		clear();
		let status: OperationStatus;
		try {
			const ok = change.add
				? await client.messageFlagsAdd(uids, [change.flag], { uid: true })
				: await client.messageFlagsRemove(uids, [change.flag], { uid: true });
			status = ok ? "success" : falseStatus(client, signal);
		} catch (error) {
			status = refused(error) ? "failed" : "unknown";
		}
		if (status === "success") { pending.push(index); continue; }
		markStep(work, index, status);
		if (status === "unknown") { halted = true; break; }
	}

	if (pending.length > 0 && !halted && !signal?.aborted && connected(client)) {
		let rows: FetchMessageObject[] | undefined;
		try { rows = await fetchAll(client, uids, true); } catch { rows = undefined; }
		const flags = new Map((rows ?? []).map(row => [row.uid, row.flags]));
		for (const index of pending) for (const w of work) {
			const actual = hasFlag(flags.get(w.uid), changes[index]!.flag);
			w.item.steps[index]!.status = actual === undefined ? "unknown" : actual === changes[index]!.add ? "success" : "failed";
		}
		// 核对请求本身断线/取消时，后续阶段不能再发。
		if (!rows && (!connected(client) || signal?.aborted)) halted = true;
	} else if (pending.length > 0) {
		for (const index of pending) markStep(work, index, "unknown");
	}
	return halted || signal?.aborted === true || !connected(client);
}
/** 一次批量 UID MOVE；缺 uidMap 时用一次源 FETCH 核对，不能证明就保留 unknown。 */
async function moveBatch(client: ImapFlow, signal: AbortSignal | undefined, uids: number[], destination: string, work: Work[], step: number, clear: () => void): Promise<void> {
	clear();
	let response: Awaited<ReturnType<ImapFlow["messageMove"]>>;
	try {
		response = await client.messageMove(uids, destination, { uid: true });
	} catch (error) {
		return markStep(work, step, refused(error) ? "failed" : "unknown");
	}
	if (!response) return markStep(work, step, falseStatus(client, signal));
	const info = (uid?: number): NonNullable<MutationItem["destination"]> => ({
		mailbox: response.destination || destination,
		...(response.uidValidity === undefined ? {} : { uidValidity: response.uidValidity.toString() }),
		...(uid === undefined ? {} : { uid }),
	});
	const targets = new Map(work.map(w => [w.uid, response.uidMap?.get(w.uid)]));
	const unresolved = work.filter(w => targets.get(w.uid) === undefined).map(w => w.uid);
	let present: Set<number> | undefined;
	if (unresolved.length > 0 && !signal?.aborted && connected(client)) {
		try { present = await fetchUids(client, unresolved); } catch { present = undefined; }
	}
	for (const w of work) {
		const target = targets.get(w.uid);
		if (target !== undefined) {
			w.item.steps[step]!.status = "success";
			w.item.destination = info(target);
		} else if (!present) {
			w.item.steps[step]!.status = "unknown";
		} else if (present.has(w.uid)) {
			w.item.steps[step]!.status = "failed";
		} else {
			w.item.steps[step]!.status = "success";
			w.item.destination = info();
		}
	}
}
/** 一次批量 UID EXPUNGE，再用一次 FETCH 核对：已不在=成功，仍在=failed。 */
async function purgeBatch(client: ImapFlow, signal: AbortSignal | undefined, uids: number[], work: Work[], clear: () => void): Promise<void> {
	clear();
	try {
		if (!(await client.messageDelete(uids, { uid: true }))) {
			markStep(work, 0, falseStatus(client, signal));
			return;
		}
	} catch (error) {
		markStep(work, 0, refused(error) ? "failed" : "unknown");
		return;
	}
	if (signal?.aborted || !connected(client)) {
		markStep(work, 0, "unknown");
		return;
	}
	let present: Set<number> | undefined;
	try { present = await fetchUids(client, uids); } catch { present = undefined; }
	for (const w of work)
		w.item.steps[0]!.status = !present ? "unknown" : present.has(w.uid) ? "failed" : "success";
}

function finalize(work: Work[], halt: Halt): void {
	for (const w of work) {
		if (!w.present) continue;
		const item = w.item;
		const statuses = item.steps.map(step => step.status);
		if (statuses.includes("unknown")) { item.status = "unknown"; item.message = SAFE.unknown; continue; }
		if (!statuses.includes("failed")) { item.status = "success"; delete item.message; continue; }
		item.status = "failed";
		item.message = statuses.includes("success") ? SAFE.partial
			: halt === "canceled" ? SAFE.canceled
				: halt === "disconnected" ? SAFE.notStarted : SAFE.rejected;
	}
}

function aggregate(items: MutationItem[]): MutationResult["status"] {
	const statuses = items.flatMap(item => [item.status, ...item.steps.map(step => step.status)]);
	const success = statuses.includes("success");
	const failed = statuses.includes("failed");
	const unknown = statuses.includes("unknown");
	if (unknown) return success ? "partial" : "unknown";
	return success && failed ? "partial" : failed ? "failed" : "success";
}

function canceled(batch: MessageBatch): MutationResult {
	return {
		status: "failed", account: batch.account, mailbox: batch.mailbox, uidValidity: batch.uidValidity,
		items: batch.uids.map(uid => ({ uid, status: "failed", steps: [], message: SAFE.canceled })),
	};
}

export async function mutateEmail(
	action: MutationAction, input: MutationInput, config: EmailConfig,
	sessions: ImapSessions, cache: EmailCache, signal?: AbortSignal,
): Promise<MutationResult> {
	const batch = input as MessageBatch;
	// 空清单绝不发 UID 集合；入口 schema 有 minItems，这里是网络层兜底。
	if (batch.uids.length === 0) throw new EmailError("NO_MESSAGES", "未指定要操作的邮件。");
	const settings = config.imap[batch.account];
	if (!settings) throw new EmailError("ACCOUNT_MISSING", "未配置指定的 IMAP 账户。");
	// purge 只允许该账户配置的回收站，严格逐字符比较，不猜、不做大小写归一。
	if (action === "purge" && batch.mailbox !== settings.trashMailbox)
		throw new EmailError("PURGE_SOURCE_INVALID", "只能永久删除该账户回收站文件夹中的邮件。");
	const { destination, changes } = planFor(action, input, settings);
	if (signal?.aborted) return canceled(batch);

	const work: Work[] = batch.uids.map(uid => ({ uid, present: false, item: { uid, status: "failed", steps: [] } }));
	let wrote = false;
	// 第一次真实写入前清空缓存；写入后的成功、失败或未知都不能再信旧状态。
	const clear = (): void => {
		if (wrote) return;
		wrote = true;
		cache.clear();
	};
	let halt: Halt = undefined;

	try {
		await sessions.run(batch.account, batch.mailbox, signal, async client => {
			assertMailbox(client, batch);
			// 能力只预检一次；不足时整批拒绝，不进入库的 COPY+EXPUNGE 降级路径。
			if (destination && !supports(client, "MOVE"))
				throw new EmailError("MOVE_UNSUPPORTED", "服务器不支持原生移动命令，已取消操作，未修改邮件。");
			if (action === "purge" && !supports(client, "UIDPLUS"))
				throw new EmailError("UID_EXPUNGE_UNSUPPORTED", "服务器不支持按 UID 永久删除，已取消操作，未修改邮件。");
			if (destination) await requireDestination(client, destination);

			// 一次批量 FETCH 同时确认存在性；缺失 UID 不进入任何写命令。
			const rows = await fetchAll(client, batch.uids, true);
			const existing = new Set(rows.map(row => row.uid));
			for (const w of work) if (!existing.has(w.uid)) w.item.message = SAFE.missing;
			const active = work.filter(w => existing.has(w.uid));
			if (active.length === 0) return;
			for (const w of active) {
				w.present = true;
				for (const change of changes) w.item.steps.push({ action: change.action, status: "failed" });
				if (action === "purge") w.item.steps.push({ action: "purge", status: "failed" });
				else if (destination) w.item.steps.push({ action: "move", status: "failed" });
			}
			const uids = active.map(w => w.uid);

			if (signal?.aborted || !connected(client)) {
				halt = signal?.aborted ? "canceled" : "disconnected";
				return;
			}
			if (action === "purge") {
				await purgeBatch(client, signal, uids, active, clear);
				return;
			}
			if (changes.length > 0) {
				const halted = await flagBatch(client, signal, uids, changes, active, clear);
				if (halted) halt = signal?.aborted ? "canceled" : "disconnected";
				if (action === "mark" || halted) return;
			}
			if (signal?.aborted || !connected(client)) {
				halt = signal?.aborted ? "canceled" : "disconnected";
				return;
			}
			if (destination) await moveBatch(client, signal, uids, destination, active, changes.length, clear);
		});
	} catch (error) {
		// 写入开始前的失败直接拒绝；开始后保留逐项结果，不抹掉已完成的步骤。
		if (!wrote) {
			if (error instanceof EmailError) throw error;
			if (signal?.aborted) throw new EmailError("ABORTED", SAFE.canceled);
			throw new EmailError("MUTATION_FAILED", SAFE.startFailed);
		}
	}

	finalize(work, halt);
	const items = work.map(w => w.item);
	return {
		status: aggregate(items), account: batch.account, mailbox: batch.mailbox,
		uidValidity: batch.uidValidity, items,
	};
}
