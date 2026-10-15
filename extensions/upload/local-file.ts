import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { MAX_BYTES, type FileMetadata } from "./protocol.ts";
import { checkAbort, UploadError } from "./errors.ts";

const MIME: Record<string, string> = {
	".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html",
	".json": "application/json", ".pdf": "application/pdf", ".zip": "application/zip",
	".gz": "application/gzip", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".mp3": "audio/mpeg",
	".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
};

type FileStat = Awaited<ReturnType<typeof fileStat>>;
const fileStat = (handle: FileHandle) => handle.stat({ bigint: true });
const identity = (s: FileStat): string =>
	[s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");

export interface LocalFile {
	metadata: FileMetadata;
	fingerprint: string;
	assertUnchanged(): Promise<void>;
	bytes(offset: number, size: number, signal: AbortSignal): AsyncIterable<Uint8Array>;
	snapshot(signal: AbortSignal): Promise<Uint8Array>;
	close(): Promise<void>;
}

/** OS file access, NOT a sandbox or the built-in read tool's permission policy. */
export async function openLocalFile(path: string, cwd: string, contentType?: string): Promise<LocalFile> {
	let handle: FileHandle | undefined;
	try {
		if (!path || path.includes("\0")) throw new UploadError("invalid-path", "A local file path is required.");
		const fullPath = await realpath(resolve(cwd, path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path));
		// NONBLOCK prevents a race replacing a regular file with a FIFO from hanging open().
		if (!(await stat(fullPath)).isFile()) throw new UploadError("not-file", "Only regular files can be uploaded.");
		handle = await open(fullPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const opened = handle;
		const initial = await fileStat(opened);
		if (!initial.isFile()) throw new UploadError("not-file", "Only regular files can be uploaded.");
		const size = Number(initial.size);
		if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES)
			throw new UploadError("invalid-size", "Files must contain 1 byte to 5 TiB. Backend limits may be lower.");
		const filename = basename(fullPath);
		if (Buffer.byteLength(filename) > 255 || filename.trim() !== filename || /[\u0000-\u001f\u007f-\u009f\\%?#:<>"|*]/.test(filename))
			throw new UploadError("invalid-filename", "The file name cannot be represented by the upload service.");
		const mime = contentType ?? MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
		if (mime.length > 127 || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mime))
			throw new UploadError("invalid-content-type", "contentType must be a MIME type without parameters.");
		const metadata: FileMetadata = { filename, contentType: mime.toLowerCase(), size,
			mtimeMs: Number(initial.mtimeNs) / 1e6, ctimeMs: Number(initial.ctimeNs) / 1e6 };
		const stamp = identity(initial);
		const fingerprint = createHash("sha256").update(JSON.stringify([fullPath, stamp, metadata])).digest("hex");
		const assertUnchanged = async (): Promise<void> => {
			try {
				if (identity(await fileStat(opened)) !== stamp || identity(await stat(fullPath, { bigint: true })) !== stamp)
					throw new Error();
			} catch { throw new UploadError("file-changed", "The source file changed. Its old parts must not be reused or completed."); }
		};
		async function* bytes(offset: number, count: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
			checkAbort(signal);
			await assertUnchanged();
			let position = offset;
			while (position < offset + count) {
				checkAbort(signal);
				// Explicit positions allow concurrent parts without sharing the descriptor's cursor.
				const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, offset + count - position));
				const { bytesRead } = await opened.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) throw new UploadError("file-changed", "The source file was truncated during upload.");
				position += bytesRead;
				yield buffer.subarray(0, bytesRead);
			}
			await assertUnchanged();
		}
		await assertUnchanged();
		return {
			metadata, fingerprint, assertUnchanged, bytes,
			async snapshot(signal) {
				const data = new Uint8Array(size);
				let offset = 0;
				for await (const block of bytes(0, size, signal)) { data.set(block, offset); offset += block.byteLength; }
				return data;
			},
			close: () => opened.close(),
		};
	} catch (error) {
		await handle?.close().catch(() => {});
		if (error instanceof UploadError) throw error;
		throw new UploadError("file-unavailable", "Cannot read the local file in the plugin's environment.");
	}
}
