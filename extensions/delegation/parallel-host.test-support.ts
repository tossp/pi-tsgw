import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import { makeGate, textSse, toolCallSse, type AnyRecord } from "./host.test-support.ts";

export const MAIN_MODEL_ID = "gpt-6-sol";
export const HUNYUAN_ID = "hy4-flash";
export const DEEPSEEK_ID = "deepseek-flash";
export const GLM_ID = "glm-5.3-flash";
export const FALLBACK_IDS = [DEEPSEEK_ID, GLM_ID] as const;
/** 固定选型通道的声明顺序：混元优先，两条后备在混元失败后并发。 */
export const CHAT_SELECTION_IDS = [HUNYUAN_ID, DEEPSEEK_ID, GLM_ID] as const;
export type ChatLane = (typeof CHAT_SELECTION_IDS)[number];
export type FallbackLane = (typeof FALLBACK_IDS)[number];
/** 混元独占窗口；超时后剩余总预算内并发两条后备。 */
export const HUNYUAN_WINDOW_MS = 7_000;
export const TOTAL_BUDGET_MS = 15_000;
/** 三种选型协议的实际路径；混元与 DeepSeek 虽同一厂商网关，但协议不同。 */
export const HUNYUAN_PATH = "/v1/chat/completions";
export const GLM_PATH = "/v1/messages";

// 上游正文只用于确认不泄露，不应出现在结果、文本、details 或错误摘要中。
export const CHAT_SECRET = "LANE-UPSTREAM-FAILURE-DETAIL";
// 合成用量：夹具 Agent 10/2、每款选型通道 12/3；屏障与取消观察都设上限，串行实现快速失败。
export const AGENT_TOKENS = { input: 10, output: 2, total: 12 };
export const CHAT_TOKENS = { input: 12, output: 3, total: 15 };
/** 各选型通道的 HTTP 500 进入安全摘要；夹具的 499 仅用于观察取消，不应入册。 */
export const LANE_HTTP = 500;
export const PARALLEL_TIMEOUT_MS = 3_000;
export const ABORT_TIMEOUT_MS = 5_000;

export type ChatQuestions = Record<string, { criteria: Record<string, string> }>;
export interface RacePlan { next?: { name: string; args: AnyRecord; callId: string; itemId: string } }
export type HunyuanMode = "select" | "invalid" | "error" | "hang";
/** after-errors：等到此前各路的错误响应已被宿主消费后再提交结果，用于确定“先报错、后胜出”的顺序。 */
export type FallbackMode = "select" | "invalid" | "error" | "hang" | "after-errors";
export interface LaneRequest {
	body: AnyRecord;
	headers: Headers;
	/** 请求到达夹具的时间，用于核对混元 7 秒窗口和后备并发。 */
	at: number;
}
export interface LaneHarnessOptions {
	guardedFetch: typeof fetch;
	plan: RacePlan;
}
export interface ArrangeOptions {
	hunyuan: HunyuanMode;
	deepseek?: FallbackMode;
	glm?: FallbackMode;
	/** holdReturned 模式下，胜出通道等待若干条错误/非法响应被读完后再回应。 */
	holdReturned?: number;
	/** 实际会到达的后备通道数；目录缺项时用于把并发屏障收缩到真实条数。 */
	expectedFallbacks?: number;
}
export interface LaneHarness {
	mainRequests: AnyRecord[];
	hunyuanRequests: LaneRequest[];
	fallbackRequests: Record<FallbackLane, LaneRequest[]>;
	/** 委派选型不得再请求原生分类。 */
	systemoneRequests: AnyRecord[];
	fetch: typeof fetch;
	arrange(options: ArrangeOptions): void;
	expectSelection(key: string): void;
	/** 按 CHAT_SELECTION_IDS 顺序统计实际请求次数。 */
	laneCounts(): number[];
	/** holdReturned 模式下已被宿主读完的落败响应数，用于验证“先报错或非法、后胜出”确实发生。 */
	drainedErrors(): number;
	readonly hunyuanAborted: boolean;
	readonly fallbackAborted: Record<FallbackLane, boolean>;
}

export function laneModel(lane: ChatLane): string {
	return `tsgw/${lane}`;
}

export function sourceEntry(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === "pi-tsgw")
			return join(dir, "index.ts");
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位源码入口");
		dir = parent;
	}
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); });
	});
}

