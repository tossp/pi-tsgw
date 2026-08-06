/**
 * 请求体改写调度：按模型 id 查各厂商的思维链策略并应用。
 *
 * 各厂商的 thinking 策略定义在 `vendors/*.ts`（厂商文件自包含其思维链
 * 要求），本模块只做汇总与调度，不再硬编码模型族 switch。
 */

import { isPlainObject, PayloadWriter, type ModelOperationContext, type ThinkingApplier } from "./_tools.ts";
import { deepseekThinking } from "./vendors/deepseek.ts";
import { geminiThinking } from "./vendors/gemini.ts";
import { glmThinking } from "./vendors/glm.ts";
import { kimiThinking } from "./vendors/kimi.ts";
import { longcatThinking } from "./vendors/longcat.ts";
import { mimoThinking } from "./vendors/mimo.ts";
import { minimaxThinking } from "./vendors/minimax.ts";
import { openaiThinking } from "./vendors/openai.ts";
import { qwenThinking } from "./vendors/qwen.ts";

// 与 catalog.ts 的 PROVIDER_ID 保持一致；此处不 import catalog，避免循环依赖。
const TSGW_PROVIDER = "tsgw";

const THINKING_STRATEGIES: Record<string, ThinkingApplier> = {
	...deepseekThinking,
	...glmThinking,
	...mimoThinking,
	...minimaxThinking,
	...kimiThinking,
	...longcatThinking,
	...qwenThinking,
	...openaiThinking,
	...geminiThinking,
};

/**
 * Apply the closed set of per-vendor thinking operations without mutating
 * `payload`. Non-plain payloads and all non-TSGW requests are returned
 * unchanged. Models without a registered strategy pass through untouched.
 */
export function applyModelOperations(payload: unknown, context: ModelOperationContext): unknown {
	if (!isPlainObject(payload) || context.provider !== TSGW_PROVIDER) return payload;
	const writer = new PayloadWriter(payload);
	const applier = THINKING_STRATEGIES[context.modelId];
	if (applier) applier(writer, context);
	return writer.result();
}
