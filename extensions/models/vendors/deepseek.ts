import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";

// DeepSeek Responses 将 developer 角色当作 user，且不支持 OpenAI 的
// prompt_cache_retention；其余 reasoning 字段交给 Pi 的 Responses 适配器。
const DEEPSEEK_RESPONSES_COMPAT = {
	supportsDeveloperRole: false,
	supportsLongCacheRetention: false,
};

/**
 * DeepSeek（深度求索）系列：V4.1 Flash 与 V4 Pro。
 * 协议文档：https://api-docs.deepseek.com/guides/responses_api
 * 定价依据（2026-10-16）：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 国内高峰价（元/百万词元）：Flash 输入/输出/命中 2/8/0.04，Pro 9/27/0.30。
 * 按项目固定 0.1475 USD/CNY 折算；静态 cost 用高峰价保守估算，不按请求时间切换。
 * 空闲时段为半价；高峰为北京时间工作日（不含中国法定节假日）9–12、14–18。
 * cacheWrite=0 表示官方未单列附加缓存写入费用；非网关实际计费。
 */
export function deepseekModels(root: string): ProviderModelConfig[] {
	const v1 = `${root}/v1`;
	return [
		{
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0.295, output: 1.18, cacheRead: 0.0059, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_RESPONSES_COMPAT,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			input: ["text"],
			cost: {
				input: 1.3275,
				output: 3.9825,
				cacheRead: 0.04425,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: DEEPSEEK_RESPONSES_COMPAT,
			thinkingLevelMap: {
				off: "none",
				minimal: "low",
				low: "low",
				medium: "high",
				high: "high",
				xhigh: "high",
				max: "max",
			},
		},
	];
}
