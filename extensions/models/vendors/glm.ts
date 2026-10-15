import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isMaximum, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 智谱 AI（Zhipu）GLM 系列。
 * 国内官方依据：
 * https://docs.bigmodel.cn/cn/guide/capabilities/thinking （effort 仅 5.2+）
 * https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode （保留式思考）
 * 2026-10-16 5.3 / Flash / FlashX：始终思考，仅 low/high/max。
 * https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
 * https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
 * https://docs.bigmodel.cn/cn/guide/start/pricing
 * 国内 CNY/百万 tokens 按既有固定 0.1475 USD/CNY 估算（非实时汇率）；
 * 三型号输入/输出/缓存命中为 8/28/2、0.8/2.8/0.23、2/7/0.57，
 * 缓存存储限时免费。1M 上下文与 128K 最大输出分别登记。
 */
export function glmModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		...glm53Models(v1),
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
			id: "glm-4.5-air",
			name: "GLM-4.5-Air",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: { input: 0.2, output: 1.1, cacheRead: 0.03, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 98304,
			compat: OPENAI_COMPLETIONS_COMPAT,
		},
	];
}

/** 5.3 三型号只有模态和价格不同；具体契约由各自官方模型页确认。 */
function glm53Models(baseUrl: string): ProviderModelConfig[] {
	const variants: Pick<ProviderModelConfig, "id" | "name" | "input" | "cost">[] = [
		{ id: "glm-5.3", name: "GLM 5.3", input: ["text"],
			cost: { input: 1.18, output: 4.13, cacheRead: 0.295, cacheWrite: 0 } },
		{ id: "glm-5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"],
			cost: { input: 0.118, output: 0.413, cacheRead: 0.033925, cacheWrite: 0 } },
		{ id: "glm-5.3-flashx", name: "GLM 5.3 FlashX", input: ["text", "image"],
			cost: { input: 0.295, output: 1.0325, cacheRead: 0.084075, cacheWrite: 0 } },
	];
	return variants.map((model) => ({
		...model,
		api: "openai-completions",
		baseUrl,
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
		contextWindow: 1000000,
		maxTokens: 131072,
		compat: OPENAI_COMPLETIONS_COMPAT,
	} satisfies ProviderModelConfig));
}

function applyGlm53(writer: PayloadWriter, level: ThinkingLevel): void {
	if (writer.get("stream") === true) writer.set("tool_stream", true);
	writer.setThinking({ type: "enabled" });
	if (level === "high" || isMaximum(level)) writer.setThinking({ clear_thinking: false });
	writer.set("reasoning_effort", isMaximum(level) ? "max" : level === "medium" || level === "high" ? "high" : "low");
}

// GLM 思维链：`tool_stream=true` 仅在流式请求时附加；高级档位加 `clear_thinking=false`。
function applyGlm(writer: PayloadWriter, level: ThinkingLevel, effort = true, preserve = true): void {
	if (!effort) writer.remove("reasoning_effort");
	if (writer.get("stream") === true) writer.set("tool_stream", true);
	if (level === "off") {
		writer.setThinking({ type: "disabled" });
		if (effort) writer.set("reasoning_effort", "none");
		return;
	}

	writer.setThinking({ type: "enabled" });
	if (level === "high" || isMaximum(level)) {
		if (preserve) writer.setThinking({ clear_thinking: false });
		if (effort) writer.set("reasoning_effort", isMaximum(level) ? "max" : "high");
	}
}

export const glmThinking: Record<string, ThinkingApplier> = {
	"glm-5.3": (w, c) => applyGlm53(w, c.thinkingLevel),
	"glm-5.3-flash": (w, c) => applyGlm53(w, c.thinkingLevel),
	"glm-5.3-flashx": (w, c) => applyGlm53(w, c.thinkingLevel),
	"glm-5.2": (w, c) => applyGlm(w, c.thinkingLevel),
	"glm-4.5-air": (w, c) => applyGlm(w, c.thinkingLevel, false, false),
};
