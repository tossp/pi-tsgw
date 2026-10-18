// 集成测试共享的模拟宿主；不纳入生产构建。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import registerTsgw from "../index.ts";
import { modelsForRoot, normalizeRoot } from "#tsgw/models/catalog";
import { openaiImageModels as imageModelsForRoot } from "#tsgw/models/vendors/openai";
import { gatewayModelCacheScope, saveGatewayModelCache } from "#tsgw/models/gateway-catalog";

type HookName =
	| "session_start"
	| "session_shutdown"
	| "agent_start"
	| "before_agent_start"
	| "model_select"
	| "thinking_level_select"
	| "before_provider_request"
	| "before_provider_headers";

export const STALE_ERROR = "Extension context is stale after runtime replacement";
export const TEST_ROOT = "https://aih.example.com";
export const TSGW_SOL = {
	provider: "tsgw",
	id: "gpt-6-sol",
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
			| typeof TSGW_SOL
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
	activeTools: string[] = ["other_tool"];
	readonly commands = new Map<string, unknown>();
	private readonly handlers = new Map<HookName, unknown[]>();

	on: ExtensionAPI["on"] = (event, handler) => {
		if (!this.isHookName(event)) return () => {};
		const handlers = this.handlers.get(event) ?? [];
		handlers.push(handler);
		this.handlers.set(event, handlers);
		return () => {
			const index = handlers.indexOf(handler);
			if (index >= 0) handlers.splice(index, 1);
		};
	};
	registerTool: ExtensionAPI["registerTool"] = (tool) => {
		this.tools.push(tool);
	};
	registerCommand: ExtensionAPI["registerCommand"] = (name, command) => {
		this.commands.set(name, command);
	};
	registerToolRenderer: ExtensionAPI["registerToolRenderer"] = () => {};
	getSettings: ExtensionAPI["getSettings"] = () => ({});
	registerMcpServer: ExtensionAPI["registerMcpServer"] = () => {
		throw new Error("插件不得登记 MCP 服务");
	};
	unregisterMcpServer: ExtensionAPI["unregisterMcpServer"] = () => {};
	getMcpServers: ExtensionAPI["getMcpServers"] = () => [];
	registerVirtualModel: ExtensionAPI["registerVirtualModel"] = () => {};
	unregisterVirtualModel: ExtensionAPI["unregisterVirtualModel"] = () => {};
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
		throw new Error("本测试不使用 FakePi.exec");
	};
	getActiveTools: ExtensionAPI["getActiveTools"] = () => [...this.activeTools];
	getAllTools: ExtensionAPI["getAllTools"] = () => this.tools as ReturnType<ExtensionAPI["getAllTools"]>;
	setActiveTools: ExtensionAPI["setActiveTools"] = (names) => {
		this.activeTools = [...names];
	};
	getCommands: ExtensionAPI["getCommands"] = () => [];
	setModel: ExtensionAPI["setModel"] = async () => false;
	getThinkingLevel: ExtensionAPI["getThinkingLevel"] = () => {
		throw new Error("不得调用旧版 getThinkingLevel");
	};
	setThinkingLevel: ExtensionAPI["setThinkingLevel"] = () => {};
	unregisterProvider: ExtensionAPI["unregisterProvider"] = () => {};

	get events(): ExtensionAPI["events"] {
		throw new Error("本测试不使用 FakePi.events");
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
		if (!handlers?.length) throw new Error(`缺少 ${event} 处理器`);
		let result: unknown;
		for (const handler of handlers) {
			if (typeof handler !== "function")
				throw new Error(`${event} 处理器无效`);
			result = handler(payload, ctx);
		}
		return result;
	}

	async invokeCommand(name: string, ctx: unknown, args = ""): Promise<void> {
		const command = this.commands.get(name) as
			| { handler?: (args: string, ctx: unknown) => void | Promise<void> }
			| undefined;
		if (!command?.handler) throw new Error(`缺少 ${name} 命令`);
		await command.handler(args, ctx);
	}

	private isHookName(event: string): event is HookName {
		return (
			event === "session_start" ||
			event === "session_shutdown" ||
			event === "agent_start" ||
			event === "before_agent_start" ||
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

/** 显式构造已成功获取的合成目录；不改变 createPi 的无凭据零模型启动语义。 */
export async function createPiWithCatalog(settings?: unknown): Promise<FakePi> {
	const pi = new FakePi();
	await withAgentDir(settings, async (dir) => {
		const namespace = (settings as { tsgw?: { baseUrl?: string } } | undefined)?.tsgw;
		seedSuccessfulCatalog(dir, normalizeRoot(namespace?.baseUrl));
		const previousFetch = globalThis.fetch;
		let calls = 0;
		globalThis.fetch = async () => { calls++; throw new Error("成功缓存夹具禁止联网"); };
		try {
			await registerTsgw(pi);
			if (calls !== 0) throw new Error("成功缓存夹具不应尝试刷新目录");
		} finally { globalThis.fetch = previousFetch; }
	});
	return pi;
}

/** 仅供目录过滤/宿主交互测试使用。凭据和成功缓存都位于临时 agentDir。 */
export function seedSuccessfulCatalog(
	dir: string,
	root = TEST_ROOT,
	ids = [...modelsForRoot(root), ...imageModelsForRoot(root)].map(model => model.id),
	storedAt = Date.now(),
): { key: string; storedAt: number } {
	// 不同夹具使用独立 scope，避免进程内目录缓存互相污染。
	const key = `synthetic-catalog-key:${dir}`;
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ tsgw: { type: "api_key", key } }));
	saveGatewayModelCache(join(dir, "tsgw", "models-cache.json"),
		gatewayModelCacheScope(root, key), ids, storedAt);
	return { key, storedAt };
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
 * 将扩展与真实 Pi 配置目录隔离：把 PI_CODING_AGENT_DIR 指向临时目录，
 * 其中可包含带有 `tsgw` 命名空间的 settings.json。
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

