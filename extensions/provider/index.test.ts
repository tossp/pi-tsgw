import {
	deepStrictEqual,
	equal,
	match,
	rejects,
	strictEqual,
} from "node:assert";
import { randomUUID } from "node:crypto";
import registerTsgw from "../../index.ts";
import { PROVIDER_ID } from "#tsgw/models/catalog";
import { FakeContext, FakePi, createPi, createPiWithCatalog, sessionStart, agentStart, providerRequest, providerHeaders, withAgentDir, STALE_ERROR, TEST_ROOT, TSGW_SOL, TSGW_DEEPSEEK, TSGW_GLM } from "#tsgw/test-support.test";

function assertUuid(value: string | null | undefined): void {
	match(
		value ?? "",
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
}

async function testChatCompletionsCompatibility(): Promise<void> {
	const pi = await createPiWithCatalog();
	const provider = pi.providers.find(({ name }) => name === "tsgw");
	const models =
		(
			provider?.config as
				| {
						models?: Array<{
							id: string;
							api?: string;
							compat?: { supportsDeveloperRole?: boolean };
						}>;
				  }
				| undefined
		)?.models ?? [];
	const completionModels = models.filter(
		({ api }) => api === "openai-completions",
	);

	equal(completionModels.length > 0, true);
	for (const model of completionModels) {
		strictEqual(
			model.compat?.supportsDeveloperRole,
			false,
			`${model.id} 必须以 system 而非 developer 角色发送指令提示`,
		);
	}
}

async function testTsSearchRegistration(): Promise<void> {
	const pi = await createPi();
	deepStrictEqual(pi.tools.map(tool => (tool as { name: string }).name), ["upload_local_file", "tsgw_generate_image", "tsgw_edit_image", "tsgw_search"]);
}

async function testSafeProviderHooksAfterContextStales(): Promise<void> {
	const pi = await createPi({
		tsgw: { traceHeaders: true, tsSearch: "cached" },
	});
	const sessionContext = new FakeContext(TSGW_SOL, "high");
	sessionStart(pi, sessionContext);

	const firstHeaders: Record<string, string | null> = {};
	providerHeaders(pi, firstHeaders);
	const agentContext = new FakeContext(TSGW_SOL, "high");
	agentStart(pi, agentContext);
	sessionContext.makeStale();
	agentContext.makeStale();
	pi.getThinkingLevel = () => {
		throw new Error(STALE_ERROR);
	};

	deepStrictEqual(providerRequest(pi, { tools: [] }), {
		tools: [
			{
				type: "web_search",
				search_context_size: "medium",
				external_web_access: false,
			},
		],
		text: { verbosity: "low" },
	});
	const headers: Record<string, string | null> = {};
	providerHeaders(pi, headers);
	assertUuid(headers["AH-Thread-Id"]);
	assertUuid(headers["AH-Trace-Id"]);
	strictEqual(headers["AH-Thread-Id"], firstHeaders["AH-Thread-Id"]);
	if (headers["AH-Trace-Id"] === firstHeaders["AH-Trace-Id"])
		throw new Error("agent_start 必须刷新 AH-Trace-Id");

	const preserved = {
		"ah-thread-id": "keep-thread",
		"AH-Trace-Id": "keep-trace",
	};
	providerHeaders(pi, preserved);
	deepStrictEqual(preserved, {
		"ah-thread-id": "keep-thread",
		"AH-Trace-Id": "keep-trace",
	});
}

async function testLifecycleStateUpdates(): Promise<void> {
	const pi = await createPi();
	sessionStart(pi, new FakeContext(TSGW_DEEPSEEK, "high"));
	// DeepSeek Responses 的思考参数由 Pi 适配器原生处理。
	deepStrictEqual(providerRequest(pi, {}), {});

	pi.invoke("thinking_level_select", {
		type: "thinking_level_select",
		level: "off",
		previousLevel: "high",
	});
	deepStrictEqual(providerRequest(pi, {}), {});

	pi.invoke("model_select", {
		type: "model_select",
		model: TSGW_GLM,
		previousModel: TSGW_DEEPSEEK,
		source: "set",
	});
	deepStrictEqual(providerRequest(pi, { stream: true }), {
		stream: true,
		tool_stream: true,
		reasoning_effort: "none",
		thinking: { type: "disabled" },
	});

	pi.invoke("thinking_level_select", {
		type: "thinking_level_select",
		level: "high",
		previousLevel: "off",
	});
	deepStrictEqual(providerRequest(pi, { stream: true }), {
		stream: true,
		tool_stream: true,
		reasoning_effort: "high",
		thinking: { type: "enabled", clear_thinking: false },
	});

	const agentContext = new FakeContext(TSGW_DEEPSEEK, "off");
	agentStart(pi, agentContext);
	agentContext.makeStale();
	deepStrictEqual(providerRequest(pi, {}), {});
}

async function testNoStateAndTraceLimits(): Promise<void> {
	const pi = await createPi();
	const payload = { untouched: true };
	strictEqual(providerRequest(pi, payload), undefined);
	// 未启用 trace 时，不注册 before_provider_headers 钩子。
	equal(pi.has("before_provider_headers"), false);
}

async function testTraceHeaderSettings(): Promise<void> {
	const pi = await createPi({ tsgw: { traceHeaders: true } });
	equal(pi.has("before_provider_headers"), true);

	// 无 session 状态：不产生追踪头。
	const empty: Record<string, string | null> = {};
	providerHeaders(pi, empty);
	deepStrictEqual(empty, {});

	// 非 tsgw provider 不追踪。
	sessionStart(
		pi,
		new FakeContext({ ...TSGW_SOL, provider: "other" }, "high"),
	);
	const foreign: Record<string, string | null> = {};
	providerHeaders(pi, foreign);
	deepStrictEqual(foreign, {});

	// 模型 baseUrl 与配置 root 不同 host 时不追踪。
	sessionStart(
		pi,
		new FakeContext(
			{ ...TSGW_SOL, baseUrl: "https://example.test/v1" },
			"high",
		),
	);
	const otherHost: Record<string, string | null> = {};
	providerHeaders(pi, otherHost);
	deepStrictEqual(otherHost, {});

	// 匹配 host：产生追踪头。
	sessionStart(pi, new FakeContext(TSGW_SOL, "high"));
	const headers: Record<string, string | null> = {};
	providerHeaders(pi, headers);
	assertUuid(headers["AH-Thread-Id"]);
	assertUuid(headers["AH-Trace-Id"]);
}

async function testOldInstanceCallbacksKeepOwnSnapshot(): Promise<void> {
	const oldPi = await createPi({
		tsgw: { traceHeaders: true, tsSearch: "cached" },
	});
	const oldContext = new FakeContext(TSGW_SOL, "high");
	sessionStart(oldPi, oldContext);
	agentStart(oldPi, oldContext);
	oldContext.makeStale();
	oldPi.getThinkingLevel = () => {
		throw new Error(STALE_ERROR);
	};

	const newPi = await createPi();
	sessionStart(newPi, new FakeContext(TSGW_DEEPSEEK, "off"), "reload");

	deepStrictEqual(
		providerRequest(oldPi, { tools: [] }),
		{
			tools: [
				{
					type: "web_search",
					search_context_size: "medium",
					external_web_access: false,
				},
			],
			text: { verbosity: "low" },
		},
		"迟到的旧回调必须保留自身状态",
	);
	deepStrictEqual(
		providerRequest(newPi, {}),
		{},
		"新实例必须使用自身状态",
	);

	const headers: Record<string, string | null> = {};
	providerHeaders(oldPi, headers);
	assertUuid(headers["AH-Thread-Id"]);
	assertUuid(headers["AH-Trace-Id"]);
}

async function testSettingsConfig(): Promise<void> {
	// settings.json 中的 `tsgw.baseUrl` 决定已注册提供方的根地址。
	const piBase = await createPi({
		tsgw: { baseUrl: "https://gateway.example.net" },
	});
	const provider = piBase.providers.find(({ name }) => name === "tsgw");
	const baseUrl = (provider?.config as { baseUrl?: string } | undefined)
		?.baseUrl;
	strictEqual(baseUrl, "https://gateway.example.net/v1");

	// 缺失、旧版 off 和无效配置默认使用 live；保留已有 cached。
	for (const tsSearch of [undefined, "off", "invalid", null, false, 42, {}, "cached", "live"]) {
		const piSearch = await createPi({ tsgw: { tsSearch } });
		sessionStart(piSearch, new FakeContext(TSGW_SOL, "off"));
		deepStrictEqual(providerRequest(piSearch, { tools: [] }), {
			tools: [{ type: "web_search", search_context_size: "medium",
				external_web_access: tsSearch !== "cached" }],
			text: { verbosity: "low" },
		});
	}

	// `includeModels` 将精确匹配的模型从宽泛的 `excludeModels` 规则中恢复。
	const piFiltered = await createPiWithCatalog({
		tsgw: {
			includeModels: ["glm-5.3"],
			excludeModels: ["glm-*"],
		},
	});
	const filtered = piFiltered.providers.find(({ name }) => name === "tsgw");
	const modelIds = (
		(filtered?.config as { models?: Array<{ id: string }> } | undefined)
			?.models ?? []
	).map(({ id }) => id);
	equal(modelIds.length > 1, true);
	equal(
		modelIds.some((id) => !id.startsWith("glm-")),
		true,
	);
	equal(modelIds.includes("glm-5.3"), true);
	equal(modelIds.includes("glm-5.2"), false);

	// 忽略格式错误或缺失的 `tsgw` 命名空间。
	const piBroken = await createPi({ tsgw: "not-an-object" });
	const brokenProvider = piBroken.providers.find(({ name }) => name === "tsgw");
	const brokenBase = (
		brokenProvider?.config as { baseUrl?: string } | undefined
	)?.baseUrl;
	strictEqual(brokenBase, `${TEST_ROOT}/v1`);
}

async function testDynamicModelRefresh(): Promise<void> {
	await withAgentDir(undefined, async () => {
		const pi = new FakePi();
		await registerTsgw(pi);
		const provider = pi.providers.find(({ name }) => name === PROVIDER_ID);
		deepStrictEqual((provider?.config as { models: unknown[] }).models, [],
			"真实无凭据启动必须显式登记零模型");
		const refreshModels = (
			provider?.config as
				| {
						refreshModels?: (context: {
							credential?: { type: string; key?: string };
							allowNetwork: boolean;
							force?: boolean;
							signal: AbortSignal;
						}) => Promise<Array<{ id: string }>>;
				  }
				| undefined
		)?.refreshModels;
		if (!refreshModels) throw new Error("应提供动态模型刷新功能");

		const previousFetch = globalThis.fetch;
		let calls = 0;
		// 新策略只允许 session_start 启用网络；缺少该生命周期时 callback 保持纯本地。
		const sessionContext = {
			hasUI: false,
			model: undefined,
			thinkingLevel: "off",
			modelRegistry: {
				getProviderAuthStatus: () => ({ configured: true }),
			},
		};
		try {
			globalThis.fetch = async () => {
				calls += 1;
				return new Response(
					JSON.stringify({
						data: [{ id: "deepseek-flash" }, { id: "glm-5.2" }],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			};
			const signal = new AbortController().signal;
			const beforeStart = await refreshModels({
				credential: { type: "api_key", key: "test-key" },
				allowNetwork: true,
				signal,
			});
			deepStrictEqual(beforeStart, [], "session_start 前非 force 不得联网");
			equal(calls, 0);
			pi.invoke("session_start", { type: "session_start", reason: "startup" }, sessionContext);
			const offline = await refreshModels({ allowNetwork: false, signal });
			deepStrictEqual(offline, [], "无凭据且无匹配目录的启动不得回退静态模型");
			equal(calls, 0);

			const refreshed = await refreshModels({
				credential: { type: "api_key", key: "test-key" },
				allowNetwork: true,
				force: true,
				signal,
			});
			deepStrictEqual(
				refreshed.map(({ id }) => id),
				["deepseek-flash", "glm-5.2"],
			);
			equal(calls, 1);

			globalThis.fetch = async () =>
				new Response("unavailable", { status: 503 });
			await rejects(
				refreshModels({
					credential: { type: "api_key", key: "test-key" },
					allowNetwork: true,
					force: true,
					signal,
				}),
			);
			const preserved = await refreshModels({ allowNetwork: false, signal });
			deepStrictEqual(
				preserved.map(({ id }) => id),
				["deepseek-flash", "glm-5.2"],
			);
			// 已退役 ID 不能通过网关刷新恢复；K3 256K 可以。
			globalThis.fetch = async () => new Response(JSON.stringify({ data: [
				"deepseek-flash", "glm-5.2", "kimi-k3-256k",
				"deepseek-v4-flash", "glm-5.1", "MiniMax-M2.7",
				"kimi-k2.6", "gpt-5.6-sol", "gemini-2.5-pro",
			].map(id => ({ id })) }), { status: 200 });
			const curated = await refreshModels({
				credential: { type: "api_key", key: "test-key" },
				allowNetwork: true, force: true, signal,
			});
			deepStrictEqual(curated.map(({ id }) => id), ["deepseek-flash", "glm-5.2", "kimi-k3-256k"]);
		} finally {
			pi.invoke("session_shutdown", { type: "session_shutdown" }, sessionContext);
			globalThis.fetch = previousFetch;
		}
	});
}

async function testPreSessionExplicitForce(): Promise<void> {
	await withAgentDir(undefined, async () => {
		const pi = new FakePi();
		await registerTsgw(pi);
		const provider = pi.providers.find(({ name }) => name === PROVIDER_ID);
		const refreshModels = (
			provider?.config as
				| {
						refreshModels?: (context: {
							credential?: { type: string; key?: string };
							allowNetwork: boolean;
							force?: boolean;
							signal: AbortSignal;
						}) => Promise<Array<{ id: string }>>;
				  }
				| undefined
		)?.refreshModels;
		if (!refreshModels) throw new Error("应提供动态模型刷新功能");

		const previousFetch = globalThis.fetch;
		const key = `presession-force-${randomUUID()}`;
		let calls = 0;
		try {
			globalThis.fetch = async () => {
				calls += 1;
				return new Response(
					JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "glm-5.2" }] }),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			};
			const signal = new AbortController().signal;
			const local = await refreshModels({
				credential: { type: "api_key", key },
				allowNetwork: true,
				signal,
			});
			deepStrictEqual(local, [], "未显式 force 时预 session 不联网");
			equal(calls, 0);

			const forced = await refreshModels({
				credential: { type: "api_key", key },
				allowNetwork: true,
				force: true,
				signal,
			});
			deepStrictEqual(
				forced.map(({ id }) => id),
				["deepseek-flash", "glm-5.2"],
				"预 session 显式 force 仍可联网，兼容无会话 CLI",
			);
			equal(calls, 1);
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
}

async function testRefreshCommand(): Promise<void> {
	const pi = await createPi();
	let available = [{ provider: PROVIDER_ID }];
	let refreshOptions: unknown;
	const notifications: Array<{ message: string; level: string }> = [];
	await pi.invokeCommand("tsgw-refresh", {
		waitForIdle: async () => {},
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured: true }),
			getAvailable: () => available,
			refresh: async (options: unknown) => {
				refreshOptions = options;
				available = [{ provider: PROVIDER_ID }, { provider: PROVIDER_ID }];
				return { aborted: false, errors: new Map<string, Error>() };
			},
		},
		ui: {
			notify: (message: string, level: string) => {
				notifications.push({ message, level });
			},
		},
	});
	const passed = refreshOptions as { providers: string[]; force: boolean; signal: AbortSignal };
	deepStrictEqual(passed.providers, [PROVIDER_ID]);
	strictEqual(passed.force, true);
	strictEqual(passed.signal instanceof AbortSignal, true);
	strictEqual(notifications.length, 1);
	strictEqual(notifications[0].level, "warning", "宿主未执行 provider 刷新时不能误报成功");
}

async function main(): Promise<void> {
	await testChatCompletionsCompatibility();
	await testTsSearchRegistration();
	await testSafeProviderHooksAfterContextStales();
	await testLifecycleStateUpdates();
	await testNoStateAndTraceLimits();
	await testTraceHeaderSettings();
	await testOldInstanceCallbacksKeepOwnSnapshot();
	await testSettingsConfig();
	await testDynamicModelRefresh();
	await testPreSessionExplicitForce();
	await testRefreshCommand();
	console.log("index.test.ts：全部断言通过");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
