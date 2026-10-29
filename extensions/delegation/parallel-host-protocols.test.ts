import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import { makeGate, textSse, toolCallSse, type AnyRecord } from "./host-test-fixtures.test.ts";

export const MAIN_MODEL_ID = "gpt-6-sol";
export const LUNA_ID = "gpt-6-luna";
export const DEEPSEEK_ID = "deepseek-flash";
export const MINIMAX_ID = "MiniMax-M3.1-Flash";
/** MiniMax 走 Anthropic Messages，请求路径与 Responses 通道不同。 */
export const MINIMAX_PATH = "/anthropic/v1/messages";
export const CLASSIFIER_IDS = ["jev-latest", "jev-preview"] as const;
/** 三款聊天通道的约定发起顺序；chatModel 记录其中首个实际发起者。 */
export const CHAT_LANE_IDS = [LUNA_ID, DEEPSEEK_ID, MINIMAX_ID] as const;
export type ChatLane = (typeof CHAT_LANE_IDS)[number];
export type ClassifierMode = "error" | "select" | "hang" | "after-errors";
/** after-errors：等到此前各路的错误响应已被宿主消费后再提交结果，用于确定“先报错、后胜出”的顺序。 */
export type LaneMode = "select" | "invalid" | "error" | "hang" | "after-errors";

// 上游正文只用于确认不泄露，不应出现在结果、文本、details 或错误摘要中。
export const CLASSIFIER_SECRET = "CLASSIFIER-UPSTREAM-BALANCE-DETAIL";
export const CHAT_SECRET = "LANE-UPSTREAM-FAILURE-DETAIL";
// 合成用量：夹具 Agent 10/2、每款聊天通道 12/3、系统一分类 20/5；屏障与取消观察都设上限，串行实现快速失败。
export const AGENT_TOKENS = { input: 10, output: 2, total: 12 };
export const CHAT_TOKENS = { input: 12, output: 3, total: 15 };
export const CLASSIFIER_TOKENS = { input: 20, output: 5, total: 25 };
/** 原生分类 402、聊天通道 500 进入安全摘要；夹具的 499 仅用于观察取消，不应入册。 */
export const LANES_HTTP = { classifier: 402, lane: 500 } as const;
/**
 * MiniMax 的 ANTHROPIC_COMPAT 声明 forceAdaptiveThinking，宿主走 effort 路径而不追加思考预算，
 * 因此 1024 的回答上限原样上线，而不是目录上限 524288。
 */
export const MINIMAX_MAX_TOKENS = 1_024;
export const PARALLEL_TIMEOUT_MS = 3_000;
export const ABORT_TIMEOUT_MS = 5_000;

