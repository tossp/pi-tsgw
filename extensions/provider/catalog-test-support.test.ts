import { equal } from "node:assert/strict";
import registerTsgw from "../../index.ts";
import { FakePi, TSGW_SOL, withAgentDir, seedSuccessfulCatalog } from "#tsgw/test-support.test";

type Refresh = (context: {
	allowNetwork: boolean;
	credential?: { type: string; key: string };
	force?: boolean;
	signal: AbortSignal;
}) => Promise<Array<{ id: string }>>;
let fixtureId = 0;

/** 提供跨文件唯一且不重复的临时网关根地址序号。 */
export function nextFixtureId(): number {
	return ++fixtureId;
}

export async function withUi(
	run: (context: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
	search = "live",
	catalog: "cache" | "empty" = "cache",
) {
	const root = `https://status-${nextFixtureId()}.example.test`;
	await withAgentDir({ tsgw: { baseUrl: root, tsSearch: search } }, async (dir) => {
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async () => { throw new Error("意外网络访问"); };
		let current: Awaited<ReturnType<typeof fixture>> | undefined;
		try {
			// 搜索代理与目录交互用例显式提供成功目录，不依赖静态回退。
			const seeded = catalog === "cache" ? seedSuccessfulCatalog(dir, root) : undefined;
			current = await fixture(root, dir, { key: seeded?.key, configured: catalog === "cache" });
			await run(current);
		}
		finally {
			if (current) current.pi.invoke("session_shutdown", {}, current.ctx);
			globalThis.fetch = previousFetch;
		}
	});
}

export async function fixture(root: string, dir: string, options: { key?: string; configured?: boolean } = {}) {
	const pi = new FakePi();
	await registerTsgw(pi);
	const provider = pi.providers[0].config as { models: Array<{ id: string; type?: string }>; refreshModels: Refresh };
	let models = provider.models;
	let configured = options.configured ?? true;
	const statuses = new Map<string, string>();
	const updates: string[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const dialogs: Array<{ title: string; options: string[] }> = [];
	const choices: Array<number | undefined> = [];
	let refreshCalls = 0;
	let restoreCalls = 0;
	const ctx = {
		hasUI: true,
		model: { ...TSGW_SOL, baseUrl: `${root}/v1` },
		thinkingLevel: "high",
		waitForIdle: async () => {},
		modelRegistry: {
			getProviderAuthStatus: () => ({ configured }),
			getAvailable: () => models.map((model) => ({ ...model, provider: "tsgw" })),
			refresh: async (input: { force?: boolean; signal?: AbortSignal; allowNetwork?: boolean } = {}):
				Promise<{ errors: Map<string, Error>; aborted?: boolean } | void> => {
				refreshCalls++;
				const restore = input.allowNetwork === false;
				if (restore) restoreCalls++;
				try {
					models = await provider.refreshModels({
						allowNetwork: input.allowNetwork ?? true,
						force: input.force,
						...(options.key ? { credential: { type: "api_key" as const, key: options.key } } : {}),
						signal: input.signal ?? new AbortController().signal,
					});
					return { errors: new Map<string, Error>() };
				} catch (error) { return { errors: new Map([["tsgw", error as Error]]) }; }
			},
		},
		ui: {
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else { statuses.set(key, text); updates.push(text); }
			},
			notify: (text: string, level: string) => { notices.push({ text, level }); },
			select: async (title: string, options: string[]) => {
				dialogs.push({ title, options });
				const choice = choices.shift();
				if (choice === undefined) return undefined;
				equal(choice >= 0 && choice < options.length, true);
				return options[choice];
			},
		},
	};
	pi.invoke("session_start", { reason: "startup" }, ctx);
	// 新恢复流程先做 allowNetwork:false 的本地 restore，再决定是否联网或告警。
	await waitUntil(() => restoreCalls > 0, "启动恢复未执行本地 restore");
	// 给 restore 之后的后台流程留出一轮宏任务，避免用例在未决 Promise 上退出。
	await new Promise<void>((resolve) => setTimeout(resolve, 5));
	return { pi, ctx, root, dir, key: options.key ?? "test", statuses, updates, notices, dialogs, choices,
		refreshModels: provider.refreshModels, refreshCalls: () => refreshCalls,
		restoreCalls: () => restoreCalls,
		networkRefreshCalls: () => refreshCalls - restoreCalls,
		setConfigured: (value: boolean) => { configured = value; } };
}

export const modelResponse = (ids = ["gpt-6-sol", "glm-5.2"]) =>
	new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

export async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await new Promise<void>(resolve => setTimeout(resolve, 5));
	}
}
