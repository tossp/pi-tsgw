import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 月之暗面（Moonshot）Kimi K3 系列。
 * 官方文档：https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
 * 思考档位：https://platform.kimi.ai/docs/guide/use-reasoning-effort
 * kimi-k3-256k 是网关变体：按已确认约定将上下文限制为 256 * 1024，
 * 其余元数据/价格估算沿用 K3，不代表该变体已逐项通过端点验证。
 * maxTokens 保留既有 131072，并非把 256K 上下文当成最大输出。
 */
export function kimiModels(root: string): ProviderModelConfig[] {
	const k3: ProviderModelConfig = {
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-completions",
		baseUrl: `${root}/v1`,
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 2, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 131072,
		compat: OPENAI_COMPLETIONS_COMPAT,
	};
	return [
		k3,
		{
			...k3,
			id: "kimi-k3-256k",
			name: "Kimi K3 (256K)",
			contextWindow: 262144,
		},
	];
}

// Kimi K3 思维链：移除 `thinking` 字段，改用 `reasoning_effort` 表达深度。
function applyKimiK3(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("thinking");
	// K3 始终思考，省略思考深度设置时默认为 max；直接或迟到的 off 请求降至 low。
	if (level === "off" || level === "minimal" || level === "low") {
		writer.set("reasoning_effort", "low");
		return;
	}
	writer.set("reasoning_effort", level === "max" ? "max" : "high");
}

export const kimiThinking: Record<string, ThinkingApplier> = {
	"kimi-k3": (w, c) => applyKimiK3(w, c.thinkingLevel),
	"kimi-k3-256k": (w, c) => applyKimiK3(w, c.thinkingLevel),
};
