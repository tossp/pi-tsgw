// Shared fake host for integration tests; excluded from production builds.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import registerTsgw from "./index.ts";

type HookName =
	| "session_start"
	| "session_shutdown"
	| "agent_start"
	| "model_select"
	| "thinking_level_select"
	| "before_provider_request"
	| "before_provider_headers";

export const STALE_ERROR = "Extension context is stale after runtime replacement";
export const TEST_ROOT = "https://aih.example.com";
export const TSGW_TERRA = {
	provider: "tsgw",
	id: "gpt-5.6-terra",
	api: "openai-responses",
	baseUrl: `${TEST_ROOT}/v1`,
};
export const TSGW_DEEPSEEK = {
	provider: "tsgw",
	id: "deepseek-flash",
	api: "openai-responses",
	baseUrl: `${TEST_ROOT}/v1`,
};
export const TSGW_GLM = {
	provider: "tsgw",
	id: "glm-5.2",
	api: "openai-completions",
	baseUrl: `${TEST_ROOT}/v1`,
};

export class FakeContext {
	readonly hasUI = false;
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

export class FakePi {
	readonly providers: Array<{ name: string; config: unknown }> = [];
	readonly tools: unknown[] = [];
	readonly commands = new Map<string, unknown>();
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
	registerCommand: ExtensionAPI["registerCommand"] = (name, command) => {
		this.commands.set(name, command);
	};
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

	async invokeCommand(name: string, ctx: unknown, args = ""): Promise<void> {
		const command = this.commands.get(name) as
			| { handler?: (args: string, ctx: unknown) => void | Promise<void> }
			| undefined;
		if (!command?.handler) throw new Error(`missing ${name} command`);
		await command.handler(args, ctx);
	}

	private isHookName(event: string): event is HookName {
		return (
			event === "session_start" ||
			event === "session_shutdown" ||
			event === "agent_start" ||
			event === "model_select" ||
			event === "thinking_level_select" ||
			event === "before_provider_request" ||
			event === "before_provider_headers"
		);
	}
}

export async function createPi(settings?: unknown): Promise<FakePi> {
	const pi = new FakePi();
	await withAgentDir(settings, async () => {
		await registerTsgw(pi);
	});
	return pi;
}

export function sessionStart(
	pi: FakePi,
	ctx: FakeContext,
	reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup",
): void {
	pi.invoke("session_start", { type: "session_start", reason }, ctx);
}

export function agentStart(pi: FakePi, ctx: FakeContext): void {
	pi.invoke("agent_start", { type: "agent_start" }, ctx);
}

export function providerRequest(pi: FakePi, payload: unknown): unknown {
	return pi.invoke("before_provider_request", {
		type: "before_provider_request",
		payload,
	});
}

export function providerHeaders(
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
export function withAgentDir(
	settings: unknown,
	run: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "pi-tsgw-test-"));
	if (settings !== undefined) {
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	}
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	return run(dir).finally(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});
}

