import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { ANTHROPIC_COMPAT } from "./_protocols.ts";
import { isPlainObject, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * MiniMax 系列。
 * 国内官方依据：
 * https://platform.minimaxi.com/docs/api-reference/text-chat （输出上限）
 * 2026-10-20 正式版 M3.1 核验（不能关闭思考，支持五档思考深度）：
 * https://platform.minimax.cn/docs/guides/text-generation
 * https://platform.minimax.cn/docs/api-reference/text-openai-api
 * 2026-10-26：MiniMax 全系列改用官方推荐的 Anthropic Messages。
 * M3 可关闭思考，M3.1-Flash 强制开启且使用 output_config.effort；
 * 工具多轮须原样回传 thinking 内容块。
 * https://platform.minimax.cn/docs/api-reference/text-anthropic-api
 * https://platform.minimax.cn/docs/api-reference/text-chat （最大输出 524288）
 * https://platform.minimax.cn/docs/pricing/overview （正式版输入/输出/缓存读取 ¥1/4/0.1 每百万词元）
 * 按项目固定 0.1475 USD/CNY 折算，公开估价不代表网关实扣；未列缓存写入价用零占位。
 * 2026-10-24 网关目录已无 M3.1-Flash-Preview，按约定移除该预览版登记、
 * 未知零价占位与思考策略；正式版规格不因此变化。
 */
export function minimaxModels(root: string): ProviderModelConfig[] {
	const anthropic = `${root}/anthropic`;
	// MiniMax 不要求 Claude 签名，复用宿主以保留空签名 thinking 块。
	const compat = { ...ANTHROPIC_COMPAT, allowEmptySignature: true };
	return [
		{
			id: "MiniMax-M3.1-Flash",
			name: "MiniMax-M3.1-Flash",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: "low",
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 0.1475, output: 0.59, cacheRead: 0.01475, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 524288,
			compat,
		},
		{
			id: "MiniMax-M3",
			name: "MiniMax-M3",
			api: "anthropic-messages",
			baseUrl: anthropic,
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0.30975,
				output: 1.239,
				cacheRead: 0.06195,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 524288,
			compat,
		},
	];
}

// M3 仅有 disabled/adaptive 开关，不发送仅 M3.1 支持的 effort。
function applyMiniMax(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_effort");
	writer.remove("reasoning_split");
	writer.setThinking({ type: level === "off" ? "disabled" : "adaptive" });
	const current = writer.get("output_config");
	if (isPlainObject(current) && Object.hasOwn(current, "effort")) {
		const output = { ...current };
		delete output.effort;
		if (Object.keys(output).length) writer.set("output_config", output);
		else writer.remove("output_config");
	}
}

function applyMiniMax31(writer: PayloadWriter, level: ThinkingLevel): void {
	writer.remove("reasoning_split");
	writer.remove("reasoning_effort");
	writer.setThinking({ type: "adaptive" });
	// 过期的 off/minimal 快照不得关闭思考，也不得回退到默认 max。
	const effort = level === "off" || level === "minimal" ? "low" : level;
	const current = writer.get("output_config");
	const output = isPlainObject(current) ? current : {};
	if (output.effort !== effort) writer.set("output_config", { ...output, effort });
}

export const minimaxThinking = {
	"MiniMax-M3.1-Flash": (w, c) => applyMiniMax31(w, c.thinkingLevel),
	"MiniMax-M3": (w, c) => applyMiniMax(w, c.thinkingLevel),
} satisfies Record<string, ThinkingApplier>;
