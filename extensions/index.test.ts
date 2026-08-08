import { deepStrictEqual, equal, match, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import registerTsgw from "./index.ts";

type HookName =
	| "session_start"
	| "agent_start"
	| "model_select"
	| "thinking_level_select"
	| "before_provider_request"
	| "before_provider_headers";

const STALE_ERROR = "Extension context is stale after runtime replacement";
const TEST_ROOT = "https://aih.example.com";
const TSGW_TERRA = {
	provider: "tsgw",
	id: "gpt-5.6-terra",
	api: "openai-responses",
	baseUrl: `${TEST_ROOT}/v1`,
};
const TSGW_DEEPSEEK = {
	provider: "tsgw",
	id: "deepseek-v4-flash",
	api: "openai-completions",
	baseUrl: `${TEST_ROOT}/v1`,
};
const TSGW_GLM = {
	provider: "tsgw",
	id: "glm-5.2",
	api: "openai-completions",
	baseUrl: `${TEST_ROOT}/v1`,
};

class FakeContext {
	private stale = false;

	constructor(
		private readonly currentModel:
			| typeof TSGW_TERRA
			| typeof TSGW_DEEPSEEK
			| typeof TSGW_GLM
			| { provider: string; id: string; api: string; baseUrl: string }
			| undefined,
		private readonly currentThinkingLevel: "off" | "high" | "low",
	) {}

	get model(): typeof this.currentModel {
		this.assertFresh();
		return this.currentModel;
	}

	get thinkingLevel(): typeof this.currentThinkingLevel {
		this.assertFresh();
		return this.currentThinkingLevel;
	}

	makeStale(): void {
		this.stale = true;
	}

	private assertFresh(): void {
		if (this.stale) throw new Error(STALE_ERROR);
	}
}

class FakePi {
	readonly providers: Array<{ name: string; config: unknown }> = [];
	readonly tools: unknown[] = [];
	private readonly handlers = new Map<HookName, unknown[]>();

	on: ExtensionAPI["on"] = (event, handler) => {
		if (!this.isHookName(event)) return;
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	};
	registerTool: ExtensionAPI["registerTool"] = (tool) => {
		this.tools.push(tool);
	};
	registerCommand: ExtensionAPI["registerCommand"] = () => {};
	registerShortcut: ExtensionAPI["registerShortcut"] = () => {};
	registerFlag: ExtensionAPI["registerFlag"] = () => {};
	getFlag: ExtensionAPI["getFlag"] = () => undefined;
	registerMessageRenderer: ExtensionAPI["registerMessageRenderer"] = () => {};
	registerEntryRenderer: ExtensionAPI["registerEntryRenderer"] = () => {};
	registerMarkdownTransformer: ExtensionAPI["registerMarkdownTransformer"] =
		() => {};
	sendMessage: ExtensionAPI["sendMessage"] = () => {};
	sendUserMessage: ExtensionAPI["sendUserMessage"] = () => {};
	appendEntry: ExtensionAPI["appendEntry"] = () => {};
	setSessionName: ExtensionAPI["setSessionName"] = () => {};
	getSessionName: ExtensionAPI["getSessionName"] = () => undefined;
	setLabel: ExtensionAPI["setLabel"] = () => {};
	exec: ExtensionAPI["exec"] = async () => {
		throw new Error("FakePi.exec is not used by this test");
	};
	getActiveTools: ExtensionAPI["getActiveTools"] = () => [];
	getAllTools: ExtensionAPI["getAllTools"] = () => [];
	setActiveTools: ExtensionAPI["setActiveTools"] = () => {};
	getCommands: ExtensionAPI["getCommands"] = () => [];
	setModel: ExtensionAPI["setModel"] = async () => false;
	getThinkingLevel: ExtensionAPI["getThinkingLevel"] = () => {
		throw new Error("legacy getThinkingLevel must not be called");
	};
	setThinkingLevel: ExtensionAPI["setThinkingLevel"] = () => {};
	unregisterProvider: ExtensionAPI["unregisterProvider"] = () => {};

	get events(): ExtensionAPI["events"] {
		throw new Error("FakePi.events is not used by this test");
	}

	registerProvider(_provider: unknown): void;
	registerProvider(name: string, config: ProviderConfig): void;
	registerProvider(nameOrProvider: unknown, config?: ProviderConfig): void {
		if (typeof nameOrProvider === "string")
			this.providers.push({ name: nameOrProvider, config });
	}

	has(event: HookName): boolean {
		return (this.handlers.get(event)?.length ?? 0) > 0;
	}

	invoke(event: HookName, payload: unknown, ctx?: unknown): unknown {
		const handlers = this.handlers.get(event);
		if (!handlers?.length) throw new Error(`missing ${event} handler`);
		let result: unknown;
		for (const handler of handlers) {
			if (typeof handler !== "function")
				throw new Error(`invalid ${event} handler`);
			result = handler(payload, ctx);
		}
		return result;
	}

	private isHookName(event: string): event is HookName {
		return (
			event === "session_start" ||
			event === "agent_start" ||
			event === "model_select" ||
			event === "thinking_level_select" ||
			event === "before_provider_request" ||
			event === "before_provider_headers"
		);
	}
}

async function createPi(settings?: unknown): Promise<FakePi> {
	const pi = new FakePi();
	await withAgentDir(settings, async () => {
		await registerTsgw(pi);
	});
	return pi;
}

function sessionStart(
	pi: FakePi,
	ctx: FakeContext,
	reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
): void {
	pi.invoke("session_start", { type: "session_start", reason }, ctx);
}

function agentStart(pi: FakePi, ctx: FakeContext): void {
	pi.invoke("agent_start", { type: "agent_start" }, ctx);
}

function providerRequest(pi: FakePi, payload: unknown): unknown {
	return pi.invoke("before_provider_request", {
		type: "before_provider_request",
		payload,
	});
}

function providerHeaders(
	pi: FakePi,
	headers: Record<string, string | null>,
): void {
	pi.invoke("before_provider_headers", {
		type: "before_provider_headers",
		headers,
	});
}

/**
 * Isolate the extension from the real Pi config directory: point
 * PI_CODING_AGENT_DIR at a throwaway directory that may contain a
 * settings.json with a `tsgw` namespace.
 */
function withAgentDir(
	settings: unknown,
	run: () => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-tsgw-test-"));
	if (settings !== undefined) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return run().finally(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
}

function assertUuid(value: string | null | undefined): void {
	match(
		value ?? "",
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
}

async function testChatCompletionsCompatibility(): Promise<void> {
	const pi = await createPi();
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
			`${model.id} must send its instruction prompt as system, not developer`,
		);
	}
}

async function testTsSearchRegistration(): Promise<void> {
	const pi = await createPi();
	const tool = pi.tools.find(
		(candidate) =>
			(candidate as { name?: string } | undefined)?.name === "ts_search",
	);
	if (!tool) throw new Error("expected ts_search tool registration");
	const modelSchema = (
		tool as {
			parameters?: {
				properties?: { model?: { anyOf?: Array<{ const?: unknown }> } };
			};
		}
	).parameters?.properties?.model;
	const modelIds = (modelSchema?.anyOf ?? []).map(({ const: value }) => value);
	equal(modelIds.length > 0, true);
	equal(
		modelIds.every(
			(id) =>
				typeof id === "string" &&
				(id.startsWith("gpt-") || id.startsWith("grok-")),
		),
		true,
	);
	equal(modelIds.includes("gpt-5.4"), true);
	equal(modelIds.includes("grok-4.20-fast"), true);
	equal(modelIds.includes("deepseek-v4-flash"), false);
}

async function testSafeProviderHooksAfterContextStales(): Promise<void> {
	const pi = await createPi({
		tsgw: { traceHeaders: true, tsSearch: "cached" },
	});
	const sessionContext = new FakeContext(TSGW_TERRA, "high");
	sessionStart(pi, sessionContext);

	const firstHeaders: Record<string, string | null> = {};
	providerHeaders(pi, firstHeaders);
	const agentContext = new FakeContext(TSGW_TERRA, "high");
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
		text: { verbosity: "medium" },
	});
	const headers: Record<string, string | null> = {};
	providerHeaders(pi, headers);
	assertUuid(headers["AH-Thread-Id"]);
	assertUuid(headers["AH-Trace-Id"]);
	strictEqual(headers["AH-Thread-Id"], firstHeaders["AH-Thread-Id"]);
	if (headers["AH-Trace-Id"] === firstHeaders["AH-Trace-Id"])
		throw new Error("agent_start must refresh AH-Trace-Id");

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
	deepStrictEqual(providerRequest(pi, {}), {
		reasoning_effort: "high",
		thinking: { type: "enabled" },
	});

	pi.invoke("thinking_level_select", {
		type: "thinking_level_select",
		level: "off",
		previousLevel: "high",
	});
	deepStrictEqual(providerRequest(pi, {}), {
		thinking: { type: "disabled" },
	});

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
	deepStrictEqual(providerRequest(pi, {}), {
		thinking: { type: "disabled" },
	});
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
		new FakeContext({ ...TSGW_TERRA, provider: "other" }, "high"),
	);
	const foreign: Record<string, string | null> = {};
	providerHeaders(pi, foreign);
	deepStrictEqual(foreign, {});

	// 模型 baseUrl 与配置 root 不同 host 时不追踪。
	sessionStart(
		pi,
		new FakeContext(
			{ ...TSGW_TERRA, baseUrl: "https://example.test/v1" },
			"high",
		),
	);
	const otherHost: Record<string, string | null> = {};
	providerHeaders(pi, otherHost);
	deepStrictEqual(otherHost, {});

	// 匹配 host：产生追踪头。
	sessionStart(pi, new FakeContext(TSGW_TERRA, "high"));
	const headers: Record<string, string | null> = {};
	providerHeaders(pi, headers);
	assertUuid(headers["AH-Thread-Id"]);
	assertUuid(headers["AH-Trace-Id"]);
}

