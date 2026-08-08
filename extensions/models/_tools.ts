/**
 * 通用请求改写工具：copy-on-write 的 PayloadWriter、类型与共享辅助函数。
 *
 * 这是 models 模块的内部工具层（下划线前缀 = 不对外暴露），vendors 分片
 * 与 operations 调度都从这里引用，避免 vendors ↔ operations 循环依赖。
 */

export type ThinkingLevel =
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";
export type WebSearchMode = "off" | "cached" | "live";

export interface ModelOperationContext {
	provider: string;
	modelId: string;
	api: string;
	thinkingLevel: ThinkingLevel;
	tsSearchMode: WebSearchMode;
}

export type Payload = Record<string, unknown>;
type GoogleThinkingField =
	| "includeThoughts"
	| "thinkingLevel"
	| "thinkingBudget";
type ThinkingUpdate = Partial<Pick<Payload, "type" | "clear_thinking">>;
type GoogleThinkingUpdate = Partial<Pick<Payload, GoogleThinkingField>>;

export function isPlainObject(value: unknown): value is Payload {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Copy the top level and nested objects only when a declared operation changes them. */
export class PayloadWriter {
	private copy: Payload | undefined;

	constructor(private readonly payload: Payload) {}

	get(key: string): unknown {
		return (this.copy ?? this.payload)[key];
	}

	set(key: string, value: unknown): void {
		if (Object.is(this.get(key), value)) return;
		this.mutable()[key] = value;
	}

	remove(key: string): void {
		if (!Object.hasOwn(this.copy ?? this.payload, key)) return;
		delete this.mutable()[key];
	}

	setThinking(values: ThinkingUpdate): void {
		const current = this.get("thinking");
		const thinking = isPlainObject(current) ? current : {};
		const changed =
			!isPlainObject(current) ||
			THINKING_FIELDS.some(
				(key) => key in values && !Object.is(thinking[key], values[key]),
			);
		if (changed) this.set("thinking", { ...thinking, ...values });
	}

	setGoogleThinking(
		values: GoogleThinkingUpdate,
		remove: readonly GoogleThinkingField[] = [],
	): void {
		const currentConfig = this.get("config");
		if (currentConfig !== undefined && !isPlainObject(currentConfig)) return;

		const config = isPlainObject(currentConfig) ? currentConfig : {};
		const currentThinking = config.thinkingConfig;
		const thinking = isPlainObject(currentThinking) ? currentThinking : {};
		const valuesChanged =
			!isPlainObject(currentThinking) ||
			GOOGLE_THINKING_FIELDS.some(
				(key) => key in values && !Object.is(thinking[key], values[key]),
			);
		const removeChanged = remove.some((key) => Object.hasOwn(thinking, key));
		if (!valuesChanged && !removeChanged) return;

		const nextThinking = { ...thinking, ...values };
		for (const key of remove) delete nextThinking[key];
		this.set("config", { ...config, thinkingConfig: nextThinking });
	}

	setTextVerbosity(verbosity: "low" | "medium"): void {
		const current = this.get("text");
		if (current !== undefined && !isPlainObject(current)) return;
		const text = isPlainObject(current) ? current : {};
		if (text.verbosity === verbosity) return;
		this.set("text", { ...text, verbosity });
	}

	result(): Payload {
		return this.copy ?? this.payload;
	}

	private mutable(): Payload {
		this.copy ??= { ...this.payload };
		return this.copy;
	}
}

const THINKING_FIELDS = ["type", "clear_thinking"] as const;
const GOOGLE_THINKING_FIELDS = [
	"includeThoughts",
	"thinkingLevel",
	"thinkingBudget",
] as const;

export function isAtLeastHigh(level: ThinkingLevel): boolean {
	return level === "high" || level === "xhigh" || level === "max";
}

export function isMaximum(level: ThinkingLevel): boolean {
	return level === "xhigh" || level === "max";
}

/** 通用开关式 thinking：`off` 禁用，其余启用；移除通用 effort 字段。 */
export function applyEnabledThinking(
	writer: PayloadWriter,
	level: ThinkingLevel,
): void {
	writer.remove("reasoning_effort");
	writer.setThinking({ type: level === "off" ? "disabled" : "enabled" });
}

/** 厂商思维链策略：对指定模型的请求体应用该厂商的 thinking 改写。 */
export type ThinkingApplier = (
	writer: PayloadWriter,
	context: ModelOperationContext,
) => void;
