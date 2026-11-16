import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 月之暗面（Moonshot）Kimi K3 与 K2.8。
 * Kimi Code 模型 ID 与思考档位（2026-11-16）：
 * https://www.kimi.com/code/docs/kimi-code/models.html
 * kimi-for-coding 对应 K2.8 Preview，支持 low/high/max；关闭思考仍为 K2.8。
 * K2.8 的 1M 上下文、32768 最大输出取自本次网关目录；宿主仅登记文字和图片输入。
 * 官方未公开该 Code 型号的独立词元价格，cost=0 表示未知，不代表免费。
 * K3 系列本次只适配 Code 模型 ID，保留既有规格和思考策略。
 * 官方文档：https://platform.kimi.ai/docs/guide/kimi-k3-quickstart
 * 思考档位：https://platform.kimi.ai/docs/guide/use-reasoning-effort
 * k3-256k 上下文按 Code 官方规格限制为 256 * 1024，
 * 其余元数据/价格估算保留既有 K3 登记，不代表该变体已逐项通过端点验证。
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
		id: "k3",
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
			id: "k3.1-pro",
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
			id: "k3-256k",
			name: "Kimi K3 (256K)",
			contextWindow: 262144,
		},
		{
			...k3,
			id: "kimi-for-coding",
			name: "Kimi K2.8 Preview",
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1048576,
			maxTokens: 32768,
		},
	];
}

// Code 模型使用 reasoning_effort；K3 保留 off 降至 low，避免路由到另一型号。
function applyKimiEffort(writer: PayloadWriter, level: ThinkingLevel, offEffort: "low" | "none" = "low"): void {
	writer.remove("thinking");
	if (level === "off") {
		writer.set("reasoning_effort", offEffort);
		return;
	}
	if (level === "minimal" || level === "low") {
		writer.set("reasoning_effort", "low");
		return;
	}
	writer.set("reasoning_effort", level === "max" ? "max" : "high");
}

export const kimiThinking: Record<string, ThinkingApplier> = {
	"k3.1-pro": (w, c) => applyKimiEffort(w, c.thinkingLevel),
	k3: (w, c) => applyKimiEffort(w, c.thinkingLevel),
	"k3-256k": (w, c) => applyKimiEffort(w, c.thinkingLevel),
	"kimi-for-coding": (w, c) => applyKimiEffort(w, c.thinkingLevel, "none"),
};