async function testOldInstanceCallbacksKeepOwnSnapshot(): Promise<void> {
	const replacements = [
		{ label: "reload", reason: "reload" },
		{ label: "new", reason: "new" },
		{ label: "fork", reason: "fork" },
		{ label: "switch", reason: "resume" },
	] as const;

	for (const replacement of replacements) {
		const oldPi = await createPi({
			tsgw: { traceHeaders: true, tsSearch: "cached" },
		});
		const oldContext = new FakeContext(TSGW_TERRA, "high");
		sessionStart(oldPi, oldContext);
		agentStart(oldPi, oldContext);
		oldContext.makeStale();
		oldPi.getThinkingLevel = () => {
			throw new Error(STALE_ERROR);
		};

		const newPi = await createPi();
		sessionStart(
			newPi,
			new FakeContext(TSGW_DEEPSEEK, "off"),
			replacement.reason,
		);

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
				text: { verbosity: "medium" },
			},
			`${replacement.label}: late old callback must retain its own state`,
		);
		deepStrictEqual(
			providerRequest(newPi, {}),
			{ thinking: { type: "disabled" } },
			`${replacement.label}: new instance must use its own state`,
		);

		const headers: Record<string, string | null> = {};
		providerHeaders(oldPi, headers);
		assertUuid(headers["AH-Thread-Id"]);
		assertUuid(headers["AH-Trace-Id"]);
	}
}

