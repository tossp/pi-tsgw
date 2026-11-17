import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { ANTHROPIC_COMPAT, OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isMaximum, isPlainObject, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 智谱 AI（Zhipu）GLM 系列。
 * 国内官方依据：
 * https://docs.bigmodel.cn/cn/guide/capabilities/thinking （思考深度设置仅支持 5.2+）
 * https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode （保留式思考）
 * 2026-10-16 5.3 / Flash / FlashX：始终思考，仅 low/high/max。
 * https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
 * https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash
 * https://docs.bigmodel.cn/cn/guide/start/pricing
 * 国内 CNY/百万词元按既有固定 0.1475 USD/CNY 估算（非实时汇率）；
 * 三型号输入/输出/缓存命中为 8/28/2、0.8/2.8/0.23、2/7/0.57，
 * 缓存存储限时免费。1M 上下文与 128K 最大输出分别登记。
 */
export function glmModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		...glm53Models(root),
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

/** Flash 使用 Coding Plan 的 Anthropic 兼容入口，另外两款保持 Chat Completions。 */
function glm53Models(root: string): ProviderModelConfig[] {
	const variants: Pick<ProviderModelConfig, "id" | "name" | "input" | "cost">[] = [
		{ id: "glm-5.3", name: "GLM 5.3", input: ["text"],
			cost: { input: 1.18, output: 4.13, cacheRead: 0.295, cacheWrite: 0 } },
		{ id: "glm-5.3-flash", name: "GLM 5.3 Flash", input: ["text", "image"],
			cost: { input: 0.118, output: 0.413, cacheRead: 0.033925, cacheWrite: 0 } },
		{ id: "glm-5.3-flashx", name: "GLM 5.3 FlashX", input: ["text", "image"],
			cost: { input: 0.295, output: 1.0325, cacheRead: 0.084075, cacheWrite: 0 } },
	];
	return variants.map((model) => {
		const anthropic = model.id === "glm-5.3-flash";
		return {
			...model,
			api: anthropic ? "anthropic-messages" : "openai-completions",
			baseUrl: anthropic ? root : `${root}/v1`,
			reasoning: true,
			thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
			contextWindow: 1000000,
			maxTokens: 131072,
			compat: anthropic ? { ...ANTHROPIC_COMPAT, allowEmptySignature: true } : OPENAI_COMPLETIONS_COMPAT,
		} satisfies ProviderModelConfig;
	});
}

function applyGlm53(writer: PayloadWriter, level: ThinkingLevel): void {
	if (writer.get("stream") === true) writer.set("tool_stream", true);
	writer.setThinking({ type: "enabled" });
	if (level === "high" || isMaximum(level)) writer.setThinking({ clear_thinking: false });
	writer.set("reasoning_effort", glm53Effort(level));
}

// Coding Plan 的 Claude Code 契约：adaptive + output_config.effort；不套用 Chat 扩展。
// https://docs.bigmodel.cn/cn/coding-plan/latest-model
// 兼容服务的无签名思考块交给宿主保留，避免工具续轮时降为普通文本。
function applyGlm53Flash(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.remove("tool_stream");
	writer.setThinking({ type: "adaptive" });
	const current = writer.get("output_config");
	const output = isPlainObject(current) ? current : {};
	const effort = glm53Effort(level);
	if (output.effort !== effort) writer.set("output_config", { ...output, effort });
}

function glm53Effort(level: ThinkingLevel): "low" | "high" | "max" {
	if (isMaximum(level)) return "max";
	if (level === "medium" || level === "high") return "high";
	return "low";
}

// GLM Chat 思维链：`tool_stream=true` 仅在流式请求时附加；高级档位加 `clear_thinking=false`。
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
	"glm-5.3-flash": (w, c) => applyGlm53Flash(w, c.thinkingLevel),
	"glm-5.3-flashx": (w, c) => applyGlm53(w, c.thinkingLevel),
	"glm-5.2": (w, c) => applyGlm(w, c.thinkingLevel),
	"glm-4.5-air": (w, c) => applyGlm(w, c.thinkingLevel, false, false),
};
