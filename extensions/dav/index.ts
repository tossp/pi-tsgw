import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDavTools } from "./tools.ts";

export function supportsDavTools(version: string): boolean {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/.exec(version);
	return !!match && (Number(match[1]) > 1 || (Number(match[1]) === 1 && Number(match[2]) >= 2));
}

/** 只注册宿主工具，不读配置、加载可选库或联网。 */
export function registerDav(pi: ExtensionAPI, options: { agentDir?: string; version?: string; fetch?: typeof globalThis.fetch } = {}): void {
	if (!supportsDavTools(options.version ?? VERSION)) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("DAV 工具需要已验证的 Pi 1.2+ codemode 能力；其他插件功能不受影响。", "warning");
		});
		return;
	}
	registerDavTools(pi, options);
}
