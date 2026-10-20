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
	return { provider: "tsgw", modelId, api, thinkingLevel, tsSearchMode: "live" };
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
	if (!isPlainObject(result)) throw new Error("结果应为普通对象");
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
	for (const modelId of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx", "MiniMax-M3.1-Flash", "MiniMax-M3.1-Flash-Preview"]) {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const minimax = modelId.startsWith("MiniMax-");
			const input = { ...completionBase(), messages: [{ role: "user", content: "keep" }], tools: [{ type: "function", function: { name: "keep" } }], max_tokens: 42 };
			const result = apply(input, modelId, "openai-completions", level);
			const effort = ["off", "minimal", "low"].includes(level) ? "low"
				: minimax ? level : level === "medium" || level === "high" ? "high" : "max";
			deepStrictEqual(result, {
				...input,
				reasoning_effort: effort,
				...(minimax ? { reasoning_split: true } : { tool_stream: true }),
				thinking: { type: minimax ? "adaptive" : "enabled", retained: true,
					...(!minimax && ["high", "xhigh", "max"].includes(level) ? { clear_thinking: false } : {}) },
			});
			strictEqual(result.messages, input.messages);
			strictEqual(result.tools, input.tools);
			strictEqual(apply(result, modelId, "openai-completions", level), result);
		}
	}
	for (const modelId of ["glm-5.2", "glm-4.5-air"]) {
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
				...(modelId === "glm-5.2" ? { reasoning_effort: effort } : {}),
				thinking:
					level === "off"
						? { type: "disabled", retained: true }
						: { type: "enabled", retained: true, ...(modelId === "glm-5.2" ? { clear_thinking: false } : {}) },
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
		"mimo-v2.6-flash",
		"mimo-v2.6-pro",
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
			"MiniMax-M3",
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

	for (const modelId of ["kimi-k3", "kimi-k3-256k"]) {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			const result = apply(completionBase(), modelId, "openai-completions", level);
			const effort = ["off", "minimal", "low"].includes(level) ? "low" : level === "max" ? "max" : "high";
			deepStrictEqual(result, { stream: true, reasoning_effort: effort });
		}
	}

	for (const modelId of ["qwen3.7-plus"]) {
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
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
			if (["high", "xhigh", "max"].includes(level)) {
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
	for (const modelId of [
		"deepseek-flash",
		"deepseek-v4-pro",
	]) {
		for (const level of levels) {
			const input = {
				input: [{ role: "user", content: "keep" }],
				reasoning: { effort: "high", summary: "auto" },
				include: ["reasoning.encrypted_content"],
				store: false,
				prompt_cache_key: "keep",
			};
			const result = apply(input, modelId, "openai-responses", level);
			strictEqual(result, input);
		}
	}

	const verbosityByModel: Record<string, "low" | "medium"> = {
		"gpt-6-astra": "low",
		"gpt-6.1-sol": "low",
		"gpt-6-sol": "low",
		"gpt-6-luna": "low",
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
				tools: [{ type: "web_search", search_context_size: "medium", external_web_access: true }],
				include: ["reasoning.encrypted_content"],
				store: false,
				parallel_tool_calls: false,
			});
			strictEqual(result.reasoning, reasoning);
		}
	}
}

function testNoOpsAndProtectedFields(): void {
	const nonPlain = [null, [], new Date()] as const;
	for (const payload of nonPlain)
		strictEqual(
			applyModelOperations(payload, context("deepseek-flash")),
			payload,
		);
	// 已退役 ID 不得保留过时的思考或搜索注入策略。
	for (const id of [
		"deepseek-v4-flash", "glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5",
		"MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2.1", "kimi-for-coding", "kimi-k2.7-code",
		"kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2.5", "gpt-5.6-sol", "gpt-5.6-terra",
		"gpt-5.6-luna", "gpt-5.5", "gemini-3.1-pro-low", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite",
		"qwen3.7-max", "qwen3.6-plus", "qwen3.5-plus", "claude-fable-5", "grok-4.20", "grok-4.20-fast",
		"grok-4.3-low", "grok-4.3-medium", "grok-4.3-high",
	]) {
		for (const api of ["openai-completions", "openai-responses", "google-generative-ai"]) {
			const retired = Object.freeze({ ...completionBase(), config: { thinkingConfig: { thinkingBudget: 42 } } });
			strictEqual(apply(retired, id, api, "high"), retired, id);
		}
	}
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
			...context("gpt-6-sol", "openai-responses"),
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
	const result = apply(input, "gpt-6-sol", "openai-responses", "high");
	deepStrictEqual(result.tools, [...input.tools as unknown[],
		{ type: "web_search", search_context_size: "medium", external_web_access: true }]);
	strictEqual((result.tools as unknown[])[0], (input.tools as unknown[])[0]);
	deepStrictEqual(input.tools, [{ type: "function", name: "keep" }]);
	for (const key of [
		"model",
		"messages",
		"input",
		"contents",
		"system",
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
console.log("operations.test.ts：全部断言通过");
