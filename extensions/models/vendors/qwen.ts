import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isAtLeastHigh, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 阿里云通义（Alibaba Qwen）系列。
 * 当前仅保留 qwen3.7-plus 及策略作为厂商接入参考；实际登记仍须命中网关目录。
 * 官方文档：https://help.aliyun.com/zh/model-studio/
 */
export function qwenModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "qwen3.7-plus",
			name: "Qwen3.7 Plus",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.295,
				output: 1.18,
				cacheRead: 0.059,
				cacheWrite: 0.36875,
			},
			contextWindow: 1000000,
			maxTokens: 64000,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

// Qwen 思维链：`enable_thinking`/`preserve_thinking`，高级档位加预算与搜索/解释器。
function applyQwen(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.set("enable_search", true);
	writer.set("parallel_tool_calls", true);
	if (level === "off") {
		writer.set("enable_thinking", false);
		writer.set("preserve_thinking", false);
		writer.remove("thinking_budget");
		writer.remove("search_options");
		writer.remove("enable_code_interpreter");
		return;
	}

	writer.set("enable_thinking", true);
	writer.set("preserve_thinking", true);
	if (isAtLeastHigh(level)) {
		writer.set("thinking_budget", 6000);
		writer.set("search_options", { search_strategy: "agent_max" });
		writer.set("enable_code_interpreter", true);
		return;
	}
	writer.remove("thinking_budget");
	writer.remove("search_options");
	writer.remove("enable_code_interpreter");
}

export const qwenThinking: Record<string, ThinkingApplier> = {
	"qwen3.7-plus": (w, c) => applyQwen(w, c.thinkingLevel),
};
