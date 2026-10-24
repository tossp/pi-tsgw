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
 * 2026-10-24 K3.1 Pro 国内官方核验：
 * https://platform.kimi.com/docs/guide/kimi-k3-1-pro-quickstart （输入、上下文与最大输出）
 * https://platform.kimi.com/docs/api/models-overview （参数约束与 K3 相同）
 * https://platform.kimi.com/docs/pricing/chat （含动态表格的页面源码）
 * K3.1 Pro 上下文和最大输出均为 1048576，输出默认 131072 不是最大值。
 * 输入/输出/缓存命中/默认 5min 缓存写入为 ¥13/68/1.3/13 每百万词元；
 * 按项目固定 0.1475 USD/CNY 折算，公开估价不代表网关实扣，不使用高速版价格。
 * 缓存 1h 写入 ¥26；当前登记使用默认 5min，不新增 TTL 请求改写。
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
		{
			...k3,
			id: "kimi-k3.1-pro",
			name: "Kimi K3.1 Pro",
			thinkingLevelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
			cost: { input: 1.9175, output: 10.03, cacheRead: 0.19175, cacheWrite: 1.9175 },
			contextWindow: 1048576,
			maxTokens: 1048576,
		},
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
	"kimi-k3.1-pro": (w, c) => applyKimiK3(w, c.thinkingLevel),
	"kimi-k3": (w, c) => applyKimiK3(w, c.thinkingLevel),
	"kimi-k3-256k": (w, c) => applyKimiK3(w, c.thinkingLevel),
};