/** HTTP 级同步屏障：两条后备都到达后才释放，串行实现无法通过。 */
export function makeCrossGate(expected: number) {
	const gate = makeGate();
	let arrived = 0;
	return {
		arrive: (): Promise<void> => {
			if (++arrived >= expected) gate.open();
			return withTimeout(gate.promise, PARALLEL_TIMEOUT_MS,
				`等待 ${expected} 路后备选型请求同时到达超时（疑似仍是串行执行）`);
		},
	};
}

/** 只观察胜出或超时后是否主动取消该通道，不依赖真实耗时或 sleep。 */
export function abortNotice(signal: AbortSignal | null | undefined, ms = ABORT_TIMEOUT_MS): Promise<boolean> {
	if (!signal || signal.aborted) return Promise.resolve(signal?.aborted === true);
	return new Promise<boolean>(resolve => {
		const timer = setTimeout(() => resolve(false), ms);
		signal.addEventListener("abort", () => { clearTimeout(timer); resolve(true); }, { once: true });
	});
}

/** 在响应体被宿主读完时回调，把“落败通道先返回”变成可观察的顺序，而不是靠延时猜测。 */
export function trackedResponse(response: Response, onDrain: () => void): Response {
	const body = response.body;
	if (!body) return response;
	const reader = body.getReader();
	const stream = new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) { controller.close(); onDrain(); return; }
			controller.enqueue(value);
		},
	});
	return new Response(stream, { status: response.status, headers: response.headers });
}

/** 让出若干宏任务，确保上一路错误的拒绝与记录已经落地，再放行下一路。 */
async function drainTurns(turns = 3): Promise<void> {
	for (let index = 0; index < turns; index++) await new Promise(resolve => setImmediate(resolve));
}

/** Responses 聊天通道只有分类器系统提示与一条 user 消息；后者应与原生分类材料逐字一致。 */
export function chatMessage(body: AnyRecord, instructionRole: "developer" | "system"): string {
	const input = body.input;
	assert.ok(Array.isArray(input), "Responses 请求必须带 input 数组");
	const messages = (input as AnyRecord[]).filter(item => item.type !== "configuration_update");
	assert.deepEqual(messages.map(item => item.role), [instructionRole, "user"],
		"聊天通道只允许分类器系统提示与原分类材料，不携带会话历史或工具结果");
	const message = messages[1] as AnyRecord;
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content));
	return message.content.map(part => String((part as AnyRecord).text ?? "")).join("");
}

export function chatSystemPrompt(body: AnyRecord, role: "developer" | "system" = "system"): string {
	const input = body.input;
	assert.ok(Array.isArray(input) && input.length > 0);
	const system = input[0] as AnyRecord;
	assert.equal(system.role, role);
	assert.ok(typeof system.content === "string");
	return system.content as string;
}

/** Chat Completions 只有 system 与 user 两条消息；system 是三路共用的分类器提示。 */
export function chatCompletionMessage(body: AnyRecord): { system: string; user: string } {
	assert.deepEqual(body.messages && (body.messages as AnyRecord[]).map(message => message.role),
		["system", "user"], "Chat Completions 只允许分类器系统提示与原分类材料");
	const [system, user] = body.messages as AnyRecord[];
	assert.equal(typeof system!.content, "string");
	assert.equal(typeof user!.content, "string");
	return { system: system!.content as string, user: user!.content as string };
}

/** Anthropic Messages 把系统提示放在独立字段，messages 只保留一条 user 消息。 */
export function anthropicMessage(body: AnyRecord): { system: string; message: string } {
	const system = body.system;
	assert.ok(Array.isArray(system) && system.length === 1, "Anthropic 请求必须在 system 字段携带分类器提示");
	const messages = body.messages;
	assert.ok(Array.isArray(messages) && messages.length === 1, "聊天通道只允许一条 user 消息");
	const message = messages[0] as AnyRecord;
	assert.equal(message.role, "user");
	assert.ok(Array.isArray(message.content));
	return {
		system: String((system[0] as AnyRecord).text),
		message: message.content.map(part => String((part as AnyRecord).text ?? "")).join(""),
	};
}

function selectionFormat(questions: ChatQuestions): AnyRecord {
	return {
		type: "json_schema", name: "delegation_selection", strict: true,
		schema: {
			type: "object", properties: {
				kind: { type: "string", enum: Object.keys(questions.kind!.criteria) },
				selection: { type: "string", enum: Object.keys(questions.selection!.criteria) },
			}, required: ["kind", "selection"], additionalProperties: false,
		},
	};
}

