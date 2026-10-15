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
	/** Returns the raw MCP CallToolResult. Authentication/connection belong to the host. */
	call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
	put?: (target: Target, body: AsyncIterable<Uint8Array> | Uint8Array, signal: AbortSignal) => Promise<void>;
	open?: typeof openLocalFile;
	remoteTimeoutMs?: number;
	onProgress?: (progress: Progress) => void;
}

// Scope matches the service's metadata-based identity, including aliases/hard links.
// The lock remains held until late host calls settle; it is not a distributed lock.
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
		// Rendering/progress observers must never change upload outcome.
		try { deps.onProgress?.({ phase: state.phase, completedParts, totalParts }); } catch { /* UI only */ }
	};
	const claim = (metadata: FileMetadata) => {
		const candidate = lockKey(metadata);
		if (active.has(candidate)) throw new UploadError("busy", "An upload for this file is still in flight. Wait for it to stop before resuming.");
		active.add(candidate);
		key = candidate;
	};
	const call = async (tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
		checkAbort(signal);
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const timer = setTimeout(() => controller.abort(), deps.remoteTimeoutMs ?? 330_000);
		let stop: (() => void) | undefined;
		// Host hooks/connection waits may ignore cancellation. Bound waiting, retain the lock.
		const work = Promise.resolve().then(() => {
			checkAbort(combined);
			return deps.call(tool, args, combined);
		});
		pending.add(work);
		void work.then(() => pending.delete(work), () => pending.delete(work));
		const stopped = new Promise<never>((_, reject) => {
			stop = () => reject(new UploadError(signal.aborted ? "cancelled" : "timeout",
				"Remote result is unknown. Do not automatically repeat the operation."));
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
		if (Date.parse(link.expiresAt) <= Date.now()) throw new UploadError("expired-link", "The service returned an expired download link; no automatic re-sign was attempted.");
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
			throw new UploadError("invalid-options", "expiresIn must be an integer from 1 to 604800; disposition must be inline or attachment.");
		if (receipt) {
			claim(receipt.metadata);
			state.phase = "link";
			notify();
			try { return acceptLink(await getLink(receipt.key)); }
			catch (error) {
				// Never replay a single PUT or a completed upload, even when the object is gone.
				if (!(error instanceof UploadError) || error.code !== "not-found" || receipt.mode === "single" || receipt.phase === "link") throw error;
			}
			state.uploaded = false;
			state.uploadStatus = "incomplete";
		}
		file = await open(params.path, cwd, params.contentType ?? receipt?.metadata.contentType);
		if (receipt && (file.fingerprint !== receipt.fingerprint || JSON.stringify(file.metadata) !== JSON.stringify(receipt.metadata)))
			throw new UploadError("file-changed", "The file no longer matches the resume receipt. Old parts must not be reused.");
		if (!receipt) claim(file.metadata);
		// Single uploads use a fixed snapshot; multipart uploads use bounded streaming reads.
		const snapshot = file.metadata.size <= SINGLE_LIMIT ? await file.snapshot(signal) : undefined;
		await file.assertUnchanged();
		state.phase = "prepare";
		// Preparing multipart may also complete a pre-existing server-side task.
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
				// One reconciliation/complete call; never loop or resend a part automatically.
				const completion = await call(UPLOAD_TOOL, { ...file.metadata });
				const completedIdentity = planIdentity(completion, file.metadata.size, receipt);
				if (!completedIdentity.uploaded) {
					receipt.phase = "upload";
					state.uploaded = false;
					state.uploadStatus = "incomplete";
					throw new UploadError("incomplete-upload", "The service still reports missing parts. Resume explicitly; no part was retried.");
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
			"The upload operation failed. Raw errors were withheld; do not automatically retry.");
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
