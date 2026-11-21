import type { Api, ClassifierContext, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { selectWithChat } from "./chat-selection.ts";
import { chatFailure, type SelectionFailure } from "./failure.ts";
import type { DelegationCandidate } from "./policy.ts";
import { SELECTION_CHANNELS, type SelectionChannel } from "./selection-channels.ts";

export interface SelectionSource {
	type: "chat";
	model: string;
}
export interface SelectionError extends SelectionFailure {
	source: SelectionSource;
}
interface SelectionOptions {
	models: readonly Model<Api>[];
	signal: AbortSignal;
	deadlineMs: number;
	onStart: (source: SelectionSource) => void;
	onUsage: (usage: Usage) => void;
	onError: (error: SelectionError) => void;
}
interface SelectionWinner {
	selected: DelegationCandidate;
	kind: string;
	source: SelectionSource;
}

/** 上游忽略 signal 时也结束本地等待。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

export async function selectInStages(
	registry: ExtensionContext["modelRegistry"],
	context: ClassifierContext,
	candidates: readonly DelegationCandidate[],
	options: SelectionOptions,
): Promise<{ winner: SelectionWinner } | { failure: SelectionFailure }> {
	const { primary, primaryTimeoutMs, backups } = SELECTION_CHANNELS;
	const failures: SelectionFailure[] = [];
	const chat = async (channel: SelectionChannel, signal: AbortSignal, deadlineMs: number) => {
		let source: SelectionSource | undefined;
		let failure: SelectionFailure | undefined;
		try {
			const result = await abortable(selectWithChat(registry, context, candidates, channel, {
				...options, signal, deadlineMs, onStart: model => {
					source = { type: "chat", model };
					options.onStart(source);
				},
			}), signal);
			signal.throwIfAborted();
			if (result && !("failure" in result))
				return { selected: result.selected, kind: result.kind, source: { type: "chat", model: result.model } } satisfies SelectionWinner;
			failure = result?.failure;
		} catch (error) {
			if (!signal.aborted) failure = chatFailure(error instanceof Error ? error.message : undefined);
			else if (channel === primary && !options.signal.aborted)
				failure = { failureKind: "timeout", reason: `首选通道请求超时（${primaryTimeoutMs / 1000} 秒上限）。` };
		}
		// 只记录真实发起的失败。整体取消和后备胜出后的取消不计入错误。
		if (source && failure) {
			failures.push(failure);
			options.onError({ source, ...failure });
		}
		return undefined;
	};

	const primaryDeadline = Math.min(options.deadlineMs, Date.now() + primaryTimeoutMs);
	const primarySignal = AbortSignal.any([options.signal, AbortSignal.timeout(primaryTimeoutMs)]);
	const winner = await chat(primary, primarySignal, primaryDeadline);
	options.signal.throwIfAborted();
	if (winner) return { winner };

	const finished = new AbortController();
	const signal = AbortSignal.any([options.signal, finished.signal]);
	try {
		const winner = await Promise.any(backups.map(async channel => {
			const selected = await chat(channel, signal, options.deadlineMs);
			if (!selected) throw new Error("后备通道未提供有效选型。");
			return selected;
		}));
		options.signal.throwIfAborted();
		return { winner };
	} catch {
		options.signal.throwIfAborted();
		if (failures.length > 1) return { failure: { reason: "所有选型通道均未返回有效结果。", failureKind: "selection_failed" } };
		return { failure: failures[0] ?? { reason: "没有可用的 TSGW 聊天选型通道。", failureKind: "unavailable" } };
	} finally {
		finished.abort();
	}
}
