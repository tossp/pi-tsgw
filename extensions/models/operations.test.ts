import { deepStrictEqual, equal, strictEqual } from "node:assert";
import { applyModelOperations } from "./operations.ts";
import {
	isPlainObject,
	type ModelOperationContext,
	type ThinkingLevel,
} from "./_tools.ts";

type Payload = Record<string, unknown>;

const levels = [
	"off",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevel[];

function deepFreeze(value: unknown): void {
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
		Object.freeze(value);
		return;
	}
	if (isPlainObject(value)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
}

function context(
	modelId: string,
	api = "openai-completions",
	thinkingLevel: ThinkingLevel = "high",
): ModelOperationContext {
	return { provider: "tsgw", modelId, api, thinkingLevel };
}

function apply(
	payload: Payload,
	modelId: string,
	api: string,
	thinkingLevel: ThinkingLevel,
): Payload {
	deepFreeze(payload);
	const result = applyModelOperations(
		payload,
		context(modelId, api, thinkingLevel),
	);
	if (!isPlainObject(result)) throw new Error("expected a plain object result");
	return result;
}

function completionBase(): Payload {
	return {
		stream: true,
		reasoning_effort: "medium",
		thinking: { type: "legacy", retained: true },
	};
}

function testCompletionProfiles(): void {
	for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"]) {
		for (const level of levels) {
			const result = apply(
				completionBase(),
				modelId,
				"openai-completions",
				level,
			);
			const effort =
				level === "off"
					? undefined
					: level === "xhigh" || level === "max"
						? "max"
						: "high";
			deepStrictEqual(
				result,
				effort === undefined
					? { stream: true, thinking: { type: "disabled", retained: true } }
					: {
							stream: true,
							reasoning_effort: effort,
							thinking: { type: "enabled", retained: true },
						},
			);
		}
	}
	deepStrictEqual(
		apply(
			completionBase(),
			"deepseek-v4-flash",
			"openai-completions",
			"minimal",
		),
		{
			stream: true,
			reasoning_effort: "high",
			thinking: { type: "enabled", retained: true },
		},
	);

	for (const modelId of ["glm-5.2", "glm-5.1"]) {
		for (const level of levels) {
			const result = apply(
				completionBase(),
				modelId,
				"openai-completions",
				level,
			);
			const effort =
				level === "off"
					? "none"
					: level === "xhigh" || level === "max"
						? "max"
						: "high";
			deepStrictEqual(result, {
				stream: true,
				tool_stream: true,
				reasoning_effort: effort,
				thinking:
					level === "off"
						? { type: "disabled", retained: true }
						: { type: "enabled", retained: true, clear_thinking: false },
			});
		}
	}
	const glmNotStreaming = apply(
		{ stream: false, reasoning_effort: "medium", thinking: { type: "legacy" } },
		"glm-5.2",
		"openai-completions",
		"high",
	);
	equal(Object.hasOwn(glmNotStreaming, "tool_stream"), false);

	for (const modelId of [
		"mimo-v2.5",
		"mimo-v2.5-pro",
		"kimi-for-coding",
		"longcat-2.0",
	]) {
		for (const level of levels) {
			const result = apply(
				completionBase(),
				modelId,
				"openai-completions",
				level,
			);
			deepStrictEqual(result, {
				stream: true,
				thinking: {
					type: level === "off" ? "disabled" : "enabled",
					retained: true,
				},
			});
		}
	}

	for (const level of levels) {
		const result = apply(
			completionBase(),
			"minimax-m3",
			"openai-completions",
			level,
		);
		deepStrictEqual(result, {
			stream: true,
			reasoning_split: true,
			thinking: {
				type: level === "off" ? "disabled" : "adaptive",
				retained: true,
			},
		});
	}

	for (const level of [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	] as const satisfies readonly ThinkingLevel[]) {
		const result = apply(
			completionBase(),
			"kimi-k3",
			"openai-completions",
			level,
		);
		const effort =
			level === "off"
				? undefined
				: level === "minimal" || level === "low"
					? "low"
					: level === "max"
						? "max"
						: "high";
		deepStrictEqual(
			result,
			effort === undefined
				? { stream: true }
				: { stream: true, reasoning_effort: effort },
		);
	}

	for (const modelId of ["qwen3.7-plus", "qwen3.7-max"]) {
		for (const level of levels) {
			const result = apply(
				{
					...completionBase(),
					thinking_budget: 1,
					search_options: { old: true },
					enable_code_interpreter: false,
				},
				modelId,
				"openai-completions",
				level,
			);
			const expected: Payload = {
				stream: true,
				enable_search: true,
				parallel_tool_calls: true,
				enable_thinking: level !== "off",
				preserve_thinking: level !== "off",
				thinking: { type: "legacy", retained: true },
			};
			if (level !== "off") {
				expected.thinking_budget = 6000;
				expected.search_options = { search_strategy: "agent_max" };
				expected.enable_code_interpreter = true;
			}
			deepStrictEqual(result, expected);
		}
	}
	const qwenLow = apply(
		{
			...completionBase(),
			thinking_budget: 1,
			search_options: { old: true },
			enable_code_interpreter: false,
		},
		"qwen3.7-plus",
		"openai-completions",
		"low",
	);
	deepStrictEqual(qwenLow, {
		stream: true,
		thinking: { type: "legacy", retained: true },
		enable_search: true,
		parallel_tool_calls: true,
		enable_thinking: true,
		preserve_thinking: true,
	});
}

