import type { ChatModelConfig as ProviderModelConfig } from "../_tools.ts";
import { OPENAI_COMPLETIONS_COMPAT } from "./_protocols.ts";
import { isAtLeastHigh, type PayloadWriter, type ThinkingApplier, type ThinkingLevel } from "../_tools.ts";

/**
 * 阿里云通义（Alibaba Qwen）系列。
 * qwen3.7-plus 保留既有接入参考；新型号独立使用原生思考档位，不继承旧预算和搜索。
 * 官方依据（2026-11-16）：
 * https://help.aliyun.com/zh/model-studio/qwen3-8-flash
 * https://help.aliyun.com/zh/model-studio/qwen4-max
 * https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
 * https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses
 * https://help.aliyun.com/zh/model-studio/cot-summary
 * 两款均为 1M 上下文、图文输入；宿主不登记原生视频输入。
 * 国内北京每百万词元人民币价格按既有 0.1475 USD/CNY 折算，非网关实扣：
 * 3.8 Flash 输入/输出/缓存读/缓存写 ¥0.8/2.7/0.1/1.25。
 * 4 Max 为 ¥10/30/0.5/12.5，缓存写取 5 分钟档；1 小时档为 ¥20。
 * 这里只登记参考价，不主动创建缓存或指定 TTL。
 */
const FLASH_THINKING_LEVELS = {
	off: "none", minimal: "low", low: "low", medium: "medium",
	high: "xhigh", xhigh: "xhigh", max: "xhigh",
} as const;
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
		{
			id: "qwen3.8-flash",
			name: "Qwen3.8 Flash",
			api: "openai-completions",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: FLASH_THINKING_LEVELS,
			input: ["text", "image"],
			cost: { input: 0.118, output: 0.39825, cacheRead: 0.01475, cacheWrite: 0.184375 },
			contextWindow: 1000000,
			maxTokens: 131072,
			// 官方 Chat 参数未声明 OpenAI 的 24h retention，不让宿主注入该字段。
			compat: { ...OPENAI_COMPLETIONS_COMPAT, supportsLongCacheRetention: false },
		},
		{
			// Responses 由宿主保存并回传 reasoning.encrypted_content，避免自行解析密文。
			id: "qwen4-max",
			name: "Qwen4 Max",
			api: "openai-responses",
			baseUrl: v1,
			reasoning: true,
			thinkingLevelMap: {
				off: "none", minimal: "low", low: "low", medium: "high",
				high: "high", xhigh: "xhigh", max: "xhigh",
			},
			input: ["text", "image"],
			cost: { input: 1.475, output: 4.425, cacheRead: 0.07375, cacheWrite: 1.84375 },
			contextWindow: 1000000,
			maxTokens: 262144,
			compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false },
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
	"qwen3.8-flash": (w, c) => {
		// 原生预算与 effort 互斥；按档位控制，不沿用 3.7 的固定 6000 预算。
		w.remove("thinking_budget");
		w.set("reasoning_effort", FLASH_THINKING_LEVELS[c.thinkingLevel]);
		w.set("enable_thinking", c.thinkingLevel !== "off");
		w.set("preserve_thinking", c.thinkingLevel !== "off");
	},
	// 4 Max 的 Responses 档位完全交由宿主 thinkingLevelMap，不改写请求体。
};
