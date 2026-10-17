import assert from "node:assert/strict";
import test from "node:test";
import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
} from "@earendil-works/pi-ai";
import { classify } from "./adapter.ts";
import {
	CLASSIFIER_API,
	CLASSIFIER_MODEL_IDS,
	classifierModelsForRoot,
} from "./models.ts";

const root = "https://classifiers.example.test/gateway";
const KEY = "fake-classifier-api-key";
const PROMPT = "private-classifier-state";
// 测试进程禁止意外出网；成功路径也必须显式传入 mock fetch。
globalThis.fetch = async () => {
	throw new Error("测试禁止真实网络");
};

function model(id: string = CLASSIFIER_MODEL_IDS[0]): ClassifierModel<ClassifierApi> {
	const config = classifierModelsForRoot(root).find((entry) => entry.id === id);
	if (!config) throw new Error(`缺少测试分类模型 ${id}`);
	return {
		type: "classifier",
		id: config.id,
		name: config.name,
		api: CLASSIFIER_API,
		provider: "tsgw",
		baseUrl: config.baseUrl ?? `${root}/v1`,
		input: config.input,
		cost: config.cost,
		contextWindow: config.contextWindow,
	};
}

const context = (): ClassifierContext => ({
	state: { message: "The change works, thanks.", score: 3 },
	questions: {
		category: {
			type: "choice",
			instructions: "Classify the message.",
			criteria: { approval: "The user approves", correction: "The user requests a correction" },
		},
		satisfaction: {
			type: "score",
			instructions: "Score satisfaction.",
			criteria: ["dissatisfied", "neutral", "satisfied"],
		},
		approved: {
			type: "bool",
			instructions: "Does the user approve?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
});

const reply = (extra: Record<string, unknown> = {}) => ({
	answers: {
		category: {
			type: "choice",
			choice: "approval",
			probabilities: { approval: 0.9, correction: 0.1 },
			confidence: 0.91,
		},
		satisfaction: { type: "score", score: 2, confidence: 0.82 },
		approved: { type: "noul", noul: 0.75 },
	},
	usage: { input_tokens: 100, output_tokens: 50 },
	...extra,
});

const jsonResponse = (raw: unknown = reply(), init: ResponseInit = {}) =>
	new Response(JSON.stringify(raw), init);

function mockFetch(respond: (init: RequestInit) => Response | Promise<Response> = () => jsonResponse()) {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetch: typeof globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init: init ?? {} });
		return respond(init ?? {});
	};
	return { calls, fetch };
}

function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}

