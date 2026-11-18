import type { ChatModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";

/**
 * 腾讯混元 Hy4 Flash，2026-11-18 核对国内 TokenHub 文档。
 * 规格与 Chat Completions 示例：https://cloud.tencent.com/document/product/1823/132252
 * 思考档位：https://cloud.tencent.com/document/product/1823/131208
 * 官网标准输入、输出、缓存命中价为 0.5、2、0.02 元／百万词元，按 0.1475 USD/CNY 折算。
 * https://cloud.tencent.com/product/tokenhub
 */
export function hunyuanModels(root: string): ChatModelConfig[] {
	return [{
		id: "hy4-flash",
		name: "Hy4 Flash",
		api: "openai-completions",
		baseUrl: `${root}/v1`,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.07375, output: 0.295, cacheRead: 0.00295, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 65536,
		compat: { ...OPENAI_COMPLETIONS_COMPAT, maxTokensField: "max_tokens", supportsReasoningEffort: true },
		thinkingLevelMap: { off: "no_think", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	}];
}
