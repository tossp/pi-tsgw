import { VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { supportsClassifierModels, supportsImageModels } from "#tsgw/models/capabilities";
import { registerAgentInstallCommand } from "#tsgw/agents/command";
import { registerPrompts } from "#tsgw/prompts";
import { registerEmail } from "#tsgw/email/index";
import { readTsgwSettings } from "#tsgw/provider/config";
import { registerTsgwProvider } from "#tsgw/provider/index";
import { registerUploadTool } from "#tsgw/upload/index";

/** 插件总入口：保持能力注册顺序，实现由各模块维护。 */
export default async function registerTsgw(pi: ExtensionAPI): Promise<void> {
	registerUploadTool(pi);
	registerAgentInstallCommand(pi);
	await registerEmail(pi);
	if (supportsImageModels(VERSION)) {
		const { registerImageTools } = await import("#tsgw/images/tools");
		registerImageTools(pi);
	}
	if (supportsClassifierModels(VERSION)) {
		const { registerDelegation } = await import("#tsgw/delegation/index");
		registerDelegation(pi);
	}
	registerPrompts(pi);
	const settings = readTsgwSettings();
	await registerTsgwProvider(pi, settings);
}
