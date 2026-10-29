import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readEmailConfig } from "./config.ts";

/** 邮件依赖宿主 codemode 暴露契约；1.2 为已核验基线，不提高整个插件的 peer 要求。 */
export function supportsEmailTools(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
	return !!match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 2));
}

export async function registerEmail(pi: ExtensionAPI, options: { agentDir?: string; version?: string } = {}): Promise<void> {
	const loaded = readEmailConfig(options.agentDir);
	if (loaded.status === "disabled") return;
	const error = loaded.status === "invalid" ? loaded.message
		: !supportsEmailTools(options.version ?? VERSION) ? "邮件功能需要已验证的 Pi 1.2+ codemode 能力；其他插件功能不受影响。" : undefined;
	if (error) {
		pi.on("session_start", (_event, ctx) => { ctx.ui.notify(error, "warning"); });
		return;
	}
	if (loaded.status === "ready") {
		const { registerEmailTools } = await import("./tools.ts");
		registerEmailTools(pi, loaded.config);
	}
}
