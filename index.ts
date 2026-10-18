import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { supportsImageModels } from "#tsgw/models/capabilities";
import { registerPrompts } from "#tsgw/prompts";
import { readTsgwSettings } from "#tsgw/provider/config";
import { registerTsgwProvider } from "#tsgw/provider/index";
import { registerUploadTool } from "#tsgw/upload/index";

/** 插件总入口：保持能力注册顺序，实现由各模块维护。 */
export default async function registerTsgw(pi: ExtensionAPI): Promise<void> {
	registerUploadTool(pi);
	if (supportsImageModels(VERSION)) {
		const { registerImageTools } = await import("#tsgw/images/tools");
		registerImageTools(pi);
	}
	registerPrompts(pi);
	const settings = readTsgwSettings();
	await registerTsgwProvider(pi, settings);
}
