import { createHash } from "node:crypto";
import { openLocalFile, type LocalFile } from "./local-file.ts";
import { putBytes } from "./transport.ts";
import { checkAbort, UploadError } from "./errors.ts";
import { decodeReceipt, download, encodeReceipt, mcpData, plan, planIdentity, SINGLE_LIMIT, UPLOAD_TOOL, URL_TOOL,
	type Download, type FileMetadata, type Receipt, type Target } from "./protocol.ts";

export interface UploadParams {
	path: string;
	contentType?: string;
	expiresIn?: number;
	disposition?: "inline" | "attachment";
	resume?: string;
}
export interface UploadResult {
	uploaded: boolean | null;
	uploadStatus: "not-started" | "incomplete" | "unknown" | "uploaded";
	phase: "local" | "prepare" | "upload" | "complete" | "link";
	linkStatus: "not-ready" | "ready" | "failed";
	key?: string;
	uid?: string;
	url?: string;
	expiresAt?: string;
	expiresIn?: number;
	disposition?: "inline" | "attachment";
	fallback?: Download;
	resume?: string;
	error?: { code: string; message: string };
}
export interface Progress { phase: UploadResult["phase"]; completedParts: number; totalParts: number }
export interface UploadDependencies {
	/** 返回原始 MCP CallToolResult。认证和连接由主机负责。 */
	call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	put?: (target: Target, body: AsyncIterable<Uint8Array> | Uint8Array, signal: AbortSignal) => Promise<void>;
	open?: typeof openLocalFile;
	remoteTimeoutMs?: number;
	onProgress?: (progress: Progress) => void;
}

// 作用范围与服务基于元数据的身份判定一致，包括别名和硬链接。
// 延迟返回的主机调用结束前持续持锁；这不是分布式锁。
const active = new Set<string>();
const lockKey = (metadata: FileMetadata) => createHash("sha256").update(JSON.stringify(metadata)).digest("hex");

