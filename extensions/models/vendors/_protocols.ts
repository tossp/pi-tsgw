import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/**
 * Wire 协议公共配置。
 *
 * 网关上的模型虽然很多，底层协议就这四类：openai-completions、
 * openai-responses、anthropic-messages、google-generative-ai。
 * 供应商分片从这里引用对应协议的公共 compat，避免各自重复定义。
 *
 * 目前只维护这四种主流协议；其他（非主流或未来新增）协议暂不纳入，
 * 有适配需要时再在此扩展。
 */

/** openai-completions：网关接受 `system` role，但不接受 OpenAI 新的 `developer` role。 */
export const OPENAI_COMPLETIONS_COMPAT: ProviderModelConfig["compat"] = {
	supportsDeveloperRole: false,
};

/** anthropic-messages：Claude 系列使用 Pi 原生 adaptive thinking。 */
export const ANTHROPIC_COMPAT: ProviderModelConfig["compat"] = {
	forceAdaptiveThinking: true,
};

// openai-responses、google-generative-ai：当前无公共 compat，协议字段保持默认。
