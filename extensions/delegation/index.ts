import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI, ExtensionContext, MessageEndEventResult, ToolCallEvent, ToolCallEventResult, ToolResultEvent, ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { isPlainObject } from "#tsgw/models/_tools";
import {
	buildDelegationCandidates, buildDelegationContext, buildDelegationGuide, chooseClassifier, resolveDelegationChoice,
	type DelegationCandidate,
} from "./policy.ts";
import { classifierFailure, failureGuidance, type DelegationFailureKind } from "./failure.ts";

const TIMEOUT_MS = 15_000;
const MAX_CONTEXT_BYTES = 28 * 1024;
const GUIDANCE = "新建子代理时，直接调用 Agent，写清任务、必要事实、输入与工具条件、关键难点、验收标准和约束；未明确指定模型时省略 model，" +
	"由 TSGW 在创建前自动分类选型，无需读取长选型表或编写 codemode 分类脚本。" +
	"用户指定模型或固定审阅组合时显式传 model；resume 沿用原模型，不重新选型。" +
	"分类失败时按工具报告的失败类型处理，由发起调用的主代理自行选型并显式指定 Agent.model 再调用；" +
	"不重试分类器，调用已取消时不自动重新派遣。";

type Decision = {
	status: "selected" | "blocked";
	classifier?: string;
	model?: string;
	kind?: string;
	reason?: string;
	failureKind?: DelegationFailureKind;
	selectionGuide?: string;
	durationMs: number;
};
interface Attempt {
	controller: AbortController;
	completion: Promise<Decision>;
	decision?: Decision;
	usage?: Usage;
	candidates?: DelegationCandidate[];
}

function failureText(decision: Decision): string {
	return `TSGW ${decision.reason ?? "分类选型未完成。"}${failureGuidance(decision.failureKind)}` +
		(decision.selectionGuide ? `\n\n${decision.selectionGuide}` : "");
}

/** 按参数契约识别兼容 Agent，不把宿主的工具暴露方式作为选型前提。 */
function hasAgent(pi: ExtensionAPI): boolean {
	const tool = (pi.getAllTools?.() ?? []).find(entry => entry.name === "Agent");
	if (!tool || !isPlainObject(tool.parameters)) return false;
	const properties = tool.parameters.properties;
	return isPlainObject(properties) && ["prompt", "model", "resume"].every(name =>
		isPlainObject(properties[name]) && properties[name].type === "string");
}

