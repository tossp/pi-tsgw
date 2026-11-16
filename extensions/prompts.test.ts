import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { MEMORY_RULES } from "#tsgw-prompts/memory";
import { createPi } from "#tsgw/test-support.test";
import { HostSandbox, TEST_KEY, TEST_ROOT } from "#tsgw/host-test-support.test";
import { registerPrompts } from "./prompts.ts";

test("记忆规则：入口注册、保留其他分区且重复注入不累加", async () => {
	const pi = await createPi();
	assert.equal(pi.has("before_agent_start"), true);
	const sections = { other_extension: "保留其他扩展的提示词" } as Record<string, string>;
	const options = { sections, customPrompt: "保留宿主前缀", appendSystemPrompt: "保留用户追加提示词" };
	for (const messageType of ["user", "custom"]) {
		assert.equal(pi.invoke("before_agent_start", {
			type: "before_agent_start", messageType,
			systemPrompt: "保留完整宿主提示词", systemPromptOptions: options,
		}, { sessionManager: SessionManager.inMemory() }), undefined);
		assert.deepEqual(sections, { other_extension: "保留其他扩展的提示词", tsgw_memory: MEMORY_RULES });
		assert.equal(options.customPrompt, "保留宿主前缀");
		assert.equal(options.appendSystemPrompt, "保留用户追加提示词");
	}
});

test("记忆规则：旧宿主接口仅追加、不覆盖原提示词", async () => {
	const pi = await createPi();
	assert.deepEqual(pi.invoke("before_agent_start", {
		type: "before_agent_start", messageType: "user", systemPrompt: "原始提示词",
	}, { sessionManager: SessionManager.inMemory() }), { systemPrompt: `原始提示词\n\n${MEMORY_RULES}` });
});

test("默认身份句：旧宿主仅替换开头，正文中的同句保持原样", async () => {
	const pi = await createPi();
	const opening = "You are a coding assistant running inside pi, a coding agent harness.";
	const rest = ` Help users inspect files, run commands, and modify code.\n引用：${opening}`;
	assert.deepEqual(pi.invoke("before_agent_start", { systemPrompt: opening + rest }), {
		systemPrompt: `You are an AI agent.${rest}\n\n${MEMORY_RULES}`,
	});
	const custom = `自定义开场\n${opening}`;
	assert.deepEqual(pi.invoke("before_agent_start", { systemPrompt: custom }), {
		systemPrompt: `${custom}\n\n${MEMORY_RULES}`,
	});
});

test("真实宿主：身份句替换保留默认分区、工具与记忆规则，对不同 provider 均生效", { timeout: 60_000 }, async () => {
	const sandbox = new HostSandbox();
	const sessions: { dispose(): void }[] = [];
	try {
		const { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const settings = SettingsManager.inMemory({
			packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off", transport: "sse",
		});
		const observedPrompts: string[] = [];
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			noContextFiles: true, appendSystemPrompt: ["用户追加说明"],
			extensionFactories: [pi => {
				for (const provider of ["tsgw", "other-provider"]) pi.registerProvider(provider, {
					baseUrl: `${TEST_ROOT}/v1`, api: "openai-responses", apiKey: TEST_KEY,
					models: [{ id: "prompt-fixture", name: "提示词测试模型", reasoning: false, input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 }],
				});
				registerPrompts(pi);
				pi.on("before_provider_request", (_event, ctx) => { observedPrompts.push(ctx.getSystemPrompt()); });
			}],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const runtime = await ModelRuntime.create({
			authPath: join(sandbox.agentDir, "auth.json"), modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
		});
		for (const provider of ["tsgw", "other-provider"]) {
			await runtime.setRuntimeApiKey(provider, TEST_KEY);
			const { session } = await createAgentSession({
				cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime, resourceLoader: loader,
				settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd),
			});
			sessions.push(session);
			const model = runtime.getModel(provider, "prompt-fixture");
			assert.ok(model);
			await session.setModel(model);
			const errors: unknown[] = [];
			await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
			for (const message of ["第一轮", "继续"]) {
				await session.prompt(message);
				assert.equal(session.getLastAssistantText(), "fixture reply");
				const prompt = observedPrompts.at(-1)!;
				assert.ok(prompt.startsWith("You are an AI agent. Help users inspect files, run commands, and modify code."), prompt.slice(0, 300));
				for (const section of ["tools", "rules", "docs", "tsgw_memory"]) assert.ok(prompt.includes(`<${section}>`));
				assert.ok(prompt.includes(MEMORY_RULES));
				assert.equal(prompt.split(MEMORY_RULES).length, 2, "重复运行不得重复追加记忆规则");
				assert.ok(prompt.includes("用户追加说明"));
				const body = sandbox.requests.at(-1)!.body;
				assert.ok(JSON.stringify(body).includes("You are an AI agent."), "实际请求必须使用替换后的提示词");
				assert.ok(!JSON.stringify(body).includes("You are a coding assistant running inside pi"));
				assert.ok(Array.isArray(body.tools) && body.tools.length > 0, "实际工具声明必须保留");
			}
			assert.deepEqual(errors, []);
		}
		assert.equal(sandbox.requests.length, 4);
		assert.deepEqual(sandbox.blocked, []);
	} finally {
		try { for (const session of sessions) session.dispose(); } finally { sandbox.restore(); }
	}
});
