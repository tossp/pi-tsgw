import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORY_RULES } from "../prompts/memory.ts";

export function registerPrompts(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions) {
			event.systemPromptOptions.sections.tsgw_memory = MEMORY_RULES;
			return;
		}
		// 保留已声明支持的旧宿主提示词接口。
		return { systemPrompt: `${event.systemPrompt}\n\n${MEMORY_RULES}` };
	});
}