export async function uploadLocalFile(params: UploadParams, cwd: string, signal: AbortSignal,
	deps: UploadDependencies): Promise<UploadResult> {
	let file: LocalFile | undefined;
	let receipt: Receipt | undefined;
	let key: string | undefined;
	let fallback: Download | undefined;
	const pending = new Set<Promise<unknown>>();
	const state: UploadResult = { uploaded: false, uploadStatus: "not-started", phase: "local", linkStatus: "not-ready" };
	const seconds = params.expiresIn ?? 86400;
	const disposition = params.disposition ?? "inline";
	const put = deps.put ?? putBytes;
	const open = deps.open ?? openLocalFile;
	const notify = (completedParts = 0, totalParts = 0) => {
		// 渲染或进度观察器绝不能改变上传结果。
		try { deps.onProgress?.({ phase: state.phase, completedParts, totalParts }); } catch { /* 仅影响界面 */ }
	};
	const claim = (metadata: FileMetadata) => {
		const candidate = lockKey(metadata);
		if (active.has(candidate)) throw new UploadError("busy", "此文件仍有上传操作正在进行。请等待其停止后再恢复。");
		active.add(candidate);
		key = candidate;
	};
	const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
		checkAbort(signal);
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const timer = setTimeout(() => controller.abort(), deps.remoteTimeoutMs ?? 330_000);
		let stop: (() => void) | undefined;
		// 主机钩子或连接等待可能忽略取消。限制等待时间，但继续持锁。
		const work = Promise.resolve().then(() => {
			checkAbort(combined);
			return deps.call(tool, args, combined);
		});
		pending.add(work);
		void work.then(() => pending.delete(work), () => pending.delete(work));
		const stopped = new Promise<never>((_, reject) => {
			stop = () => reject(new UploadError(signal.aborted ? "cancelled" : "timeout",
				"远程操作结果未知。不要自动重复此操作。"));
			combined.addEventListener("abort", stop, { once: true });
			if (combined.aborted) stop();
		});
		try { return mcpData(await Promise.race([work, stopped])); }
		finally {
			clearTimeout(timer);
			if (stop) combined.removeEventListener("abort", stop);
		}
	};
	const acceptLink = (link: Download): UploadResult => ({ uploaded: true, uploadStatus: "uploaded",
		phase: "link", linkStatus: "ready", ...link, disposition, ...(receipt?.uid ? { uid: receipt.uid } : {}) });
	const getLink = async (objectKey: string) => {
		const link = download(await call(URL_TOOL, { key: objectKey, expiresIn: seconds, disposition }), objectKey, seconds);
		if (Date.parse(link.expiresAt) <= Date.now()) throw new UploadError("expired-link", "服务返回了已过期的下载链接；未尝试自动重新签名。");
		return link;
	};
	try {
		if (params.resume !== undefined) {
			receipt = decodeReceipt(params.resume);
			state.uploaded = receipt.phase === "link" ? true : null;
			state.uploadStatus = receipt.phase === "link" ? "uploaded" : "unknown";
		}
		checkAbort(signal);
		if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 604800 || !["inline", "attachment"].includes(disposition))
			throw new UploadError("invalid-options", "expiresIn 必须是 1 到 604800 之间的整数；disposition 必须是 inline 或 attachment。");
		if (receipt) {
			claim(receipt.metadata);
			state.phase = "link";
			notify();
			try { return acceptLink(await getLink(receipt.key)); }
			catch (error) {
				// 即使对象已不存在，也绝不重放单次 PUT 或已完成的上传。
				if (!(error instanceof UploadError) || error.code !== "not-found" || receipt.mode === "single" || receipt.phase === "link") throw error;
			}
			state.uploaded = false;
			state.uploadStatus = "incomplete";
		}
		file = await open(params.path, cwd, params.contentType ?? receipt?.metadata.contentType);
		if (receipt && (file.fingerprint !== receipt.fingerprint || JSON.stringify(file.metadata) !== JSON.stringify(receipt.metadata)))
			throw new UploadError("file-changed", "文件已与恢复凭条不匹配。不得复用旧分片。");
		if (!receipt) claim(file.metadata);
		// 单次上传使用固定快照；分片上传使用有界流式读取。
		const snapshot = file.metadata.size <= SINGLE_LIMIT ? await file.snapshot(signal) : undefined;
		await file.assertUnchanged();
		state.phase = "prepare";
		// 准备分片上传也可能完成已有的服务端任务。
		if (file.metadata.size > SINGLE_LIMIT) {
			state.uploaded = null;
			state.uploadStatus = "unknown";
		}
		notify();
		const rawPlan = await call(UPLOAD_TOOL, { ...file.metadata });
		const identity = planIdentity(rawPlan, file.metadata.size, receipt);
		receipt = { version: 1, key: identity.key, uid: identity.uid, mode: identity.mode,
			phase: identity.uploaded ? "link" : "upload", fingerprint: file.fingerprint, metadata: file.metadata };
		if (identity.uploaded) {
			state.uploaded = true;
			state.uploadStatus = "uploaded";
			state.phase = "link";
		}
		const prepared = plan(rawPlan, file.metadata.size, receipt);
		fallback = { key: prepared.key, url: prepared.url, expiresAt: prepared.expiresAt, expiresIn: prepared.expiresIn };
		if (!prepared.uploaded) {
			await file.assertUnchanged();
			state.phase = "upload";
			state.uploadStatus = "incomplete";
			const batch = new AbortController();
			const batchSignal = AbortSignal.any([signal, batch.signal]);
			let cursor = 0;
			let completed = 0;
			let failure: unknown;
			const worker = async () => {
				try {
					while (cursor < prepared.uploads.length) {
						checkAbort(batchSignal);
						const target = prepared.uploads[cursor++]!;
						state.uploaded = null;
						state.uploadStatus = "unknown";
						await put(target, snapshot ?? file!.bytes(target.offset, target.size, batchSignal), batchSignal);
						completed++;
						notify(completed, prepared.uploads.length);
					}
				} catch (error) { if (!failure) failure = error; batch.abort(); }
			};
			await Promise.allSettled(Array.from({ length: Math.min(3, prepared.uploads.length) }, worker));
			if (failure) throw failure;
			if (prepared.mode === "multipart") {
				await file.assertUnchanged();
				checkAbort(signal);
				state.phase = "complete";
				receipt.phase = "complete";
				notify(completed, prepared.uploads.length);
				// 只进行一次状态核对或完成调用；绝不循环调用或自动重发分片。
				const completion = await call(UPLOAD_TOOL, { ...file.metadata });
				const completedIdentity = planIdentity(completion, file.metadata.size, receipt);
				if (!completedIdentity.uploaded) {
					receipt.phase = "upload";
					state.uploaded = false;
					state.uploadStatus = "incomplete";
					throw new UploadError("incomplete-upload", "服务仍报告有缺失分片。请显式恢复；未重试任何分片。");
				}
				state.uploaded = true;
				state.uploadStatus = "uploaded";
				state.phase = "link";
				receipt.phase = "link";
				const completedPlan = plan(completion, file.metadata.size, receipt);
				fallback = { key: completedPlan.key, url: completedPlan.url, expiresAt: completedPlan.expiresAt, expiresIn: completedPlan.expiresIn };
			}
		}
		state.uploaded = true;
		state.uploadStatus = "uploaded";
		state.phase = "link";
		receipt.phase = "link";
		notify();
		if (seconds === 86400 && disposition === "inline" && Date.parse(fallback.expiresAt) > Date.now()) return acceptLink(fallback);
		return acceptLink(await getLink(receipt.key));
	} catch (error) {
		const safe = error instanceof UploadError ? error : new UploadError("operation-failed",
			"上传操作失败。已隐藏原始错误；不要自动重试。");
		return { ...state, linkStatus: state.phase === "link" ? "failed" : "not-ready",
			...(receipt ? { key: receipt.key, uid: receipt.uid, resume: encodeReceipt(receipt) } : {}),
			...(state.uploaded === true && fallback && Date.parse(fallback.expiresAt) > Date.now() ? { fallback } : {}),
			error: { code: safe.code, message: safe.message } };
	} finally {
		await file?.close().catch(() => {});
		if (key) {
			const held = key;
			if (pending.size === 0) active.delete(held);
			else void Promise.allSettled([...pending]).then(() => active.delete(held));
		}
	}
}
