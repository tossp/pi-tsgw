import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isMaximum, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 智谱 AI（Zhipu）GLM 系列。
 * 官方文档：https://open.bigmodel.cn/（国际站 docs.z.ai）
 */
export function glmModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "glm-5.2",
			name: "GLM 5.2",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text"],
			cost: { input: 1.18, output: 4.13, cacheRead: 0.295, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
		{
			id: "glm-5.1",
			name: "GLM 5.1",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.885, output: 3.54, cacheRead: 0.19175, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 65536,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// GLM 思维链：`tool_stream=true` 仅在流式请求时附加；高级档位加 `clear_thinking=false`。
function applyGlm(writer: PayloadWriter, level: ThinkingLevel): void {
	if (writer.get("stream") === true) writer.set("tool_stream", true);
	if (level === "off") {
		writer.setThinking({ type: "disabled" });
		writer.set("reasoning_effort", "none");
		return;
	}

	writer.setThinking({ type: "enabled" });
	if (level === "high" || isMaximum(level)) {
		writer.setThinking({ clear_thinking: false });
		writer.set("reasoning_effort", isMaximum(level) ? "max" : "high");
	}
}

export const glmThinking: Record<string, ThinkingApplier> = {
	"glm-5.2": (w, c) => applyGlm(w, c.thinkingLevel),
	"glm-5.1": (w, c) => applyGlm(w, c.thinkingLevel),
};
