import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMORY_RULES } from "#tsgw-prompts/memory";

export function registerPrompts(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions) {
			event.systemPromptOptions.sections.tsgw_memory = MEMORY_RULES;
		}
		// 读取注入分区后的完整提示词，避免 customPrompt 跳过宿主默认分区。
		const prompt = event.systemPromptOptions
			? event.systemPrompt
			: `${event.systemPrompt}\n\n${MEMORY_RULES}`;
		const opening = "You are a coding assistant running inside pi, a coding agent harness.";
		if (prompt.startsWith(opening)) {
			return { systemPrompt: `You are an AI agent.${prompt.slice(opening.length)}` };
		}
		// 保留已声明支持的旧宿主提示词接口。
		if (!event.systemPromptOptions) return { systemPrompt: prompt };
	});
}
