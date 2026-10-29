import type { Api, ClassifierContext, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHAT_SELECTION_IDS, selectWithChat } from "./chat-selection.ts";
import { chatFailure, classifierFailure, type SelectionFailure } from "./failure.ts";
import { chooseClassifier, resolveDelegationChoice, type DelegationCandidate } from "./policy.ts";

export interface SelectionSource {
	type: "classifier" | "chat";
	model: string;
}
export interface SelectionError extends SelectionFailure {
	source: SelectionSource;
}
interface RaceOptions {
	models: readonly Model<Api>[];
	signal: AbortSignal;
	deadlineMs: number;
	onStart: (source: SelectionSource) => void;
	onUsage: (usage: Usage) => void;
	onError: (error: SelectionError) => void;
}
interface SelectionWinner {
	selected: DelegationCandidate;
	kind?: string;
	source: SelectionSource;
}

/** 四路各发一次；失败或非法结果不是胜者，不为等待取消确认延长选型。 */
export async function raceSelection(
	registry: ExtensionContext["modelRegistry"],
	context: ClassifierContext,
	candidates: readonly DelegationCandidate[],
	options: RaceOptions,
): Promise<{ winner: SelectionWinner } | { failure: SelectionFailure }> {
	const finished = new AbortController();
	const signal = AbortSignal.any([options.signal, finished.signal]);
	let nativeFailure: SelectionFailure | undefined;
	const invalid: SelectionFailure = {
		reason: "选型结果无效、未决或不符合固定审阅规则。", failureKind: "invalid_result",
	};
	const native = async (): Promise<SelectionWinner> => {
		let source: SelectionSource | undefined;
		try {
			signal.throwIfAborted();
			if (typeof registry.classify !== "function") {
				nativeFailure = { reason: "当前宿主不支持原生分类选型。", failureKind: "unsupported" };
				throw new Error("原生分类不可用。");
			}
			const classifiers = await registry.getAvailableOfType("classifier", "tsgw", { signal });
			signal.throwIfAborted();
			const classifier = chooseClassifier(classifiers);
			if (!classifier) {
				nativeFailure = { reason: "没有可用的 TSGW 文本分类模型。", failureKind: "unavailable" };
				throw new Error("分类目录无匹配项。");
			}
			const remaining = options.deadlineMs - Date.now();
			if (remaining <= 0) {
				nativeFailure = { reason: "选型预算已耗尽。", failureKind: "timeout" };
				throw new Error("选型预算已耗尽。");
			}
			source = { type: "classifier", model: `${classifier.provider}/${classifier.id}` };
			options.onStart(source);
			const result = await registry.classify(classifier, context, { signal, timeoutMs: remaining, maxRetries: 0 });
			if (result.usage) options.onUsage(result.usage);
			signal.throwIfAborted();
			if (result.stopReason !== "stop") {
				// 整体取消已由 signal 处理；单通道中止仍按安全错误归因。
				nativeFailure = classifierFailure(result.errorMessage);
				throw new Error("分类通道未完成选型。");
			}
			const selected = resolveDelegationChoice(result.answers, candidates);
			if (!selected) {
				nativeFailure = invalid;
				throw new Error("分类结果无效。");
			}
			const answer = result.answers.kind;
			return { selected, kind: answer?.type === "choice" ? answer.choice : undefined, source };
		} catch {
			nativeFailure ??= { reason: "分类请求失败（原因未明）。", failureKind: "unknown" };
			if (source && !signal.aborted) options.onError({ source, ...nativeFailure });
			throw new Error("原生选型通道未提供有效结果。");
		}
	};
	const chat = async (modelId: (typeof CHAT_SELECTION_IDS)[number]): Promise<SelectionWinner> => {
		let source: SelectionSource | undefined;
		let failure: SelectionFailure | undefined;
		try {
			const result = await selectWithChat(registry, context, candidates, modelId, {
				...options, signal, onStart: model => {
					source = { type: "chat", model };
					options.onStart(source);
				},
			});
			if (result && !("failure" in result))
				return { selected: result.selected, kind: result.kind, source: { type: "chat", model: result.model } };
			if (result) failure = result.failure;
		} catch (error) {
			failure = chatFailure(error instanceof Error ? error.message : undefined);
		}
		// 未发起的通道和获胜/整体取消导致的中止不作为通道报错。
		if (source && !signal.aborted) options.onError({ source, ...(failure ?? invalid) });
		throw new Error("聊天选型通道未提供有效结果。");
	};
	try {
		const winner = await Promise.any([native(), ...CHAT_SELECTION_IDS.map(chat)]);
		options.signal.throwIfAborted();
		return { winner };
	} catch {
		options.signal.throwIfAborted();
		return { failure: nativeFailure ?? invalid };
	} finally {
		// 只取消选型请求，不中断获胜后的目录复核；不保证远端停止处理或计费。
		finished.abort();
	}
}
