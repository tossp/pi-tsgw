import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { EmailConfig } from "./config.ts";
import { EmailError } from "./types.ts";

const IDLE_MS = 3 * 60_000;
interface Connection {
	client?: ImapFlow;
	queue: Promise<unknown>;
	timer?: ReturnType<typeof setTimeout>;
}

/** 一个邮件会话持有；同账户排队，不同账户独立，失败不在本次调用中重试。 */
export class ImapSessions {
	private readonly connections = new Map<string, Connection>();
	private closed = false;

	constructor(
		private readonly config: EmailConfig,
		private readonly createClient: (options: ImapFlowOptions) => ImapFlow = options => new ImapFlow(options),
	) {}

	run<T>(account: string, mailbox: string | undefined, signal: AbortSignal | undefined, action: (client: ImapFlow) => Promise<T>): Promise<T> {
		if (!Object.hasOwn(this.config.imap, account))
			return Promise.reject(new EmailError("ACCOUNT_MISSING", "未配置指定的 IMAP 账户。"));
		if (this.closed) return Promise.reject(new EmailError("SESSION_CLOSED", "邮件会话已经关闭。"));
		let connection = this.connections.get(account);
		if (!connection) {
			connection = { queue: Promise.resolve() };
			this.connections.set(account, connection);
		}
		const current = connection;
		const task = current.queue.then(async () => {
			if (this.closed) throw new EmailError("SESSION_CLOSED", "邮件会话已经关闭。");
			signal?.throwIfAborted();
			clearTimeout(current.timer);
			const settings = this.config.imap[account]!;
			let client = current.client;
			if (!client?.usable) {
				client?.close();
				client = this.createClient({
					host: settings.host, port: settings.port, secure: settings.tls === "implicit",
					doSTARTTLS: settings.tls === "starttls", tls: { rejectUnauthorized: true },
					auth: { user: settings.user, pass: settings.password },
					logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true,
					connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000,
				});
				// 错误由正在执行的请求返回；不将服务端响应或凭据写入普通日志。
				client.on("error", () => {});
				current.client = client;
			}
			const active = client;
			const abort = () => active.close();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				if (!active.usable) await active.connect();
				signal?.throwIfAborted();
				if (!mailbox) return await action(active);
				const lock = await active.getMailboxLock(mailbox);
				try {
					signal?.throwIfAborted();
					return await action(active);
				} finally { lock.release(); }
			} finally {
				signal?.removeEventListener("abort", abort);
				if (!this.closed) {
					current.timer = setTimeout(() => {
						current.client?.close();
						current.client = undefined;
					}, IDLE_MS);
					current.timer.unref();
				}
			}
		});
		current.queue = task.then(() => undefined, () => undefined);
		return task;
	}

	dispose(): void {
		this.closed = true;
		for (const connection of this.connections.values()) {
			clearTimeout(connection.timer);
			connection.client?.close();
		}
		this.connections.clear();
	}
}
