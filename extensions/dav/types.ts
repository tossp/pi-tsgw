import type { DavClient } from "davkit/dav";

/** 仅在业务调用通过配置与环境检查后构造，不记录凭据。 */
export interface DavReadContext {
	client: DavClient;
	ical: typeof import("davkit/ical");
	vcard: typeof import("davkit/vcard");
	timeZone?: string;
}

export class DavToolError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

export interface CalendarListInput {
	account: string;
	collectionUrl: string;
	uid?: string;
	start?: string;
	end?: string;
	timeZone?: string;
	status?: string;
}

export interface CalendarGetInput {
	account: string;
	resourceUrl: string;
	uid: string;
	recurrenceId?: string;
	raw?: boolean;
}

export interface ContactListInput { account: string; collectionUrl: string }
export interface ContactGetInput { account: string; resourceUrl: string; uid?: string; raw?: boolean }