/** Chat Completions 把严格 schema 嵌在 response_format.json_schema 下，不带 Responses 的 type 包裹。 */
function chatSchema(questions: ChatQuestions): AnyRecord {
	const { type: _type, ...schema } = selectionFormat(questions);
	return schema;
}

/** 混元 Chat Completions：显式 no_think、1024 上限与严格 response_format，不带工具。 */
export function assertHunyuanLane(body: AnyRecord, questions: ChatQuestions): void {
	assert.equal(body.model, HUNYUAN_ID, "primary 固定使用混元");
	assert.equal(body.stream, true);
	assert.equal(body.max_tokens, 1_024, "回答上限 1024，思考由 no_think 关闭");
	assert.equal(body.reasoning_effort, "no_think", "混元必须显式关闭思考");
	assert.equal(body.tools, undefined, "聊天选型不注入任何工具");
	assert.equal(body.input, undefined, "不得把 Responses 的 input 发给 Chat Completions");
	assert.deepEqual(body.response_format, { type: "json_schema", json_schema: chatSchema(questions) },
		"混元的严格 schema 必须到达实际 HTTP 请求，且枚举与本次分类问题一致");
}

/** DeepSeek Responses 后备：低思考档、1024 上限、严格 schema，不带工具。 */
export function assertResponsesLane(body: AnyRecord, questions: ChatQuestions): void {
	assert.equal(body.model, DEEPSEEK_ID, "后备固定使用 DeepSeek，不因候选排序改用其它模型");
	const configurationUpdates = (body.input as AnyRecord[]).filter(item => item.type === "configuration_update");
	assert.deepEqual(configurationUpdates, [], "DeepSeek 不追加 Luna 专用的 reasoning 配置更新");
	assert.deepEqual([(body.reasoning as AnyRecord).effort, body.max_output_tokens, body.stream, body.tools ?? []],
		["low", 1024, true, []], "DeepSeek 固定低思考档与 1024 上限，不带本地工具或内置搜索");
	assert.deepEqual(body.text, { format: selectionFormat(questions) },
		"DeepSeek 的严格 schema 必须到达实际 HTTP 请求，且枚举与本次分类问题一致");
}

/** GLM Flash 后备（Anthropic Messages）：adaptive + effort low，JSON 只由提示约束并在本地校验。 */
export function assertGlmLane(body: AnyRecord, questions: ChatQuestions): void {
	assert.equal(body.model, GLM_ID);
	assert.equal(body.stream, true);
	assert.equal(body.max_tokens, 1_024, "1024 回答上限原样上线，远低于目录上限");
	assert.equal((body.thinking as AnyRecord).type, "adaptive", "仅 GLM 的 Anthropic 策略开启自适应思考");
	assert.equal(Object.hasOwn(body.thinking as AnyRecord, "budget_tokens"), false, "自适应思考不追加思考预算");
	assert.deepEqual(body.output_config, { effort: "low" });
	assert.equal(body.text, undefined, "anthropic-messages 不发送 Responses 的 text.format");
	assert.equal(body.response_format, undefined, "不额外引入 Chat 的 schema 强制能力");
	assert.equal(body.reasoning_effort, undefined, "不发送 Chat 的 reasoning_effort");
	assert.equal(body.tool_stream, undefined, "不发送 GLM Chat 的 tool_stream");
	assert.equal(body.tools, undefined, "聊天选型不注入任何工具");
	assert.ok(Object.keys(questions).length > 0);
}

/** 合成 Chat Completions 流：文本结果与其它通道相同的 12/3 用量。 */
export function chatCompletionSse(text: string): Response {
	const chunks = [
		{ id: "chatcmpl_fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
		{ id: "chatcmpl_fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: CHAT_TOKENS.input, completion_tokens: CHAT_TOKENS.output,
				total_tokens: CHAT_TOKENS.total } },
	];
	return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream" } });
}

/** 合成 Anthropic Messages 流：文本结果与 Responses 通道相同的 12/3 用量。 */
export function anthropicSelectionSse(text: string): Response {
	const frames = [
		{ type: "message_start", message: { id: "msg_glm_lane", type: "message", role: "assistant",
			model: GLM_ID, content: [], stop_reason: null, stop_sequence: null,
			usage: { input_tokens: CHAT_TOKENS.input, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: CHAT_TOKENS.output } },
		{ type: "message_stop" },
	];
	return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } });
}