export type ChatQuestions = Record<string, { criteria: Record<string, string> }>;
export interface RacePlan { next?: { name: string; args: AnyRecord; callId: string; itemId: string } }
export interface LaneHarnessOptions {
	sandbox: { catalogIds: string[] };
	catalog: readonly string[];
	guardedFetch: typeof fetch;
	plan: RacePlan;
	refreshCatalog: () => Promise<void>;
}
export interface LaneHarness {
	classifierRequests: AnyRecord[];
	classifierHeaders: Headers[];
	mainRequests: AnyRecord[];
	laneRequests: Record<ChatLane, Array<{ body: AnyRecord; headers: Headers }>>;
	fetch: typeof fetch;
	/** 原生分类也支持 after-errors，用于让非法结果先于原生胜出落地。 */
	arrange(options: { classifier: ClassifierMode; lanes?: Partial<Record<ChatLane, LaneMode>>; holdReturned?: number }): void;
	/** 指定通道在返回答案前触发目录变化，用于胜出后复核场景。 */
	dropAfterWin(modelId: string): void;
	/** 三款聊天通道已返回并被宿主消费的次数，用于确认没有额外重试。 */
	laneCounts(): number[];
	expectSelection(key: string): void;
	/** holdReturned 模式下已被宿主读完的落败响应数，用于验证“先报错或非法、后胜出”确实发生。 */
	drainedErrors(): number;
	readonly classifierAborted: boolean;
	readonly laneAborted: Record<ChatLane, boolean>;
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

/** HTTP 级同步屏障：全部选型请求都到达后才释放，串行实现无法通过。 */
export function makeCrossGate(expected: number) {
	const gate = makeGate();
	let arrived = 0;
	return {
		arrive: (): Promise<void> => {
			if (++arrived >= expected) gate.open();
			return withTimeout(gate.promise, PARALLEL_TIMEOUT_MS,
				`等待 ${expected} 路选型请求同时到达超时（疑似仍是串行执行）`);
		},
	};
}

/** 只观察胜出后是否主动取消落败通道，不依赖真实耗时或 sleep。 */
export function abortNotice(signal: AbortSignal | null | undefined): Promise<boolean> {
	if (!signal || signal.aborted) return Promise.resolve(signal?.aborted === true);
	return new Promise<boolean>(resolve => {
		const timer = setTimeout(() => resolve(false), ABORT_TIMEOUT_MS);
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
	assert.deepEqual(input.map(item => (item as AnyRecord).role), [instructionRole, "user"],
		"聊天通道只允许分类器系统提示与原分类材料，不携带会话历史或工具结果");
	const message = input[1] as AnyRecord;
	if (typeof message.content === "string") return message.content;
	assert.ok(Array.isArray(message.content));
	return message.content.map(part => String((part as AnyRecord).text ?? "")).join("");
}

export function chatSystemPrompt(body: AnyRecord): string {
	const input = body.input;
	assert.ok(Array.isArray(input) && input.length > 0);
	const system = input[0] as AnyRecord;
	assert.equal(system.role, "developer");
	assert.ok(typeof system.content === "string");
	return system.content as string;
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

/** System One 成功响应；答案 key 必须落在本次问题枚举内，用量按分类模型目录价计费。 */
export function classifierResponse(body: AnyRecord, kind: string, selection: string): Response {
	const questions = body.questions as Record<string, AnyRecord>;
	const answers: AnyRecord = {};
	for (const [id, question] of Object.entries(questions)) {
		const choice = id === "kind" ? kind : selection;
		assert.ok(Object.hasOwn(question.criteria as AnyRecord, choice), `${id} 的答案必须在本次候选枚举内`);
		answers[id] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
	}
	return Response.json({ model: body.model, answers,
		usage: { input_tokens: CLASSIFIER_TOKENS.input, output_tokens: CLASSIFIER_TOKENS.output } });
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

/** Responses 聊天通道（Luna/DeepSeek）：低思考档、1024 上限、严格 schema，不带工具。 */
export function assertResponsesLane(body: AnyRecord, lane: ChatLane, questions: ChatQuestions): void {
	assert.equal(body.model, lane, `固定使用 ${lane}，不因候选排序改用其它模型`);
	assert.deepEqual([(body.reasoning as AnyRecord).effort, body.max_output_tokens, body.stream, body.tools ?? []],
		["low", 1024, true, []], `${lane} 固定低思考档与 1024 上限，不带本地工具或内置搜索`);
	const text = body.text as AnyRecord;
	if (lane === LUNA_ID) assert.equal(text.verbosity, "low", "Luna 保留 Responses 的 verbosity low");
	assert.deepEqual(text.format, selectionFormat(questions),
		`${lane} 的严格 schema 必须到达实际 HTTP 请求，且枚举与本次分类问题一致`);
}

/** MiniMax 聊天通道（Anthropic Messages）：只用 minimaxThinking 策略，不发 Responses 的 text.format。 */
export function assertMiniMaxLane(body: AnyRecord, questions: ChatQuestions): void {
	assert.equal(body.model, MINIMAX_ID);
	assert.equal(body.stream, true);
	assert.equal(body.max_tokens, MINIMAX_MAX_TOKENS, "1024 回答上限原样上线，远低于目录上限");
	assert.equal((body.thinking as AnyRecord).type, "adaptive", "仅 minimaxThinking 策略开启自适应思考");
	assert.equal((body.output_config as AnyRecord).effort, "low");
	assert.equal(body.text, undefined, "anthropic-messages 不发送 Responses 的 text.format");
	assert.equal(body.response_format, undefined, "不额外引入 schema 强制能力");
	assert.equal(body.tools, undefined, "聊天选型不注入任何工具");
	assert.equal(JSON.stringify(body).includes('"format"'), false, "Anthropic 请求体不得夹带 Responses 格式约束");
	assert.ok(Object.keys(questions).length > 0);
}

/** 合成 Anthropic Messages 流：文本结果与 Luna/DeepSeek 通道相同的 12/3 用量。 */
export function anthropicSelectionSse(text: string): Response {
	const frames = [
		{ type: "message_start", message: { id: "msg_minimax_lane", type: "message", role: "assistant",
			model: MINIMAX_ID, content: [], stop_reason: null, stop_sequence: null,
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

/** chatModels 必须列全实际发起的聊天通道；chatModel 仍是其中首个发起者，兼容旧 trace。 */
export function assertChatModels(decision: AnyRecord, lanes: readonly ChatLane[]): void {
	const chatModels = decision.chatModels as string[] | undefined;
	assert.deepEqual([...(chatModels ?? [])].sort(), lanes.map(laneModel).sort(),
		"chatModels 必须记录全部实际发起的聊天模型");
	assert.equal(decision.chatModel, chatModels?.[0], "chatModel 保持首个实际发起的聊天模型");
	if (lanes.includes(LUNA_ID)) assert.equal(decision.chatModel, laneModel(LUNA_ID),
		"Luna 是约定的首个聊天通道，旧 trace 字段保持稳定");
}

export interface SelectionErrorEntry {
	source: { type: "classifier" | "chat"; model: string };
	failureKind: string;
	reason: string;
	statusCode?: number;
}

/**
 * 逐路错误只能来自已发起的通道：缺席、未发起和竞速取消的落败通道都不得出现。
 * 摘要最多给出模型、失败类型与 HTTP 码，不能携带上游正文或凭据。
 */
export function selectionErrors(decision: AnyRecord): SelectionErrorEntry[] {
	const errors = decision.selectionErrors;
	assert.ok(Array.isArray(errors), "失败 trace 必须带 selectionErrors 数组");
	return errors as SelectionErrorEntry[];
}

export function assertNoUpstreamLeak(serialized: string): void {
	for (const secret of [CLASSIFIER_SECRET, CHAT_SECRET, TEST_KEY])
		assert.equal(serialized.includes(secret), false, "不得泄露上游正文或凭据");
}

export function assertNoSelectionErrors(decision: AnyRecord): void {
	const value = decision.selectionErrors;
	assert.ok(value === undefined || (Array.isArray(value) && value.length === 0),
		"被竞速取消或未发起的通道不得计入逐路错误");
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
 * 选型请求的 HTTP 夹具：四路各一次，共享到达屏障；每路独立决定返回有效、非法、错误或挂起。
 * holdReturned 时只有前若干条错误响应被宿主读完后，after-errors 通道才提交结果。
 */
export function createLaneHarness(options: LaneHarnessOptions): LaneHarness {
	const { sandbox, catalog, guardedFetch, plan } = options;
	const classifierRequests: AnyRecord[] = [];
	const classifierHeaders: Headers[] = [];
	const mainRequests: AnyRecord[] = [];
	const laneRequests = Object.fromEntries(CHAT_LANE_IDS.map(lane => [lane, []])) as
		unknown as Record<ChatLane, Array<{ body: AnyRecord; headers: Headers }>>;
	let classifierMode: ClassifierMode = "error";
	const laneMode = Object.fromEntries(CHAT_LANE_IDS.map(lane => [lane, "error"])) as
		unknown as Record<ChatLane, LaneMode>;
	const state = { classifierAborted: false, laneAborted: Object.fromEntries(
		CHAT_LANE_IDS.map(lane => [lane, false])) as unknown as Record<ChatLane, boolean> };
	let selection = "";
	let dropCatalog: string | undefined;
	let errorDrainsExpected = 0, errorDrains = 0, markErrorsDrained: (() => void) | undefined;
	let errorsDrained: Promise<void> | undefined;
	const presentLanes = (): ChatLane[] => CHAT_LANE_IDS.filter(id => sandbox.catalogIds.includes(id));
	let cross = makeCrossGate(1);
	const track = (response: Response): Response => errorDrainsExpected === 0 ? response
		: trackedResponse(response, () => {
			if (++errorDrains >= errorDrainsExpected) markErrorsDrained?.();
		});
	const answer = (mode: LaneMode, lane: ChatLane): Response => {
		const choice = mode === "invalid" ? "option_999" : selection;
		const body = JSON.stringify({ kind: "implement", selection: choice });
		return lane === MINIMAX_ID ? anthropicSelectionSse(body) : textSse(body);
	};
	const respondLane = async (lane: ChatLane, signal: AbortSignal | null | undefined): Promise<Response> => {
		await cross.arrive();
		const mode = laneMode[lane];
		if (mode === "hang") {
			state.laneAborted[lane] = await abortNotice(signal);
			return Response.json({ error: { message: `synthetic cancelled ${lane}` } }, { status: 499 });
		}
		if (mode === "after-errors") {
			await errorsDrained;
			await drainTurns();
		}
		if (mode === "error")
			return track(Response.json({ error: { message: `synthetic ${lane} failure: ${CHAT_SECRET}` } },
				{ status: LANES_HTTP.lane }));
		if (mode === "invalid") return track(answer(mode, lane));
		if (dropCatalog) {
			sandbox.catalogIds = catalog.filter(id => id !== dropCatalog);
			dropCatalog = undefined;
			await options.refreshCatalog();
		}
		return answer(mode, lane);
	};
	const fetchImpl: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const signal = init?.signal ?? request.signal;
		const url = new URL(request.url);
		if (url.origin === TEST_ROOT && url.pathname === "/v1/systemone") {
			assert.equal(request.method, "POST");
			assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
			const body = await request.clone().json() as AnyRecord;
			classifierRequests.push(body);
			classifierHeaders.push(request.headers);
			await cross.arrive();
			if (classifierMode === "hang") {
				state.classifierAborted = await abortNotice(signal);
				return Response.json({ error: { message: "synthetic cancelled classifier" } }, { status: 499 });
			}
			if (classifierMode === "after-errors") {
				await errorsDrained;
				await drainTurns();
			}
			if (classifierMode === "select" || classifierMode === "after-errors")
				return classifierResponse(body, "implement", selection);
			// 模拟欠费：原生通道失败不影响其它路，竞速仍等首个有效结果。
			return track(Response.json(
				{ error: { message: `synthetic insufficient balance: ${CLASSIFIER_SECRET}` } },
				{ status: LANES_HTTP.classifier }));
		}
		if (url.origin === TEST_ROOT && url.pathname === MINIMAX_PATH) {
			assert.equal(request.method, "POST");
			assert.equal(request.headers.get("x-api-key"), TEST_KEY, "Anthropic Messages 通道使用 x-api-key");
			const body = await request.clone().json() as AnyRecord;
			laneRequests[MINIMAX_ID].push({ body, headers: request.headers });
			return respondLane(MINIMAX_ID, signal);
		}
		if (url.origin === TEST_ROOT && url.pathname === "/v1/responses") {
			const body = await request.clone().json() as AnyRecord;
			if (body.model === MAIN_MODEL_ID) {
				mainRequests.push(body);
				const call = plan.next;
				plan.next = undefined;
				return call ? toolCallSse(call) : textSse("fixture main reply");
			}
			assert.ok(CHAT_LANE_IDS.includes(body.model as ChatLane),
				`除三款聊天选型外只允许主模型自身的请求，收到 ${String(body.model)}`);
			assert.equal(request.headers.get("authorization"), `Bearer ${TEST_KEY}`);
			const lane = body.model as ChatLane;
			laneRequests[lane].push({ body, headers: request.headers });
			return respondLane(lane, signal);
		}
		return guardedFetch(request);
	};
	return {
		classifierRequests, classifierHeaders, mainRequests, laneRequests,
		fetch: fetchImpl,
		get classifierAborted() { return state.classifierAborted; },
		get laneAborted() { return state.laneAborted; },
		laneCounts: () => CHAT_LANE_IDS.map(lane => laneRequests[lane].length),
		drainedErrors: () => errorDrains,
		expectSelection: (key: string) => { selection = key; },
		arrange: options => {
			classifierMode = options.classifier;
			state.classifierAborted = false;
			dropCatalog = undefined;
			for (const lane of CHAT_LANE_IDS) {
				laneMode[lane] = options.lanes?.[lane] ?? "error";
				state.laneAborted[lane] = false;
			}
			cross = makeCrossGate(1 + presentLanes().length);
			errorDrainsExpected = options.holdReturned ?? 0;
			errorDrains = 0;
			errorsDrained = undefined;
			if (errorDrainsExpected > 0)
				errorsDrained = new Promise<void>(resolve => { markErrorsDrained = resolve; });
		},
		dropAfterWin: (id: string) => { dropCatalog = id; },
	};
}
