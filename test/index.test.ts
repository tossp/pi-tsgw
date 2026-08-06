import { deepStrictEqual, equal, match, strictEqual } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import registerAih from "../src/index.ts";

type HookName =
	| "session_start"
	| "agent_start"
	| "model_select"
	| "thinking_level_select"
	| "before_provider_request"
	| "before_provider_headers";
type EnvChanges = Record<string, string | undefined>;

const STALE_ERROR = "Extension context is stale after runtime replacement";
const TEST_ROOT = "https://aih.example.com";
const AIH_TERRA = {
	provider: "aih",
	id: "gpt-5.6-terra",
	api: "openai-responses",
	baseUrl: `${TEST_ROOT}/v1`,
};
const AIH_DEEPSEEK = {
	provider: "aih",
	id: "deepseek-v4-flash",
	api: "openai-completions",
	baseUrl: `${TEST_ROOT}/v1`,
};
const AIH_GLM = {
	provider: "aih",
	id: "glm-5.2",
	api: "openai-completions",
	baseUrl: `${TEST_ROOT}/v1`,
};

class FakeContext {
	private stale = false;

	constructor(
		private readonly currentModel:
			| typeof AIH_TERRA
			| typeof AIH_DEEPSEEK
			| typeof AIH_GLM
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
	private readonly handlers = new Map<HookName, unknown[]>();

	on: ExtensionAPI["on"] = (event, handler) => {
		if (!this.isHookName(event)) return;
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
	};
	registerTool: ExtensionAPI["registerTool"] = () => {};
	registerCommand: ExtensionAPI["registerCommand"] = () => {};
	registerShortcut: ExtensionAPI["registerShortcut"] = () => {};
	registerFlag: ExtensionAPI["registerFlag"] = () => {};
	getFlag: ExtensionAPI["getFlag"] = () => undefined;
	registerMessageRenderer: ExtensionAPI["registerMessageRenderer"] = () => {};
	registerEntryRenderer: ExtensionAPI["registerEntryRenderer"] = () => {};
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

async function createPi(): Promise<FakePi> {
	const pi = new FakePi();
	await registerAih(pi);
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

function withEnv(changes: EnvChanges, run: () => Promise<void>): Promise<void> {
	const previous = new Map<string, string | undefined>();
	for (const [name, value] of Object.entries(changes)) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	return run().finally(() => {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
}

/**
 * Isolate the extension from the real Pi config directory: point
 * PI_CODING_AGENT_DIR at a throwaway directory that may contain a
 * settings.json with an `aih` namespace.
 */
function withAgentDir(
	settings: unknown,
	env: EnvChanges,
	run: () => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-tsgw-test-"));
	if (settings !== undefined) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	return withEnv({ ...env, PI_CODING_AGENT_DIR: dir }, run).finally(() => {
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
	const provider = pi.providers.find(({ name }) => name === "aih");
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

async function testSafeProviderHooksAfterContextStales(): Promise<void> {
	await withAgentDir(
		undefined,
		{
			AIH_TRACE_HEADERS: "1",
			AIH_WEB_SEARCH: "cached",
			AIH_BASE_URL: undefined,
		},
		async () => {
			const pi = await createPi();
			const sessionContext = new FakeContext(AIH_TERRA, "high");
			sessionStart(pi, sessionContext);

			const firstHeaders: Record<string, string | null> = {};
			providerHeaders(pi, firstHeaders);
			const agentContext = new FakeContext(AIH_TERRA, "high");
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
				service_tier: "flex",
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
		},
	);
}

async function testLifecycleStateUpdates(): Promise<void> {
	await withAgentDir(
		undefined,
		{
			AIH_TRACE_HEADERS: undefined,
			AIH_WEB_SEARCH: undefined,
			AIH_BASE_URL: undefined,
		},
		async () => {
			const pi = await createPi();
			sessionStart(pi, new FakeContext(AIH_DEEPSEEK, "high"));
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
				model: AIH_GLM,
				previousModel: AIH_DEEPSEEK,
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

			const agentContext = new FakeContext(AIH_DEEPSEEK, "off");
			agentStart(pi, agentContext);
			agentContext.makeStale();
			deepStrictEqual(providerRequest(pi, {}), {
				thinking: { type: "disabled" },
			});
		},
	);
}

async function testNoStateAndTraceLimits(): Promise<void> {
	await withAgentDir(
		undefined,
		{
			AIH_TRACE_HEADERS: "1",
			AIH_WEB_SEARCH: undefined,
			AIH_BASE_URL: undefined,
		},
		async () => {
			const pi = await createPi();
			const payload = { untouched: true };
			strictEqual(providerRequest(pi, payload), undefined);
			const headers: Record<string, string | null> = {};
			providerHeaders(pi, headers);
			deepStrictEqual(headers, {});

			sessionStart(
				pi,
				new FakeContext({ ...AIH_TERRA, provider: "other" }, "high"),
			);
			strictEqual(providerRequest(pi, payload), payload);
			providerHeaders(pi, headers);
			deepStrictEqual(headers, {});

			sessionStart(
				pi,
				new FakeContext(
					{ ...AIH_TERRA, baseUrl: "https://example.test/v1" },
					"high",
				),
			);
			providerHeaders(pi, headers);
			deepStrictEqual(headers, {});
		},
	);

	await withAgentDir(
		undefined,
		{
			AIH_TRACE_HEADERS: undefined,
			AIH_WEB_SEARCH: undefined,
			AIH_BASE_URL: undefined,
		},
		async () => {
			const pi = await createPi();
			equal(pi.has("before_provider_headers"), false);
		},
	);

	// Trace is governed by AIH_TRACE_HEADERS / settings only, not by which
	// gateway root is configured: any self-hosted AIH root can opt in.
	await withAgentDir(
		undefined,
		{
			AIH_TRACE_HEADERS: "1",
			AIH_WEB_SEARCH: undefined,
			AIH_BASE_URL: "https://example.test",
		},
		async () => {
			const pi = await createPi();
			equal(pi.has("before_provider_headers"), true);
			sessionStart(
				pi,
				new FakeContext(
					{ ...AIH_TERRA, baseUrl: "https://example.test/v1" },
					"high",
				),
			);
			const headers: Record<string, string | null> = {};
			providerHeaders(pi, headers);
			assertUuid(headers["AH-Thread-Id"]);
			assertUuid(headers["AH-Trace-Id"]);
		},
	);
}

async function testOldInstanceCallbacksKeepOwnSnapshot(): Promise<void> {
	await withAgentDir(
		undefined,
		{
			AIH_TRACE_HEADERS: "1",
			AIH_WEB_SEARCH: "cached",
			AIH_BASE_URL: undefined,
		},
		async () => {
			const replacements = [
				{ label: "reload", reason: "reload" },
				{ label: "new", reason: "new" },
				{ label: "fork", reason: "fork" },
				{ label: "switch", reason: "resume" },
			] as const;

			for (const replacement of replacements) {
				const oldPi = await createPi();
				const oldContext = new FakeContext(AIH_TERRA, "high");
				sessionStart(oldPi, oldContext);
				agentStart(oldPi, oldContext);
				oldContext.makeStale();
				oldPi.getThinkingLevel = () => {
					throw new Error(STALE_ERROR);
				};

				const newPi = await createPi();
				sessionStart(
					newPi,
					new FakeContext(AIH_DEEPSEEK, "off"),
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
						service_tier: "flex",
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
		},
	);
}

async function testSettingsConfig(): Promise<void> {
	// settings.json `aih.baseUrl` drives the registered provider root.
	await withAgentDir(
		{ aih: { baseUrl: "https://gateway.example.net" } },
		{ AIH_BASE_URL: "https://ignored.example" },
		async () => {
			const pi = await createPi();
			const provider = pi.providers.find(({ name }) => name === "aih");
			const baseUrl = (provider?.config as { baseUrl?: string } | undefined)
				?.baseUrl;
			strictEqual(baseUrl, "https://gateway.example.net/v1");
		},
	);

	// `aih.webSearch` wins over the AIH_WEB_SEARCH environment fallback.
	await withAgentDir(
		{ aih: { webSearch: "live" } },
		{ AIH_WEB_SEARCH: "cached", AIH_TRACE_HEADERS: undefined, AIH_BASE_URL: undefined },
		async () => {
			const pi = await createPi();
			sessionStart(pi, new FakeContext(AIH_TERRA, "high"));
			deepStrictEqual(providerRequest(pi, { tools: [] }), {
				tools: [
					{
						type: "web_search",
						search_context_size: "medium",
						external_web_access: true,
					},
				],
				service_tier: "flex",
				text: { verbosity: "medium" },
			});
		},
	);

	// `aih.traceHeaders: true` enables the tracing hooks.
	await withAgentDir(
		{ aih: { traceHeaders: true } },
		{ AIH_TRACE_HEADERS: undefined, AIH_WEB_SEARCH: undefined, AIH_BASE_URL: undefined },
		async () => {
			const pi = await createPi();
			equal(pi.has("before_provider_headers"), true);
			sessionStart(pi, new FakeContext(AIH_TERRA, "high"));
			const headers: Record<string, string | null> = {};
			providerHeaders(pi, headers);
			assertUuid(headers["AH-Thread-Id"]);
			assertUuid(headers["AH-Trace-Id"]);
		},
	);

	// Malformed or missing `aih` namespaces are ignored.
	await withAgentDir(
		{ aih: "not-an-object" },
		{ AIH_TRACE_HEADERS: undefined, AIH_WEB_SEARCH: undefined, AIH_BASE_URL: undefined },
		async () => {
			const pi = await createPi();
			const provider = pi.providers.find(({ name }) => name === "aih");
			const baseUrl = (provider?.config as { baseUrl?: string } | undefined)
				?.baseUrl;
			strictEqual(baseUrl, `${TEST_ROOT}/v1`);
		},
	);
}

async function main(): Promise<void> {
	await testChatCompletionsCompatibility();
	await testSafeProviderHooksAfterContextStales();
	await testLifecycleStateUpdates();
	await testNoStateAndTraceLimits();
	await testOldInstanceCallbacksKeepOwnSnapshot();
	await testSettingsConfig();
	console.log("index.test.ts: all assertions passed");
}

void main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