/** chatModels 必须按实际发起顺序列全通道；chatModel 仍是其中首个发起者，兼容旧 trace。 */
export function assertChatModels(decision: AnyRecord, lanes: readonly ChatLane[]): void {
	assert.deepEqual(decision.chatModels, lanes.map(laneModel), "chatModels 必须按实际请求顺序记录全部通道");
	assert.equal(decision.chatModel, lanes.length ? laneModel(lanes[0]!) : undefined,
		"chatModel 保持首个实际发起的聊天模型");
	assert.equal(decision.classifier, undefined, "委派选型已移除原生分类通道，不再记录 classifier");
}

export interface SelectionErrorEntry {
	source: { type: "chat"; model: string };
	failureKind: string;
	reason: string;
	statusCode?: number;
}

/**
 * 逐路错误只能来自已发起且已返回的通道：缺席、未发起和竞速取消的落败通道都不得出现。
 * 摘要最多给出模型、失败类型与 HTTP 码，不能携带上游正文或凭据。
 */
export function selectionErrors(decision: AnyRecord): SelectionErrorEntry[] {
	const errors = decision.selectionErrors;
	assert.ok(Array.isArray(errors), "失败 trace 必须带 selectionErrors 数组");
	return errors as SelectionErrorEntry[];
}

export function assertNoUpstreamLeak(serialized: string): void {
	for (const secret of [CHAT_SECRET, TEST_KEY])
		assert.equal(serialized.includes(secret), false, "不得泄露上游正文或凭据");
}

export function assertNoSelectionErrors(decision: AnyRecord): void {
	const value = decision.selectionErrors;
	assert.ok(value === undefined || (Array.isArray(value) && value.length === 0),
		"被取消或未发起的通道不得计入逐路错误");
}

/** 单路聊天通道已报告用量按各自目录价折算，用于逐路核对累计结果。 */
export function laneCost(runtime: ModelRuntime, lane: ChatLane): { input: number; output: number } {
	const model = runtime.getModel("tsgw", lane);
	assert.ok(typeof model?.cost?.input === "number" && typeof model.cost.output === "number",
		`${lane} 目录价必须可用`);
	return { input: CHAT_TOKENS.input / 1_000_000 * model.cost.input,
		output: CHAT_TOKENS.output / 1_000_000 * model.cost.output };
}

/**
 * 选型请求的 HTTP 夹具：混元先单独请求；失败/缺席后两条后备共享到达屏障并发，
 * 每路独立决定返回有效、非法、错误或挂起；混元成功时两条后备根本不发。
 */
