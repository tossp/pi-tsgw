import { Buffer } from "node:buffer";

export const EMAIL_CACHE_MAX_BYTES = 128 * 1024 * 1024;
export const EMAIL_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
export const EMAIL_CACHE_STATE_TTL_MS = 30_000;
export const EMAIL_CACHE_CONTENT_TTL_MS = 10 * 60_000;
export const EMAIL_CACHE_SWEEP_MS = 60_000;

export type EmailCacheValue = string | Buffer;
export type EmailCacheKind = "state" | "content";

interface Entry {
	value: EmailCacheValue;
	bytes: number;
	expiresAt: number;
}

/** 单个邮件会话持有；不落盘、不共享，也不在模块加载时启动计时器。 */
export class EmailCache {
	private readonly entries = new Map<string, Entry>();
	private readonly maxBytes: number;
	private readonly maxEntryBytes: number;
	private timer: ReturnType<typeof setInterval> | undefined;
	private usedBytes = 0;

	constructor(options: { maxBytes?: number; maxEntryBytes?: number } = {}) {
		this.maxBytes = options.maxBytes ?? EMAIL_CACHE_MAX_BYTES;
		this.maxEntryBytes = options.maxEntryBytes ?? EMAIL_CACHE_MAX_ENTRY_BYTES;
		this.timer = setInterval(() => this.sweepExpired(), EMAIL_CACHE_SWEEP_MS);
		this.timer.unref();
	}

	get size(): number { return this.entries.size; }
	get bytes(): number { return this.usedBytes; }

	get(key: string): EmailCacheValue | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.delete(key);
			return undefined;
		}
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	set(key: string, value: EmailCacheValue, kind: EmailCacheKind = "content"): boolean {
		if (!this.timer) return false;
		this.delete(key);
		const valueBytes = typeof value === "string" ? value.length * 2 : value.byteLength;
		// 字符串按 UTF-16 计费，另计键与条目开销；这是容量估算，不是进程堆内存硬限额。
		const bytes = valueBytes + key.length * 2 + 128;
		if (valueBytes > this.maxEntryBytes || bytes > this.maxBytes) return false;
		const now = Date.now();
		if (this.usedBytes + bytes > this.maxBytes) this.sweepExpired(now);
		while (this.usedBytes + bytes > this.maxBytes) {
			this.delete(this.entries.keys().next().value!);
		}
		this.entries.set(key, {
			// 不让小切片把调用方的大缓冲区一直保留在缓存里。
			value: typeof value === "string" ? value : Buffer.from(value),
			bytes,
			expiresAt: now + (kind === "state" ? EMAIL_CACHE_STATE_TTL_MS : EMAIL_CACHE_CONTENT_TTL_MS),
		});
		this.usedBytes += bytes;
		return true;
	}

	delete(key: string): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;
		this.entries.delete(key);
		this.usedBytes -= entry.bytes;
		return true;
	}

	clear(): void {
		this.entries.clear();
		this.usedBytes = 0;
	}

	dispose(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.clear();
	}

	private sweepExpired(now = Date.now()): void {
		for (const [key, entry] of this.entries) {
			if (entry.expiresAt <= now) this.delete(key);
		}
	}
}