function testGeminiProfiles(): void {
	for (const level of levels) {
		const tools = [{ functionDeclarations: [{ name: "keep" }] }];
		const signal = new AbortController().signal;
		const input = {
			reasoning_effort: "medium",
			config: {
				tools,
				abortSignal: signal,
				thinkingConfig: { retained: true, thinkingLevel: "HIGH" },
			},
		};
		const result = apply(input, "gemini-flash", "google-generative-ai", level);
		const budget = level === "max" ? 24576 : level === "off" ? 0 : 16000;
		deepStrictEqual(result, {
			config: {
				tools,
				abortSignal: signal,
				thinkingConfig: {
					retained: true,
					includeThoughts: level !== "off",
					thinkingBudget: budget,
				},
			},
		});
		strictEqual((result.config as Payload).tools, tools);
		strictEqual((result.config as Payload).abortSignal, signal);
	}

	const proLevels: readonly ThinkingLevel[] = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	];
	for (const level of proLevels) {
		const tools = [{ functionDeclarations: [{ name: "keep" }] }];
		const signal = new AbortController().signal;
		const input = {
			reasoning_effort: "medium",
			config: {
				tools,
				abortSignal: signal,
				thinkingConfig: { retained: true, thinkingBudget: 42 },
			},
		};
		const result = apply(input, "gemini-pro", "google-generative-ai", level);
		const thinkingLevel =
			level === "off" || level === "minimal" || level === "low"
				? "LOW"
				: level === "medium"
					? "MEDIUM"
					: "HIGH";
		deepStrictEqual(result, {
			config: {
				tools,
				abortSignal: signal,
				thinkingConfig: {
					retained: true,
					includeThoughts: level !== "off",
					thinkingLevel,
				},
			},
		});
		strictEqual((result.config as Payload).tools, tools);
		strictEqual((result.config as Payload).abortSignal, signal);
	}
}

function testOpenAIResponsesProfiles(): void {
	const verbosityByModel: Record<string, "low" | "medium"> = {
		"gpt-5.6-sol": "low",
		"gpt-5.6-terra": "medium",
		"gpt-5.6-luna": "low",
		"gpt-5.5": "low",
		"gpt-5.3-codex-spark": "low",
	};
	for (const [modelId, verbosity] of Object.entries(verbosityByModel)) {
		for (const level of levels) {
			const reasoning = { effort: "high", summary: "auto", retained: true };
			const input = {
				reasoning,
				text: { format: "text" },
				include: ["reasoning.encrypted_content"],
				store: false,
				parallel_tool_calls: false,
			};
			const result = apply(input, modelId, "openai-responses", level);
			deepStrictEqual(result, {
				reasoning,
				text: { format: "text", verbosity },
				include: ["reasoning.encrypted_content"],
				store: false,
				parallel_tool_calls: false,
				service_tier: "flex",
			});
			strictEqual(result.reasoning, reasoning);
		}
	}
}

function testNoOpsAndProtectedFields(): void {
	const nonPlain = [null, [], new Date()] as const;
	for (const payload of nonPlain)
		strictEqual(
			applyModelOperations(payload, context("deepseek-v4-flash")),
			payload,
		);
	const claude = { model: "keep" };
	strictEqual(
		applyModelOperations(
			claude,
			context("claude-fable-5", "anthropic-messages"),
		),
		claude,
	);
	strictEqual(
		applyModelOperations(claude, {
			...context("gpt-5.6-sol", "openai-responses"),
			provider: "other",
		}),
		claude,
	);

	const input: Payload = {
		model: "keep",
		messages: [{ role: "user", content: "keep" }],
		input: ["keep"],
		contents: ["keep"],
		system: "keep",
		tools: [{ type: "function", name: "keep" }],
		tool_choice: "auto",
		headers: { keep: "yes" },
		stream: true,
		include: ["keep"],
		store: false,
		prompt_cache_key: "keep",
		max_output_tokens: 9,
		reasoning_effort: "keep",
		reasoning: { effort: "high", summary: "auto" },
		parallel_tool_calls: false,
	};
	const result = apply(input, "gpt-5.6-terra", "openai-responses", "high");
	for (const key of [
		"model",
		"messages",
		"input",
		"contents",
		"system",
		"tools",
		"tool_choice",
		"headers",
		"stream",
		"include",
		"store",
		"prompt_cache_key",
		"max_output_tokens",
		"reasoning_effort",
		"reasoning",
		"parallel_tool_calls",
	]) {
		deepStrictEqual(result[key], input[key]);
	}
}

testCompletionProfiles();
testGeminiProfiles();
testOpenAIResponsesProfiles();
testNoOpsAndProtectedFields();
console.log("operations.test.ts: all assertions passed");