await test("两款分类 ID：System One 三题映射、认证、冻结输入与 usage", async () => {
	for (const id of CLASSIFIER_MODEL_IDS) {
		const selected = frozen(model(id));
		const ctx = frozen(context());
		const snapshot = JSON.stringify(ctx);
		const h = mockFetch();
		const options = frozen({ apiKey: KEY, fetch: h.fetch, maxRetries: 9, timeoutMs: 5_000, temperature: 1.25 });
		const result = await classify(selected, ctx, options);

		assert.equal(result.stopReason, "stop");
		assert.equal(result.api, CLASSIFIER_API);
		assert.equal(result.provider, "tsgw");
		assert.equal(result.model, id);
		assert.ok(Number.isFinite(result.timestamp));
		assert.deepEqual(result.answers, {
			category: {
				type: "choice",
				choice: "approval",
				probabilities: { approval: 0.9, correction: 0.1 },
				confidence: 0.91,
			},
			satisfaction: { type: "score", score: 2, confidence: 0.82 },
			approved: { type: "bool", probability: 0.75 },
		});
		assert.ok(result.usage);
		assert.deepEqual(
			{ input: result.usage.input, output: result.usage.output, cacheRead: result.usage.cacheRead,
				cacheWrite: result.usage.cacheWrite, totalTokens: result.usage.totalTokens },
			{ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
		);
		assert.ok(Math.abs(result.usage.cost.input - 100 * 0.042 / 1_000_000) < 1e-15);
		assert.equal(result.usage.cost.output, 0);
		assert.ok(Math.abs(result.usage.cost.total - 100 * 0.042 / 1_000_000) < 1e-15);
		assert.equal(JSON.stringify(ctx), snapshot, "不得改写冻结的 state 或 questions");
		assert.equal(options.maxRetries, 9, "不得改写调用方 options");

		assert.equal(h.calls.length, 1);
		const { url, init } = h.calls[0];
		assert.equal(url, `${root}/v1/systemone`);
		assert.equal(init.method, "POST");
		assert.ok(init.signal instanceof AbortSignal);
		const headers = new Headers(init.headers);
		assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
		assert.equal(headers.get("content-type"), "application/json");
		assert.deepEqual(JSON.parse(String(init.body)), {
			model: id,
			state: { message: "The change works, thanks.", score: 3 },
			questions: {
				category: {
					type: "choice",
					instructions: "Classify the message.",
					criteria: { approval: "The user approves", correction: "The user requests a correction" },
				},
				satisfaction: {
					type: "score",
					instructions: "Score satisfaction.",
					criteria: ["dissatisfied", "neutral", "satisfied"],
				},
				approved: {
					type: "noul",
					instructions: "Does the user approve?",
					criteria: { true: "Approval", false: "No approval" },
				},
			},
		});
	}
});

await test("payload/response 钩子收到原模型，替换 payload 后仍固定模型与三题", async () => {
	const selected = frozen(model());
	const ctx = frozen(context());
	let payloadHook = false;
	let responseHook = false;
	const h = mockFetch(() => jsonResponse(reply(), { headers: { "X-Request-ID": "classifier-request-1" } }));
	const result = await classify(selected, ctx, {
		apiKey: KEY,
		fetch: h.fetch,
		onPayload: async (payload, actual) => {
			payloadHook = true;
			assert.equal(actual, selected);
			assert.equal(h.calls.length, 0, "payload 钩子必须先于 HTTP 请求");
			return frozen({ ...payload as object, diagnostics: { keep: true } });
		},
		onResponse: async (response, actual) => {
			responseHook = true;
			assert.equal(payloadHook, true);
			assert.equal(actual, selected);
			assert.equal(response.status, 200);
			assert.equal(response.headers["x-request-id"], "classifier-request-1");
			assert.equal(response.headers instanceof Headers, false);
		},
	});
	assert.equal(result.stopReason, "stop");
	assert.equal(payloadHook, true);
	assert.equal(responseHook, true);
	const body = JSON.parse(String(h.calls[0].init.body));
	assert.equal(body.model, selected.id);
	assert.deepEqual(body.diagnostics, { keep: true });
	assert.equal(body.questions.approved.type, "noul");
	assert.equal(ctx.questions.approved.type, "bool", "公开问题保持 bool，源 context 不被改写");
});

await test("认证头：Bearer 默认、模型头覆盖、options 覆盖与 null 抑制", async () => {
	const selected = frozen({ ...model(), headers: { Authorization: "model-auth", "X-Model": "model" } });
	const defaults = mockFetch();
	await classify(selected, frozen(context()), { apiKey: KEY, fetch: defaults.fetch });
	const defaultHeaders = new Headers(defaults.calls[0].init.headers);
	assert.equal(defaultHeaders.get("authorization"), "model-auth");
	assert.equal(defaultHeaders.get("content-type"), "application/json");
	assert.equal(defaultHeaders.get("x-model"), "model");

	const overridden = mockFetch();
	await classify(selected, frozen(context()), {
		apiKey: KEY,
		fetch: overridden.fetch,
		headers: frozen({ authorization: "option-auth", "CONTENT-TYPE": null, "X-MODEL": null, "X-Extra": "extra" }),
	});
	const overrideHeaders = new Headers(overridden.calls[0].init.headers);
	assert.equal(overrideHeaders.get("authorization"), "option-auth");
	assert.equal(overrideHeaders.get("content-type"), null);
	assert.equal(overrideHeaders.get("x-model"), null);
	assert.equal(overrideHeaders.get("x-extra"), "extra");

	const suppressed = mockFetch();
	await classify(model(), frozen(context()), {
		apiKey: KEY,
		fetch: suppressed.fetch,
		headers: { Authorization: null },
	});
	assert.equal(new Headers(suppressed.calls[0].init.headers).has("authorization"), false);

	for (const headers of [undefined, { authorization: "explicit" }]) {
		const h = mockFetch();
		const result = await classify(model(), frozen(context()), {
			...(headers === undefined ? {} : { headers }),
			fetch: h.fetch,
		});
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /认证/);
		assert.equal(h.calls.length, 0, "缺少 apiKey 时不发请求");
	}
});

