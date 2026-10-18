import { constants } from "node:fs";
import { mkdtemp, open, realpath, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { ImageContent } from "@earendil-works/pi-ai";
import { inspectImage } from "#tsgw/models/adapter/images/image-data";
import { MAX_IMAGE_INPUT_BYTES, MAX_IMAGE_INPUT_TOTAL_BYTES, type ImageFormat, type ImageReference } from "#tsgw/models/adapter/images/parameters";
import { plainObject } from "./tool-schema.ts";

// 与适配器共用十进制字节预算；保留工具测试的导出入口。
export const MAX_INPUT_FILE_BYTES = MAX_IMAGE_INPUT_BYTES;
export const MAX_INPUT_TOTAL_BYTES = MAX_IMAGE_INPUT_TOTAL_BYTES;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
export interface ImageFileResult { path: string; mimeType: string; width: number; height: number }
export class ImageToolFileError extends Error {
	constructor(readonly code: string, message: string, readonly files: ImageFileResult[] = []) { super(message); }
}
type Inspected = ReturnType<typeof inspectImage>;
interface LoadedSource { reference: ImageReference; inspected?: Inspected }
interface Budget { used: number }
const fail = (code: string, message: string): never => { throw new ImageToolFileError(code, message); };
function charge(size: number, budget: Budget): void {
	if (size <= 0 || size >= MAX_INPUT_FILE_BYTES || budget.used + size > MAX_INPUT_TOTAL_BYTES)
		fail("input-too-large", "每个本地或内联图片必须小于50 MB，全部参考图与蒙版合计不超过100 MB。");
	budget.used += size;
}
function inspect(data: string): Inspected {
	try { return inspectImage(data); }
	catch { return fail("invalid-image", "本地或内联图片不是有效的 PNG、JPEG 或 WebP 容器；未转码或修复图片。"); }
}
const fileStat = (handle: FileHandle) => handle.stat({ bigint: true });
type FileStat = Awaited<ReturnType<typeof fileStat>>;
const identity = (value: FileStat): string => [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(":");

/** 本工具的读取权限等同 Pi 进程的 OS 权限；不依赖内置 read，也不声称沙箱。 */
async function localImage(path: string, cwd: string, signal: AbortSignal, budget: Budget): Promise<LoadedSource> {
	let handle: FileHandle | undefined;
	try {
		signal.throwIfAborted();
		if (!path || path.includes("\0")) fail("invalid-path", "必须提供有效的本地文件路径。");
		const full = await realpath(resolve(cwd, path));
		const before = await stat(full, { bigint: true });
		if (!before.isFile()) fail("not-file", "图片输入只支持普通文件，不能读取目录、FIFO 或设备。");
		// 防止检查后被替换成 FIFO/符号链接；open 后再检查实际文件身份。
		handle = await open(full, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
		const initial = await fileStat(handle);
		if (!initial.isFile() || identity(initial) !== identity(before)) fail("file-changed", "图片源文件在读取期间发生变化。");
		const size = Number(initial.size);
		charge(size, budget);
		const bytes = Buffer.allocUnsafe(size);
		let offset = 0;
		while (offset < size) {
			signal.throwIfAborted();
			const result = await handle.read(bytes, offset, Math.min(1024 * 1024, size - offset), offset);
			if (!result.bytesRead) fail("file-changed", "图片源文件在读取期间被截断。");
			offset += result.bytesRead;
		}
		signal.throwIfAborted();
		if (identity(await fileStat(handle)) !== identity(initial) || identity(await stat(full, { bigint: true })) !== identity(initial))
			fail("file-changed", "图片源文件在读取期间发生变化。");
		const inspected = inspect(bytes.toString("base64"));
		return { reference: { image_url: `data:${inspected.mimeType};base64,${inspected.data}` }, inspected };
	} catch (error) {
		if (error instanceof ImageToolFileError) throw error;
		if (signal.aborted) return fail("aborted", "读取图片输入已取消。");
		return fail("file-unavailable", "无法稳定读取 Pi 主机上的图片文件；请检查路径与操作系统权限。");
	} finally { await handle?.close().catch(() => {}); }
}

async function loadSource(value: unknown, cwd: string, signal: AbortSignal, budget: Budget): Promise<LoadedSource> {
	signal.throwIfAborted();
	if (!plainObject(value)) return fail("invalid-source", "图片来源必须是仅含 path、image_url 或 file_id 之一的对象。");
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 1 || typeof keys[0] !== "string" || !["path", "image_url", "file_id"].includes(keys[0]))
		return fail("invalid-source", "每个图片来源必须且只能指定 path、image_url 或 file_id 一个字段。");
	const key = keys[0], source = value[key];
	if (typeof source !== "string" || !source.trim()) return fail("invalid-source", "图片来源不能是空值。");
	if (key === "path") return localImage(source, cwd, signal, budget);
	if (key === "file_id") {
		if (source.length > 8192) return fail("invalid-source", "图片文件 ID 过长。");
		return { reference: { file_id: source } };
	}
	if (source.startsWith("data:")) {
		// 先限制字符串大小，再让 inspectImage 验证 canonical base64 和真实容器。
		if (source.length > Math.ceil(MAX_INPUT_FILE_BYTES / 3) * 4 + 64) return fail("input-too-large", "内联图片超过输入字节预算。");
		const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(source);
		if (!match) return fail("invalid-source", "内联图片必须是 PNG/JPEG/WebP 的 base64 data URI。");
		charge(Math.floor(match[2].length * 3 / 4) - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0), budget);
		const inspected = inspect(match[2]);
		if (inspected.mimeType !== match[1]) return fail("invalid-image", "内联图片声明的 MIME 与原始字节格式不一致。");
		return { reference: { image_url: source }, inspected };
	}
	try {
		const url = new URL(source);
		if (source.length > 8192 || /[\u0000-\u0020\u007f]/.test(source) || !/^https?:\/\//i.test(source) || /^https?:\/\/[^/?#]*@/i.test(source) ||
			!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password)
			throw new Error();
	} catch { return fail("invalid-source", "图片 URL 必须是无用户名密码的有效 HTTP(S) URL；本工具不会下载校验远程引用。"); }
	return { reference: { image_url: source } };
}

export async function resolveImageSources(images: unknown, mask: unknown, cwd: string, signal: AbortSignal): Promise<{ images: ImageReference[]; mask?: ImageReference }> {
	if (!Array.isArray(images) || images.length < 1 || images.length > 16) return fail("invalid-images", "编辑必须提供1..16张参考图片，蒙版不计入此张数。");
	const budget = { used: 0 };
	const loaded: LoadedSource[] = [];
	for (const source of images) loaded.push(await loadSource(source, cwd, signal, budget));
	const loadedMask = mask === undefined || mask === null ? undefined : await loadSource(mask, cwd, signal, budget);
	if (loadedMask?.inspected) {
		if (!loadedMask.inspected.hasAlpha) return fail("invalid-mask", "可本地校验的蒙版必须具有透明通道。");
		const first = loaded[0].inspected;
		if (first && (first.width !== loadedMask.inspected.width || first.height !== loadedMask.inspected.height || first.mimeType !== loadedMask.inspected.mimeType))
			return fail("invalid-mask", "蒙版的尺寸与图片格式必须和第一张参考图一致。");
	}
	return { images: loaded.map(item => item.reference), ...(loadedMask ? { mask: loadedMask.reference } : {}) };
}

/** 再检查宿主返回的数量/格式/容器，防止绕过适配器的错误实现被当作成功。 */
export function validateImageOutput(output: unknown, count: number, format: ImageFormat): ImageContent[] {
	if (!Array.isArray(output) || output.length !== count) return fail("invalid-output", "上游成功响应的最终图片数量不符合请求；不要自动重新生成。");
	return output.map(block => {
		if (!plainObject(block) || block.type !== "image" || typeof block.data !== "string" || block.data.length > Math.ceil(MAX_OUTPUT_BYTES / 3) * 4)
			return fail("invalid-output", "上游成功响应包含无效或过大的图片块；不要自动重新生成。");
		let inspected: Inspected;
		try { inspected = inspectImage(block.data, format); }
		catch { return fail("invalid-output", "上游成功响应的图片容器或格式不符合请求；不要自动重新生成。"); }
		if (inspected.mimeType !== block.mimeType || inspected.width > 3840 || inspected.height > 3840 || inspected.width * inspected.height > 8_294_400)
			return fail("invalid-output", "上游成功响应的图片 MIME 或尺寸不符合要求；不要自动重新生成。");
		return { type: "image", data: inspected.data, mimeType: inspected.mimeType };
	});
}

/** 唯一临时目录 + 排他创建；只保存原始字节，绝不覆盖用户路径。 */
export async function saveImageOutput(images: ImageContent[]): Promise<ImageFileResult[]> {
	const files: ImageFileResult[] = [];
	let directory: string | undefined;
	try {
		directory = await mkdtemp(join(tmpdir(), "tsgw-images-"));
		for (const [index, block] of images.entries()) {
			const inspected = inspectImage(block.data);
			const extension = ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const)[inspected.mimeType];
			const path = join(directory, `${index + 1}.${extension}`);
			const file = await open(path, "wx", 0o600);
			try { await file.writeFile(Buffer.from(inspected.data, "base64")); await file.close(); }
			catch (error) {
				await file.close().catch(() => {});
				await unlink(path).catch(() => {});
				throw error;
			}
			files.push({ path, mimeType: inspected.mimeType, width: inspected.width, height: inspected.height });
		}
		return files;
	} catch {
		if (directory && !files.length) await rm(directory, { recursive: true, force: true }).catch(() => {});
		throw new ImageToolFileError("save-failed", "上游已返回图片，但本地临时文件保存失败；不要重新生成。已保存的文件列于 files。", files);
	}
}
