import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type AnyRecord = Record<string, unknown>;
export type ToolCallResult = {
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	usage?: Usage;
	isError: boolean;
};

function fixtureUsage(): Usage {
	return {
		input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
	};
}

export interface FixtureState {
	agentCalls: Array<{ toolCallId: string; params: AnyRecord }>;
	resultQueries: AnyRecord[];
	steers: AnyRecord[];
	nestedOutcomes: Array<{ isError: boolean; text: string }>;
	blockAgent: boolean;
	permissionBlocks: number;
	permissionSeenModel?: string;
	delegationGuidancePresent?: boolean;
}

/** 只记录模型发起的 Agent 参数；不启动子会话、不读取个人配置、不发出真实请求。 */
export function fixtureExtension(pi: ExtensionAPI, state: FixtureState): void {
	pi.on("before_agent_start", event => {
		state.delegationGuidancePresent = event.systemPromptOptions?.sections.tsgw_delegation !== undefined;
	});
	pi.registerTool({
		name: "Agent",
		label: "Fixture Agent",
		description: "Test-only Agent stand-in that records the delegated call without starting a subagent.",
		exposure: "model-only",
		parameters: Type.Object({
			subagent_type: Type.Optional(Type.String()),
			prompt: Type.String(),
			resume: Type.Optional(Type.String()),
			input_files: Type.Optional(Type.Array(Type.String())),
			description: Type.String(),
			run_in_background: Type.Optional(Type.Boolean()),
			model: Type.Optional(Type.String()),
			isolation: Type.Optional(Type.String()),
		}),
		async execute(toolCallId, params) {
			state.agentCalls.push({ toolCallId, params: { ...params } });
			return {
				content: [{ type: "text" as const, text: "fixture agent executed" }],
				details: {
					kind: "host-agent-result",
					host: { profile: params.subagent_type ?? "general-purpose", marker: "keep-me" },
				},
				usage: fixtureUsage(),
			};
		},
	});
	pi.registerTool({
		name: "probe_nested",
		label: "Fixture nested probe",
		description: "Test-only probe for whether the model-only Agent can be called through ctx.executeTool().",
		exposure: "model-only",
		parameters: Type.Object({ nested: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!params.nested) return { content: [{ type: "text" as const, text: "probe only" }], details: undefined };
			const outcome = await ctx.executeTool("Agent", { prompt: "nested task", description: "nested" });
			state.nestedOutcomes.push({
				isError: outcome.isError,
				text: outcome.result.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
			});
			return { content: [{ type: "text" as const, text: "nested probe finished" }], details: undefined };
		},
	});
	pi.registerTool({
		name: "get_subagent_result",
		label: "Fixture result query",
		description: "Test-only result query stand-in.",
		exposure: "model-only",
		parameters: Type.Object({ agent_id: Type.String(), wait: Type.Optional(Type.Boolean()) }),
		async execute(_toolCallId, params) {
			state.resultQueries.push({ ...params });
			return { content: [{ type: "text" as const, text: "fixture result query" }], details: undefined };
		},
	});
	pi.registerTool({
		name: "steer_subagent",
		label: "Fixture steer",
		description: "Test-only steering stand-in.",
		exposure: "model-only",
		parameters: Type.Object({ agent_id: Type.String(), message: Type.String() }),
		async execute(_toolCallId, params) {
			state.steers.push({ ...params });
			return { content: [{ type: "text" as const, text: "fixture steer" }], details: undefined };
		},
	});
	// 本扩展在根入口之后加载，因此该权限处理器必须还能阻止已被选型改写的 Agent。
	pi.on("tool_call", event => {
		if (event.toolName !== "Agent" || !state.blockAgent) return;
		state.permissionBlocks++;
		state.permissionSeenModel = typeof event.input.model === "string" ? event.input.model : undefined;
		return { block: true, reason: "fixture permission handler blocked Agent" };
	});
}

let responseSequence = 0;

/** Responses SSE 的 function call；Pi 会把 item.id 追加到 toolCallId。 */
export function toolCallSse(call: { name: string; args: AnyRecord; callId: string; itemId: string }): Response {
	const item = {
		id: call.itemId, type: "function_call", call_id: call.callId,
		name: call.name, arguments: JSON.stringify(call.args), status: "completed",
	};
	const events = [
		{ type: "response.created", response: { id: `resp_fixture_${++responseSequence}`, status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: item.arguments },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: {
			id: `resp_fixture_${responseSequence}`, status: "completed", output: [item],
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
		} },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

export function textSse(text: string): Response {
	const item = {
		id: "msg_fixture", type: "message", role: "assistant", status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: `resp_fixture_${++responseSequence}`, status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: {
			id: `resp_fixture_${responseSequence}`, status: "completed", output: [item],
			usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
		} },
	];
	return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

export function lastAgentResult(session: AgentSession): ToolCallResult | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index] as unknown as AnyRecord;
		if (message.role === "toolResult" && message.toolName === "Agent")
			return message as unknown as ToolCallResult;
	}
	return undefined;
}

export function resultText(result: ToolCallResult): string {
	return result.content.filter(block => block.type === "text").map(block => block.text ?? "").join("\n");
}

export function makeGate(): { promise: Promise<void>; open: () => void } {
	let open!: () => void;
	const promise = new Promise<void>(resolve => { open = resolve; });
	return { promise, open };
}