async function testSettingsConfig(): Promise<void> {
	// settings.json `tsgw.baseUrl` drives the registered provider root.
	const piBase = await createPi({
		tsgw: { baseUrl: "https://gateway.example.net" },
	});
	const provider = piBase.providers.find(({ name }) => name === "tsgw");
	const baseUrl = (provider?.config as { baseUrl?: string } | undefined)
		?.baseUrl;
	strictEqual(baseUrl, "https://gateway.example.net/v1");

	// `tsgw.tsSearch: "live"` enables the built-in search injection.
	const piSearch = await createPi({ tsgw: { tsSearch: "live" } });
	sessionStart(piSearch, new FakeContext(TSGW_TERRA, "high"));
	deepStrictEqual(providerRequest(piSearch, { tools: [] }), {
		tools: [
			{
				type: "web_search",
				search_context_size: "medium",
				external_web_access: true,
			},
		],
		text: { verbosity: "medium" },
	});

	// `tsgw.includeModels` / `tsgw.excludeModels` filter the model catalog.
	const piFiltered = await createPi({
		tsgw: {
			includeModels: ["glm-*"],
			excludeModels: ["glm-5.1"],
		},
	});
	const filtered = piFiltered.providers.find(({ name }) => name === "tsgw");
	const modelIds = (
		(filtered?.config as { models?: Array<{ id: string }> } | undefined)
			?.models ?? []
	).map(({ id }) => id);
	equal(modelIds.length > 1, true);
	equal(
		modelIds.every((id) => id.startsWith("glm-")),
		true,
	);
	equal(modelIds.includes("glm-5.2"), true);
	equal(modelIds.includes("glm-5.1"), false);

	// Malformed or missing `tsgw` namespaces are ignored.
	const piBroken = await createPi({ tsgw: "not-an-object" });
	const brokenProvider = piBroken.providers.find(({ name }) => name === "tsgw");
	const brokenBase = (
		brokenProvider?.config as { baseUrl?: string } | undefined
	)?.baseUrl;
	strictEqual(brokenBase, `${TEST_ROOT}/v1`);
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
	console.log("index.test.ts: all assertions passed");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