await test("取消：预取消不发请求，进行中取消映射为 aborted；timeout 映射为安全错误", async () => {
	const before = new AbortController();
	before.abort(new Error(KEY));
	const pre = mockFetch();
	const preResult = await classify(model(), frozen(context()), { apiKey: KEY, fetch: pre.fetch, signal: before.signal });
	assert.equal(preResult.stopReason, "aborted");
	assert.match(preResult.errorMessage ?? "", /已取消/);
	assert.equal(pre.calls.length, 0);

	const caller = new AbortController();
	let entered!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const hanging = mockFetch((init) => new Promise<Response>((_resolve, reject) => {
		const signal = init.signal;
		entered();
		if (!signal) { reject(new Error("mock fetch 缺少 signal")); return; }
		const abort = () => reject(signal.reason ?? new Error("aborted"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	}));
	const pending = classify(model(), frozen(context()), { apiKey: KEY, fetch: hanging.fetch, signal: caller.signal });
	await started;
	caller.abort(new Error("test abort"));
	const aborted = await pending;
	assert.equal(aborted.stopReason, "aborted");
	assert.match(aborted.errorMessage ?? "", /已取消/);
	assert.equal(hanging.calls.length, 1);

	const timed = mockFetch((init) => new Promise<Response>((_resolve, reject) => {
		const signal = init.signal;
		if (!signal) { reject(new Error("mock fetch 缺少 signal")); return; }
		const abort = () => reject(signal.reason ?? new Error("timeout"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	}));
	// AbortSignal.timeout 的内部定时器不维持事件循环；测试用自己的句柄等待它触发。
	const hold = setTimeout(() => {}, 1_000);
	try {
		const timeoutResult = await classify(model(), frozen(context()), { apiKey: KEY, fetch: timed.fetch, timeoutMs: 20 });
		assert.equal(timeoutResult.stopReason, "error");
		assert.match(timeoutResult.errorMessage ?? "", /超时/);
		assert.equal(timed.calls.length, 1);
	} finally {
		clearTimeout(hold);
	}
});

await test("HTTP 500 始终恰好一次；上游正文和凭据不进入安全 error", async () => {
	for (const maxRetries of [undefined, 9]) {
		const h = mockFetch(() => new Response(`${KEY} ${PROMPT} https://private.example/raw`, { status: 500 }));
		const result = await classify(model(), frozen(context()), {
			apiKey: KEY,
			fetch: h.fetch,
			...(maxRetries === undefined ? {} : { maxRetries }),
		});
		assert.equal(result.stopReason, "error");
		assert.equal(h.calls.length, 1, "不得自动重试，也不得自动切换模型");
		assert.match(result.errorMessage ?? "", /HTTP 500/);
		assert.doesNotMatch(result.errorMessage ?? "", new RegExp(`${KEY}|${PROMPT}|private\\.example|raw`));
	}
});

await test("宿主错误返回后迟到的取消：stopReason 与提示一致且保留 usage", async () => {
	const caller = new AbortController();
	const h = mockFetch(() => {
		const response = jsonResponse();
		// 只构造错误完成与外层 await 之间的微任务竞态，不替代宿主 classify。
		Object.defineProperty(response, "json", { value: async () => ({
			usage: { input_tokens: 7, output_tokens: 3 },
			get answers() {
				queueMicrotask(() => caller.abort(new Error(KEY)));
				return {};
			},
		}) });
		return response;
	});
	const result = await classify(model(), frozen(context()), { apiKey: KEY, fetch: h.fetch, signal: caller.signal });
	assert.equal(result.stopReason, "aborted");
	assert.match(result.errorMessage ?? "", /已取消/);
	assert.equal(result.usage?.totalTokens, 10);
	assert.equal(h.calls.length, 1);
});

await test("不支持图片；无效模型返回中文安全错误且不发请求", async () => {
	const withImage = {
		...context(),
		images: [{ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" }],
	};
	const imageFetch = mockFetch();
	const imageResult = await classify(model(), frozen(withImage), { apiKey: KEY, fetch: imageFetch.fetch });
	assert.equal(imageResult.stopReason, "error");
	assert.match(imageResult.errorMessage ?? "", /图片/);
	assert.equal(imageFetch.calls.length, 0);
	assert.doesNotMatch(imageResult.errorMessage ?? "", /private|fake-classifier/);

	const invalidFetch = mockFetch();
	const invalidResult = await classify(
		frozen({ ...model(), id: "jev-unknown" }) as ClassifierModel<ClassifierApi>,
		frozen(context()),
		{ apiKey: KEY, fetch: invalidFetch.fetch },
	);
	assert.equal(invalidResult.stopReason, "error");
	assert.match(invalidResult.errorMessage ?? "", /不支持/);
	assert.equal(invalidFetch.calls.length, 0);
});

await test("响应畸形仍保留已报告 usage；网络异常不泄漏原始消息", async () => {
	const malformed = mockFetch(() => jsonResponse({ answers: {}, usage: { input_tokens: 7, output_tokens: 3 } }));
	const malformedResult = await classify(model(), frozen(context()), { apiKey: KEY, fetch: malformed.fetch });
	assert.equal(malformedResult.stopReason, "error");
	assert.match(malformedResult.errorMessage ?? "", /无效响应/);
	assert.equal(malformedResult.usage?.input, 7);
	assert.equal(malformedResult.usage?.output, 3);
	assert.equal(malformedResult.usage?.totalTokens, 10);

	const network = mockFetch(() => {
		throw new Error(`${KEY} ${PROMPT} https://private.example/network`);
	});
	const networkResult = await classify(model(), frozen(context()), { apiKey: KEY, fetch: network.fetch });
	assert.equal(networkResult.stopReason, "error");
	assert.match(networkResult.errorMessage ?? "", /分类.*失败/);
	assert.doesNotMatch(networkResult.errorMessage ?? "", new RegExp(`${KEY}|${PROMPT}|private\\.example`));
	assert.equal(network.calls.length, 1);
});