function supplied(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

/** 取消要中断等待；上游即使忽略 signal，迟到结果也不能创建子代理。 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("分类等待已取消。"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function addUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first) return second;
	if (!second) return first;
	return {
		input: first.input + second.input, output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead, cacheWrite: first.cacheWrite + second.cacheWrite,
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input, output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite, total: first.cost.total + second.cost.total,
		},
		...(first.reasoning === undefined && second.reasoning === undefined ? {} :
			{ reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) }),
		...(first.cacheWrite1h === undefined && second.cacheWrite1h === undefined ? {} :
			{ cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) }),
	};
}

/** 只接管新建 Agent 的一次选型；不拥有子会话，不接触其后续轮次或调度。 */
export function registerDelegation(pi: ExtensionAPI): void {
	let active = false;
	let lifecycle = new AbortController();
	const attempts = new Map<string, Attempt>();
	const clear = () => {
		for (const attempt of attempts.values()) attempt.controller.abort();
		attempts.clear();
	};
	pi.on("session_start", (_event, ctx) => {
		active = false;
		lifecycle.abort();
		clear();
		lifecycle = new AbortController();
		// Pi Web 在 session_start 前写入该公开可读标记；普通 fork 的 parentSession 不是角色证据。
		const entries = ctx?.sessionManager?.getEntries?.() ?? [];
		active = !entries.some(entry => entry.type === "custom" && entry.customType === "pi-web:subagent");
	});
	pi.on("session_shutdown", () => {
		active = false;
		lifecycle.abort();
		clear();
	});
	pi.on("agent_end", clear);
	pi.on("before_agent_start", event => {
		if (!active || !pi.getActiveTools().includes("Agent") || !hasAgent(pi)) return;
		if (event.systemPromptOptions) event.systemPromptOptions.sections.tsgw_delegation = GUIDANCE;
		else return { systemPrompt: `${event.systemPrompt}\n\n${GUIDANCE}` };
	});

	async function select(event: ToolCallEvent, ctx: ExtensionContext, attempt: Attempt): Promise<Decision> {
		const started = Date.now();
		const blocked = (reason: string, failureKind: DelegationFailureKind): Decision =>
			({ status: "blocked", reason, failureKind, durationMs: Date.now() - started });
		const registry = ctx.modelRegistry;
		const scope = ctx.scopedModels?.map(entry => ({
			model: `${entry.model.provider}/${entry.model.id}`, level: entry.thinkingLevel,
		})) ?? [];
		const caller = ctx.signal;
		const cancellation = AbortSignal.any([lifecycle.signal, attempt.controller.signal, ...(caller ? [caller] : [])]);
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		const signal = AbortSignal.any([cancellation, timeout]);
		const input: Record<string, unknown> = event.input;
		const task = {
			prompt: typeof input.prompt === "string" ? input.prompt : "",
			...(typeof input.description === "string" ? { description: input.description } : {}),
			...(typeof input.subagent_type === "string" ? { subagent_type: input.subagent_type } : {}),
			...(Array.isArray(input.input_files) && input.input_files.every(path => typeof path === "string") ?
				{ input_files: [...input.input_files] as string[] } : {}),
			...(typeof input.run_in_background === "boolean" ? { run_in_background: input.run_in_background } : {}),
		};
		let classifierId: string | undefined;
		const failure = (reason: string, kind: DelegationFailureKind): Decision => {
			return { ...blocked(reason, kind), ...(classifierId ? { classifier: classifierId } : {}),
				...(kind === "cancelled" ? {} : { selectionGuide: buildDelegationGuide(attempt.candidates) }) };
		};
		try {
			signal.throwIfAborted();
			if (!task.prompt.trim()) return failure("任务提示词为空。", "invalid_input");
			if (typeof registry.getAvailableOfType !== "function" || typeof registry.classify !== "function")
				return failure("当前宿主不支持原生分类选型。", "unsupported");
			const candidates = async (): Promise<DelegationCandidate[]> => {
				const models = await abortable(registry.getAvailableOfType("chat", "tsgw", { signal }), signal);
				const available = buildDelegationCandidates(models.filter(model => !scope.length ||
					scope.some(entry => entry.model === `${model.provider}/${model.id}`)), getSupportedThinkingLevels)
					.filter(candidate => !scope.length || scope.some(entry => entry.model === `${candidate.provider}/${candidate.id}` &&
						(!entry.level || entry.level === candidate.level)));
				attempt.candidates = available;
				return available;
			};
			const available = await candidates();
			if (!available.length) return failure("没有符合选型规则和当前目录/会话范围的聊天模型。", "unavailable");
			const context = buildDelegationContext(task, available);
			if (Buffer.byteLength(JSON.stringify(context), "utf8") > MAX_CONTEXT_BYTES)
				return failure("选型材料超过 28 KiB，请精简提示词或显式指定模型；未截断任务。", "invalid_input");
			const classifiers = await abortable(registry.getAvailableOfType("classifier", "tsgw", { signal }), signal);
			const classifier = chooseClassifier(classifiers);
			if (!classifier) return failure("没有可用的 TSGW 文本分类模型。", "unavailable");
			classifierId = `${classifier.provider}/${classifier.id}`;
			signal.throwIfAborted();
			const result = await abortable(registry.classify(classifier, context,
				{ signal, timeoutMs: TIMEOUT_MS, maxRetries: 0 }), signal);
			attempt.usage = result.usage;
			signal.throwIfAborted();
			if (result.stopReason !== "stop") {
				const error = classifierFailure(result.errorMessage, result.stopReason === "aborted");
				return failure(error.reason, error.failureKind);
			}
			const selected = resolveDelegationChoice(result.answers, available);
			if (!selected) return failure("分类结果无效、未决或不符合固定审阅规则。", "invalid_result");
			// 分类过程中目录可能刷新；必须再次校验，不能静默选另一个模型。
			const current = await candidates();
			signal.throwIfAborted();
			if (!current.some(candidate => candidate.model === selected.model))
				return failure("选定模型或思考档位已不在当前可用候选中。", "model_unavailable");
			const kind = result.answers.kind;
			return { status: "selected", classifier: classifierId, model: selected.model,
				...(kind?.type === "choice" ? { kind: kind.choice } : {}), durationMs: Date.now() - started };
		} catch {
			if (cancellation.aborted) return failure("分类选型已取消（调用或会话已结束）。", "cancelled");
			if (timeout.aborted) return failure("分类选型超时（15 秒上限）。", "timeout");
			return failure("分类选型失败（原因未明），请检查目录与宿主认证。", "unknown");
		}
	}

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (event.toolName !== "Agent" || supplied(event.input.resume) || supplied(event.input.model)) return;
		if (!active || !hasAgent(pi)) return;
		const caller = ctx.signal;
		let attempt = attempts.get(event.toolCallId);
		if (!attempt) {
			attempt = { controller: new AbortController(), completion: Promise.resolve({ status: "blocked", durationMs: 0 }) };
			attempts.set(event.toolCallId, attempt);
			attempt.completion = select(event, ctx, attempt);
		}
		let decision = await attempt.completion;
		if (!active || attempt.controller.signal.aborted || caller?.aborted)
			decision = { ...decision, status: "blocked", model: undefined, failureKind: "cancelled", selectionGuide: undefined,
				reason: "分类选型已取消（调用或会话已结束）。" };
		attempt.decision = decision;
		if (decision.status !== "selected" || !decision.model)
			return { block: true, reason: failureText(decision) };
		// 只补模型，不改变 prompt/profile/后台标志/隔离方式；原 Agent 继续执行。
		event.input.model = decision.model;
	});

	const decorateResult = (event: Pick<ToolResultEvent, "toolCallId" | "toolName" | "content" | "isError"> &
		Partial<Pick<ToolResultEvent, "details" | "structuredContent" | "usage">>
	): ToolResultEventResult | undefined => {
		const attempt = attempts.get(event.toolCallId);
		if (event.toolName !== "Agent" || !attempt?.decision) return;
		attempts.delete(event.toolCallId);
		const decision = attempt.decision;
		const summary = decision.status === "selected"
			? `TSGW 创建前选型：${decision.model}（分类器 ${decision.classifier}）；${event.isError ? "原 Agent 调用未成功。" : "已交由原 Agent 执行。"}`
			: failureText(decision);
		return {
			content: event.content.some(block => block.type === "text" && block.text === summary)
				? event.content : [...event.content, { type: "text" as const, text: summary }],
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
			details: { ...(isPlainObject(event.details) ? event.details : { originalDetails: event.details }),
				tsgwDelegation: decision },
			usage: addUsage(event.usage, attempt.usage),
		};
	};
	pi.on("tool_result", decorateResult);
	// Pi 的执行前阻止/取消路径不会触发 tool_result；在最终消息处补记已报告的分类用量。
	// 正常执行已在 tool_result 消费记录，不能在 message_end 再次加账。
	pi.on("message_end", (event): MessageEndEventResult | undefined => {
		if (event.message.role !== "toolResult") return;
		const result = decorateResult(event.message);
		if (result) return { message: { ...event.message, ...result } as typeof event.message };
	});
}
