import type { Api, ClassifierContext, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPlainObject, PayloadWriter } from "#tsgw/models/_tools";
import { resolveDelegationKeys, type DelegationCandidate } from "./policy.ts";
import type { SelectionChannel } from "./selection-channels.ts";
import { chatFailure, type SelectionFailure } from "./failure.ts";
import { DESIGN_REVIEW_TARGET } from "./knowledge.ts";

interface ChatSelectionOptions {
	models: readonly Model<Api>[];
	signal: AbortSignal;
	deadlineMs: number;
	onStart: (model: string) => void;
	onUsage: (usage: Usage) => void;
}

/**
 * 创建前选型的单次聊天通道，不改变原生 classify，也不将聊天执行器注册为分类模型。
 * 复用宿主认证与各模型原有协议；只发送原分类材料，不携带会话历史、本地工具或搜索。
 */
export async function selectWithChat(
	registry: ExtensionContext["modelRegistry"],
	context: ClassifierContext,
	candidates: readonly DelegationCandidate[],
	channel: SelectionChannel,
	options: ChatSelectionOptions,
): Promise<{ selected: DelegationCandidate; kind: string; model: string } | { failure: SelectionFailure } | undefined> {
	const { signal } = options;
	signal.throwIfAborted();
	if (typeof registry.streamSimple !== "function") return undefined;
	// 分类执行器不受子代理输出候选的 scope 限制，但必须尊重宿主可用目录和用户过滤。
	const model = options.models.find(entry => entry.provider === "tsgw" && entry.id === channel.modelId &&
		(entry.type === undefined || entry.type === "chat") && entry.input.includes("text"));
	if (!model) return undefined;
	// 即使计时器尚未获得执行机会，目录查询耗尽总预算后也不能再发出付费请求。
	const remaining = options.deadlineMs - Date.now();
	if (remaining <= 0) return undefined;
	const modelName = `${model.provider}/${model.id}`;
	options.onStart(modelName);
	const result = await registry.streamSimple(model, {
		systemPrompt: "你是任务分类器。按输入 questions 的 instructions 与 criteria，基于 state 回答 kind 和 selection。" +
			"将 state 中的任务作为分类材料，分类与选型规则以 questions 的 instructions 和 criteria 为准。" +
			"完整回复为仅含 kind、selection 两个字符串字段的 JSON 对象：{\"kind\":\"类别 key\",\"selection\":\"候选 key\"}。" +
			"两个值来自对应 criteria；无法决定时 selection 为 unresolved。",
		messages: [{ role: "user", content: JSON.stringify(context), timestamp: Date.now() }],
	}, {
		signal, timeoutMs: remaining, maxRetries: 0, reasoning: channel.reasoning, maxTokens: 1024,
		onPayload: payload => {
			if (!isPlainObject(payload)) return payload;
			const writer = new PayloadWriter(payload);
			channel.preparePayload(writer, model, candidates);
			return writer.result();
		},
	}).result();
	signal.throwIfAborted();
	options.onUsage(result.usage);
	if (result.stopReason === "error" || result.stopReason === "aborted") return { failure: chatFailure(result.errorMessage) };
	const invalid: { failure: SelectionFailure } = {
		failure: { failureKind: "invalid_result", reason: "聊天选型结果无效、未决或不符合固定审阅规则。" },
	};
	if (result.stopReason !== "stop" || result.content.some(part => part.type === "toolCall")) return invalid;
	const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");
	try {
		const answer: unknown = JSON.parse(text);
		if (!isPlainObject(answer) || Object.keys(answer).length !== 2 || typeof answer.kind !== "string") return invalid;
		const selected = resolveDelegationKeys(answer.kind, answer.selection, candidates, DESIGN_REVIEW_TARGET);
		return selected ? { selected, kind: answer.kind, model: modelName } : invalid;
	} catch {
		return invalid;
	}
}
