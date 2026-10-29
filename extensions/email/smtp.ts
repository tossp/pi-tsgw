import { constants, type ReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import nodemailer, { type NodemailerError, type SendMailOptions, type SentMessageInfo, type SMTPPoolOptions } from "nodemailer";
import type { EmailConfig, SmtpConfig } from "./config.ts";
import { EmailError, type MessageRef, type SendInput, type SendResult, type ThreadHeaders } from "./types.ts";

type PoolOptions = SMTPPoolOptions & { pool: true };
type Pool = {
	sendMail(message: SendMailOptions): Promise<SentMessageInfo>;
	close(): void;
};
type TransportFactory = (options: PoolOptions) => Pool;
type Operation = {
	smtp: string;
	pool?: Pool;
	started: boolean;
	stopped: boolean;
	streams: ReadStream[];
	finish(result: SendResult): void;
};

function transportOptions(config: SmtpConfig): PoolOptions {
	return {
		host: config.host, port: config.port,
		secure: config.tls === "implicit",
		requireTLS: config.tls === "starttls",
		ignoreTLS: false,
		tls: { rejectUnauthorized: true },
		auth: { user: config.user, pass: config.password },
		pool: true, maxConnections: 1, maxRequeues: 0,
		connectionTimeout: 15_000, greetingTimeout: 15_000,
		socketTimeout: 60_000, idleTimeout: 60_000,
		debug: false, logger: false,
		disableUrlAccess: true, disableFileAccess: true,
	};
}

function failed(smtp: string, message: string): SendResult {
	return { status: "failed", smtp, message };
}

/** 只使用结构化阶段/响应码判断，绝不回显库错误或服务器原文。 */
function deliveryError(smtp: string, error: unknown): SendResult {
	const detail = error as NodemailerError | null;
	if (detail?.code === "ESTREAM") return failed(smtp, "本地邮件内容读取失败，尚未发送，未自动重试。");
	const code = detail?.responseCode;
	const rejected = typeof code === "number" && code >= 400 && code <= 599;
	const beforeData = ["CONN", "EHLO", "HELO", "STARTTLS", "AUTH", "MAIL FROM", "RCPT TO"]
		.includes(String(detail?.command));
	if (rejected || beforeData || ["EAUTH", "EDNS", "ETLS", "EENVELOPE"].includes(String(detail?.code)))
		return { ...failed(smtp, "邮件发送被拒绝或连接未建立，未自动重试。"), rejected: detail?.rejected };
	return { status: "unknown", smtp, rejected: detail?.rejected, message: "邮件发送结果不明，请核实后再决定是否重发。" };
}

/** 每个出口懒建一个池；只发送本次显式输入，不推导身份或重试。 */
export class EmailSender {
	private readonly pools = new Map<string, Pool>();
	private readonly operations = new Set<Operation>();
	private readonly pending = new Map<string, Promise<void>>();
	private disposed = false;

	constructor(
		private readonly config: EmailConfig,
		private readonly resolveThread: (ref: MessageRef, signal?: AbortSignal) => Promise<ThreadHeaders>,
		private readonly createTransport: TransportFactory = (options) => nodemailer.createTransport(options),
	) {}

	async send(input: SendInput, signal?: AbortSignal): Promise<SendResult> {
		const smtp = input.smtp === undefined ? this.config.defaultSmtp : input.smtp;
		if (this.disposed) return failed(smtp, "邮件发送器已关闭。");
		if (signal?.aborted) return failed(smtp, "邮件发送已取消，尚未发送。");
		if (!Object.hasOwn(this.config.smtp, smtp)) return failed(smtp, "指定的 SMTP 出口不存在。");
		const config = this.config.smtp[smtp];
		const address = input.fromAddress ?? config.fromAddress;
		const name = input.fromName ?? config.fromName;
		if (!config.allowSenderOverride && (address !== config.fromAddress || name !== config.fromName))
			return failed(smtp, "此 SMTP 出口不允许修改发件人地址或名称。");

		return new Promise<SendResult>((resolve) => {
			let release!: () => void;
			const done = new Promise<void>((resolve) => { release = resolve; });
			const operation: Operation = {
				smtp, started: false, stopped: false, streams: [],
				finish: (result) => {
					if (operation.stopped) return;
					operation.stopped = true;
					signal?.removeEventListener("abort", cancel);
					this.operations.delete(operation);
					for (const stream of operation.streams) stream.destroy();
					release();
					resolve(result);
				},
			};
			const cancel = () => {
				if (operation.pool) this.closePool(smtp, operation.pool);
				else this.stop(operation);
			};
			this.operations.add(operation);
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) { cancel(); return; }
			// 每出口串行准备和提交，排队时不打开附件，也不交给库的不可观测队列。
			const previous = this.pending.get(smtp);
			// 取消排队项也须等待前项结束，不能让后项越过仍在途的发送。
			const tail = previous ? previous.then(() => done) : done;
			this.pending.set(smtp, tail);
			void tail.then(() => { if (this.pending.get(smtp) === tail) this.pending.delete(smtp); });
			const execute = () => {
				if (operation.stopped) return;
				void this.execute(operation, input, config, address, name, signal).then(
					(result) => operation.finish(result),
					() => operation.finish(failed(smtp, "邮件准备失败，尚未发送。")),
				);
			};
			if (previous) void previous.then(execute);
			else execute();
		});
	}

	private async execute(
		op: Operation, input: SendInput, config: SmtpConfig, address: string,
		name: string | undefined, signal?: AbortSignal,
	): Promise<SendResult> {
		try {
			let thread: ThreadHeaders | undefined;
			if (input.replyToMessage) {
				try { thread = await this.resolveThread(input.replyToMessage, signal); }
				catch { return failed(op.smtp, "无法读取源邮件线程，尚未发送。"); }
			}
			if (op.stopped) return failed(op.smtp, "邮件发送已取消，尚未发送。");
			const attachments: NonNullable<SendMailOptions["attachments"]> = [];
			for (const attachment of input.attachments ?? []) {
				// 只打开明确的本地普通文件；不给库 path、raw 或 URL 入口。
				if (/^[a-z][a-z0-9+.-]*:/i.test(attachment.path))
					throw new EmailError("attachment", "附件必须是本地普通文件。");
				const file = await open(attachment.path, constants.O_RDONLY | constants.O_NONBLOCK);
				try {
					if (op.stopped || !(await file.stat()).isFile()) {
						await file.close();
						if (op.stopped) return failed(op.smtp, "邮件发送已取消，尚未发送。");
						throw new EmailError("attachment", "附件必须是本地普通文件。");
					}
					if (op.stopped) { await file.close(); return failed(op.smtp, "邮件发送已取消，尚未发送。"); }
					const stream = file.createReadStream();
					// 取消与库挂接监听器之间也不允许未处理的流错误。
					stream.on("error", () => {});
					op.streams.push(stream);
					attachments.push({
						filename: attachment.filename ?? basename(attachment.path),
						contentType: attachment.contentType, content: stream,
					});
				} catch (error) { await file.close().catch(() => {}); throw error; }
			}
			if (op.stopped || this.disposed) return failed(op.smtp, "邮件发送已取消，尚未发送。");
			const message: SendMailOptions = {
				from: { address, name: name ?? "" },
				to: input.to, cc: input.cc, bcc: input.bcc,
				subject: input.subject, text: input.text, html: input.html,
				inReplyTo: thread?.inReplyTo, references: thread?.references,
				envelope: { from: config.envelopeFrom ?? address, to: [...input.to, ...input.cc ?? [], ...input.bcc ?? []] },
				attachments, disableUrlAccess: true, disableFileAccess: true,
			};
			let pool = this.pools.get(op.smtp);
			if (!pool) { pool = this.createTransport(transportOptions(config)); this.pools.set(op.smtp, pool); }
			op.pool = pool;
			if (op.stopped || this.disposed) { this.closePool(op.smtp, pool); return failed(op.smtp, "邮件发送器已关闭。"); }
			op.started = true;
			const info = await pool.sendMail(message);
			const accepted = info.accepted ?? [];
			const rejected = info.rejected ?? [];
			return {
				status: rejected.length ? (accepted.length ? "partial" : "failed") : "success",
				smtp: op.smtp, messageId: info.messageId, accepted, rejected,
			};
		} catch (error) {
			return op.started ? deliveryError(op.smtp, error) : failed(op.smtp, "邮件准备失败，尚未发送。");
		}
	}

	private stop(op: Operation): void {
		op.finish(op.started
			? { status: "unknown", smtp: op.smtp, message: "发送已停止等待，但不能撤回可能已发送的邮件；请核实结果。" }
			: failed(op.smtp, "邮件发送已取消，尚未发送。"));
	}

	private closePool(smtp: string, pool: Pool): void {
		if (this.pools.get(smtp) === pool) this.pools.delete(smtp);
		// close() 禁用池并清空待发队列；库可能让正在发送的连接完成，不能据此宣称撤回。
		try { pool.close(); } catch { /* 清理错误不得泄露库消息。 */ }
		for (const op of this.operations) if (op.smtp === smtp) this.stop(op);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [smtp, pool] of this.pools) this.closePool(smtp, pool);
		for (const op of this.operations) this.stop(op);
	}
}
