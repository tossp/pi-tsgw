import { constants } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { homedir } from "node:os";
import { CONTENT_TYPE_PATTERN, MAX_BYTES, type FileMetadata } from "./protocol.ts";
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

/** 使用操作系统的文件访问权限，而非沙箱或内置 read 工具的权限策略。 */
export async function openLocalFile(path: string, cwd: string, contentType?: string): Promise<LocalFile> {
	let handle: FileHandle | undefined;
	try {
		if (!path || path.includes("\0")) throw new UploadError("invalid-path", "必须提供本地文件路径。");
		const fullPath = await realpath(resolve(cwd, path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path));
		// NONBLOCK 防止普通文件被竞态替换为 FIFO 时导致 open() 挂起。
		if (!(await stat(fullPath)).isFile()) throw new UploadError("not-file", "只能上传普通文件。");
		handle = await open(fullPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const opened = handle;
		const initial = await fileStat(opened);
		if (!initial.isFile()) throw new UploadError("not-file", "只能上传普通文件。");
		const size = Number(initial.size);
		if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES)
			throw new UploadError("invalid-size", "文件大小必须在 1 字节到 5 TiB 之间。后端限制可能更低。");
		const filename = basename(fullPath);
		if (Buffer.byteLength(filename) > 255 || filename.trim() !== filename || /[\u0000-\u001f\u007f-\u009f\\%?#:<>"|*]/.test(filename))
			throw new UploadError("invalid-filename", "上传服务不支持此文件名。");
		const mime = contentType ?? MIME[extname(filename).toLowerCase()] ?? "application/octet-stream";
		if (mime.length > 127 || !CONTENT_TYPE_PATTERN.test(mime))
			throw new UploadError("invalid-content-type", "contentType 必须是不带参数的 MIME 类型。");
		const metadata: FileMetadata = { filename, contentType: mime.toLowerCase(), size,
			mtimeMs: Number(initial.mtimeNs) / 1e6, ctimeMs: Number(initial.ctimeNs) / 1e6 };
		const stamp = identity(initial);
		const fingerprint = createHash("sha256").update(JSON.stringify([fullPath, stamp, metadata])).digest("hex");
		const assertUnchanged = async (): Promise<void> => {
			try {
				if (identity(await fileStat(opened)) !== stamp || identity(await stat(fullPath, { bigint: true })) !== stamp)
					throw new Error();
			} catch { throw new UploadError("file-changed", "源文件已更改。不得复用其旧分片或用旧分片完成上传。"); }
		};
		async function* bytes(offset: number, count: number, signal: AbortSignal): AsyncIterable<Uint8Array> {
			checkAbort(signal);
			await assertUnchanged();
			let position = offset;
			while (position < offset + count) {
				checkAbort(signal);
				// 显式指定位置，让并发分片无需共享文件描述符的游标。
				const buffer = Buffer.allocUnsafe(Math.min(256 * 1024, offset + count - position));
				const { bytesRead } = await opened.read(buffer, 0, buffer.length, position);
				if (bytesRead === 0) throw new UploadError("file-changed", "源文件在上传期间被截断。");
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
		throw new UploadError("file-unavailable", "无法读取插件运行环境中的本地文件。");
	}
}
