import type { ChatModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";

/**
 * 腾讯混元 Hy4 与 Hy4 Flash，2026-11-20 核对国内 TokenHub 文档。
 * 模型规格：https://cloud.tencent.com/document/product/1823/130051
 * Chat Completions 示例与思考档位：https://cloud.tencent.com/document/product/1823/131208
 * 标准输入、输出、缓存命中价每百万词元分别为 Hy4 的 6、18、0.3 元和
 * Hy4 Flash 的 0.5、2、0.02 元，按 0.1475 USD/CNY 折算。
 * https://cloud.tencent.com/product/tokenhub
 */
export function hunyuanModels(root: string): ChatModelConfig[] {
	return [
		{ id: "hy4-flash", name: "Hy4 Flash", cost: { input: 0.07375, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 } },
		{ id: "hy4", name: "Hy4", cost: { input: 0.885, output: 2.655, cacheRead: 0.04425, cacheWrite: 0 } },
	].map<ChatModelConfig>(model => ({
		...model,
		api: "openai-completions",
		baseUrl: `${root}/v1`,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 65536,
		compat: { ...OPENAI_COMPLETIONS_COMPAT, maxTokensField: "max_tokens", supportsReasoningEffort: true },
		thinkingLevelMap: { off: "no_think", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	}));
}
