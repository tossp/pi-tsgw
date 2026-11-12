import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "#tsgw/models/catalog";

/** 会话身份取自宿主；用户消息入库后才确定消息级追踪身份。 */
export function registerGatewayTracing(pi: ExtensionAPI, root: string): void {
	let active = false;
	let chatting = false;
	let customRunUserId: string | undefined;

	pi.on("before_agent_start", (event, ctx) => {
		// 独立自定义任务不冒用上一条用户消息；附加上下文则不改变归属。
		customRunUserId = event.messageType === "custom"
			? latestUserEntryId(ctx.sessionManager) : undefined;
	});

	pi.on("session_start", () => { active = true; chatting = false; });
	pi.on("session_shutdown", () => { active = false; chatting = false; });
	pi.on("agent_start", () => { chatting = true; });
	pi.on("turn_start", () => { chatting = true; });
	pi.on("agent_end", () => { chatting = false; });
	// 压缩、分支摘要不是最近一条用户消息的普通续答；只关联会话。
	pi.on("session_before_compact", () => { chatting = false; });
	pi.on("session_before_tree", () => { chatting = false; });

	pi.on("before_provider_headers", (event, ctx) => {
		if (!active || !matchesGateway(ctx.model, root)) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		setMissingHeader(event.headers, "AH-Thread-Id", sessionId);
		setMissingHeader(event.headers, "X-Magpie-Session", sessionId);
		if (!chatting) return;
		const entryId = latestUserEntryId(ctx.sessionManager);
		if (entryId && entryId !== customRunUserId)
			setMissingHeader(event.headers, "AH-Trace-Id", `${sessionId}.${entryId}`);
	});
}

function matchesGateway(
	model: ExtensionContext["model"], root: string,
): boolean {
	if (model?.provider !== PROVIDER_ID) return false;
	try {
		const url = new URL(model.baseUrl);
		const target = new URL(root);
		const rootPath = target.pathname.replace(/\/$/, "");
		return url.origin === target.origin &&
			(url.pathname === rootPath || url.pathname.startsWith(`${rootPath}/`));
	} catch {
		return false;
	}
}

function latestUserEntryId(manager: ExtensionContext["sessionManager"]): string | undefined {
	let entry = manager.getLeafEntry();
	while (entry) {
		if (entry.type === "message" && entry.message.role === "user") return entry.id;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined;
	}
	return undefined;
}

function setMissingHeader(
	headers: Record<string, string | null>, name: string, value: string,
): void {
	if (!Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase()))
		headers[name] = value;
}
