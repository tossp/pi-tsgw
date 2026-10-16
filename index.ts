import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTsgwMcp } from "./extensions/mcp.ts";
import { registerPrompts } from "./extensions/prompts.ts";
import { readTsgwSettings } from "./extensions/provider/config.ts";
import { registerTsgwProvider } from "./extensions/provider/index.ts";
import { registerUploadTool } from "./extensions/upload/index.ts";

/** 插件总入口：保持能力注册顺序，实现由各模块维护。 */
export default async function registerTsgw(pi: ExtensionAPI): Promise<void> {
	registerUploadTool(pi);
	registerPrompts(pi);
	const settings = readTsgwSettings();
	registerTsgwMcp(pi, settings.mcpUrl);
	await registerTsgwProvider(pi, settings);
}
