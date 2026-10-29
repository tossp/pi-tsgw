import type { Api, ClassifierContext, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWithLuna } from "./chat-selection.ts";
import { classifierFailure, type DelegationFailureKind } from "./failure.ts";
import { chooseClassifier, resolveDelegationChoice, type DelegationCandidate } from "./policy.ts";

export interface SelectionSource {
	type: "classifier" | "chat";
	model: string;
}
interface SelectionFailure {
	reason: string;
	failureKind: DelegationFailureKind;
}
interface RaceOptions {
	models: readonly Model<Api>[];
	signal: AbortSignal;
	deadlineMs: number;
	onStart: (source: SelectionSource) => void;
	onUsage: (usage: Usage) => void;
}
interface SelectionWinner {
	selected: DelegationCandidate;
	kind?: string;
	source: SelectionSource;
}

/** 两路各发一次；失败或非法结果不是胜者，不为等待取消确认延长选型。 */
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
			const source: SelectionSource = { type: "classifier", model: `${classifier.provider}/${classifier.id}` };
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
			throw new Error("原生选型通道未提供有效结果。");
		}
	};
	const chat = async (): Promise<SelectionWinner> => {
		const result = await selectWithLuna(registry, context, candidates, {
			...options, signal, onStart: model => options.onStart({ type: "chat", model }),
		});
		if (!result) throw new Error("聊天选型通道未提供有效结果。");
		return { selected: result.selected, kind: result.kind, source: { type: "chat", model: result.model } };
	};
	try {
		const winner = await Promise.any([native(), chat()]);
		options.signal.throwIfAborted();
		return { winner };
	} catch {
		options.signal.throwIfAborted();
		return { failure: nativeFailure ?? invalid };
	} finally {
		// 只取消两条选型请求，不中断获胜后的目录复核；不保证远端停止处理或计费。
		finished.abort();
	}
}
