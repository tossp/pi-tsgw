/**
 * 请求体改写调度：按模型 id 查各厂商的思维链策略并应用。
 *
 * 各厂商的思维链策略定义在 `vendors/*.ts`（厂商文件自包含其思维链
 * 要求），本模块只做汇总与调度，不再硬编码模型族分支。
 */

import {
	isPlainObject,
	PayloadWriter,
	type ModelOperationContext,
	type ThinkingApplier,
} from "./_tools.ts";
import { applyBuiltinSearchTool } from "./web-search.ts";
import { geminiThinking } from "./vendors/gemini.ts";
import { glmThinking } from "./vendors/glm.ts";
import { grokThinking } from "./vendors/grok.ts";
import { kimiThinking } from "./vendors/kimi.ts";
import { longcatThinking } from "./vendors/longcat.ts";
import { mimoThinking } from "./vendors/mimo.ts";
import { minimaxThinking } from "./vendors/minimax.ts";
import { openaiThinking } from "./vendors/openai.ts";
import { qwenThinking } from "./vendors/qwen.ts";

// 与 catalog.ts 的 PROVIDER_ID 保持一致；此处不导入 catalog，避免循环依赖。
const TSGW_PROVIDER = "tsgw";

const THINKING_STRATEGIES: Record<string, ThinkingApplier> = {
	...glmThinking,
	...mimoThinking,
	...minimaxThinking,
	...kimiThinking,
	...longcatThinking,
	...qwenThinking,
	...openaiThinking,
	...geminiThinking,
	...grokThinking,
};

/**
 * 应用预先限定的各厂商思维链操作，不修改原始 `payload`。
 * 非普通对象的请求体与所有非 TSGW 请求均原样返回。
 * 未注册策略的模型不做改动，直接透传。
 */
export function applyModelOperations(
	payload: unknown,
	context: ModelOperationContext,
): unknown {
	if (!isPlainObject(payload) || context.provider !== TSGW_PROVIDER)
		return payload;
	const writer = new PayloadWriter(payload);
	const applier = THINKING_STRATEGIES[context.modelId];
	if (applier) applier(writer, context);
	// 思维链改写后，再为支持内置查询的模型注入 web_search 工具。
	return applyBuiltinSearchTool(
		writer.result(),
		context.modelId,
		context.api,
		context.tsSearchMode,
	);
}