export function createLaneHarness(options: LaneHarnessOptions): LaneHarness {
	const { guardedFetch, plan } = options;
	const mainRequests: AnyRecord[] = [];
	const hunyuanRequests: LaneRequest[] = [];
	const fallbackRequests: LaneHarness["fallbackRequests"] = { [DEEPSEEK_ID]: [], [GLM_ID]: [] };
	const systemoneRequests: AnyRecord[] = [];
	let hunyuanMode: HunyuanMode = "error";
	const fallbackModes = { [DEEPSEEK_ID]: "error", [GLM_ID]: "error" } as Record<FallbackLane, FallbackMode>;
	const state = { hunyuanAborted: false, fallbackAborted: {
		[DEEPSEEK_ID]: false, [GLM_ID]: false } as Record<FallbackLane, boolean> };
	let selection = "";
	let errorDrainsExpected = 0, errorDrains = 0, markErrorsDrained: (() => void) | undefined;
	let errorsDrained: Promise<void> | undefined;
	let cross = makeCrossGate(FALLBACK_IDS.length);
	const track = (response: Response): Response => errorDrainsExpected === 0 ? response
		: trackedResponse(response, () => {
			if (++errorDrains >= errorDrainsExpected) markErrorsDrained?.();
		});
	const answer = (mode: "select" | "invalid", lane: ChatLane): Response => {
		const choice = mode === "invalid" ? "option_999" : selection;
		const text = JSON.stringify({ kind: "implement", selection: choice });
		if (lane === GLM_ID) return anthropicSelectionSse(text);
		if (lane === HUNYUAN_ID) return chatCompletionSse(text);
		return textSse(text);
	};
	const errorResponse = (lane: ChatLane): Response =>
		Response.json({ error: { message: `synthetic ${lane} failure: ${CHAT_SECRET}` } }, { status: LANE_HTTP });
	const respondHunyuan = async (signal: AbortSignal | null | undefined): Promise<Response> => {
		if (hunyuanMode === "hang") {
			state.hunyuanAborted = await abortNotice(signal, HUNYUAN_WINDOW_MS + 10_000);
			return Response.json({ error: { message: `synthetic cancelled ${HUNYUAN_ID}` } }, { status: 499 });
		}
		if (hunyuanMode === "error") return track(errorResponse(HUNYUAN_ID));
		if (hunyuanMode === "invalid") return track(answer("invalid", HUNYUAN_ID));
		return answer("select", HUNYUAN_ID);
	};
	const respondFallback = async (lane: FallbackLane,
		signal: AbortSignal | null | undefined): Promise<Response> => {
		// 两条后备必须同时到达；串行实现会因屏障超时直接失败，而不是悄悄通过。
		await cross.arrive();
		const mode = fallbackModes[lane];
		if (mode === "hang") {
			state.fallbackAborted[lane] = await abortNotice(signal);
			return Response.json({ error: { message: `synthetic cancelled ${lane}` } }, { status: 499 });
		}
		if (mode === "after-errors") {
			await errorsDrained;
			await drainTurns();
		}
		if (mode === "error") return track(errorResponse(lane));
		if (mode === "invalid") return track(answer("invalid", lane));
		return answer("select", lane);
	};
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const signal = init?.signal ?? request.signal;
		const url = new URL(request.url);
		if (url.origin !== TEST_ROOT) return guardedFetch(request);
		if (url.pathname === HUNYUAN_PATH) {
			assert.equal(request.method, "POST");
			assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
			const body = await request.clone().json() as AnyRecord;
			hunyuanRequests.push({ body, headers: request.headers, at: Date.now() });
			assert.equal(body.model, HUNYUAN_ID, `混元路径只允许混元自身，收到 ${String(body.model)}`);
			return respondHunyuan(signal);
		}
		if (url.pathname === GLM_PATH) {
			assert.equal(request.method, "POST");
			assert.equal(request.headers.get("x-api-key"), TEST_KEY, "Anthropic Messages 通道使用 x-api-key");
			const body = await request.clone().json() as AnyRecord;
			fallbackRequests[GLM_ID].push({ body, headers: request.headers, at: Date.now() });
			assert.equal(body.model, GLM_ID, `Anthropic 路径只允许 GLM，收到 ${String(body.model)}`);
			return respondFallback(GLM_ID, signal);
		}
		if (url.pathname === "/v1/responses") {
			const body = await request.clone().json() as AnyRecord;
			if (body.model === MAIN_MODEL_ID) {
				mainRequests.push(body);
				const call = plan.next;
				plan.next = undefined;
				return call ? toolCallSse(call) : textSse("fixture main reply");
			}
			assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
			fallbackRequests[DEEPSEEK_ID].push({ body, headers: request.headers, at: Date.now() });
			assert.equal(body.model, DEEPSEEK_ID, `Responses 路径除主模型外只允许 DeepSeek，收到 ${String(body.model)}`);
			return respondFallback(DEEPSEEK_ID, signal);
		}
		if (url.pathname === "/v1/systemone") {
			const body = await request.clone().json() as AnyRecord;
			systemoneRequests.push(body);
			throw new Error("委派选型不应再请求原生分类通道");
		}
		return guardedFetch(request);
	};
	return {
		mainRequests, hunyuanRequests, fallbackRequests, systemoneRequests,
		fetch: fetchImpl,
		get hunyuanAborted() { return state.hunyuanAborted; },
		get fallbackAborted() { return state.fallbackAborted; },
		laneCounts: () => [hunyuanRequests.length, fallbackRequests[DEEPSEEK_ID].length, fallbackRequests[GLM_ID].length],
		drainedErrors: () => errorDrains,
		expectSelection: (key: string) => { selection = key; },
		arrange: options => {
			hunyuanMode = options.hunyuan;
			state.hunyuanAborted = false;
			for (const lane of FALLBACK_IDS) {
				fallbackModes[lane] = options[lane === DEEPSEEK_ID ? "deepseek" : "glm"] ?? "error";
				state.fallbackAborted[lane] = false;
			}
			cross = makeCrossGate(options.expectedFallbacks ?? FALLBACK_IDS.length);
			errorDrainsExpected = options.holdReturned ?? 0;
			errorDrains = 0;
			errorsDrained = undefined;
			if (errorDrainsExpected > 0)
				errorsDrained = new Promise<void>(resolve => { markErrorsDrained = resolve; });
		},
	};
}
