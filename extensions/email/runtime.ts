import type { EmailConfig } from "./config.ts";
import { EmailCache } from "./cache.ts";
import { ImapSessions } from "./imap-session.ts";
import { EmailReader } from "./reader.ts";
import { EmailSender } from "./smtp.ts";

/** 延迟到实际邮件操作才创建；仅当前宿主会话持有这一份状态。 */
export class EmailRuntime {
	readonly cache = new EmailCache();
	readonly sessions: ImapSessions;
	readonly reader: EmailReader;
	readonly sender: EmailSender;

	constructor(config: EmailConfig) {
		this.sessions = new ImapSessions(config);
		this.reader = new EmailReader(this.sessions, this.cache);
		this.sender = new EmailSender(config, (ref, signal) => this.reader.thread(ref, signal));
	}

	dispose(): void {
		this.sender.dispose();
		this.sessions.dispose();
		this.cache.dispose();
	}
}
