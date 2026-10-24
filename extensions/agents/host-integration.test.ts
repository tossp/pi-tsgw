import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { HostSandbox } from "#tsgw/host-test-support.test";
import { STANDARD_AGENT_NAMES, standardAgentProfiles } from "./profiles.ts";

// 真实 SDK 命令分发和重载；所有目录、配置和网络均隔离，不创建真实子代理。
test("Pi SDK：/insagent 覆盖定义后清理旧文件并自动重载，不在启动时写盘", { timeout: 60_000 }, async () => {
	const sandbox = new HostSandbox();
	let session: AgentSession | undefined;
	try {
		const { createAgentSession, DefaultResourceLoader, ModelRuntime, parseFrontmatter, SessionManager, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const { registerAgentInstallCommand } = await import("./command.ts");
		const settings = SettingsManager.inMemory({
			packages: [], extensions: [], compaction: { enabled: false },
			retry: { enabled: false }, cacheWarming: "off",
		});
		const lifecycle: string[] = [];
		const loader = new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [pi => {
				registerAgentInstallCommand(pi);
				pi.on("session_start", event => { lifecycle.push(`start:${event.reason}`); });
				pi.on("session_shutdown", event => { lifecycle.push(`shutdown:${event.reason}`); });
			}],
		});
		await loader.reload();
		const runtime = await ModelRuntime.create({
			authPath: join(sandbox.agentDir, "auth.json"), modelsPath: join(sandbox.agentDir, "models.json"),
			modelsStorePath: join(sandbox.agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
		});
		({ session } = await createAgentSession({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir, modelRuntime: runtime, resourceLoader: loader,
			settingsManager: settings, sessionManager: SessionManager.inMemory(sandbox.cwd), tools: [],
		}));
		await session.bindExtensions({
			mode: "print",
			// SDK 由宿主绑定命令动作；按 Pi Web 的公开接法转到真实 session.reload。
			commandContextActions: {
				waitForIdle: () => session!.waitForIdle(),
				newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
				navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
				reload: () => session!.reload(),
			},
		});
		const directory = join(sandbox.agentDir, "agents");
		assert.equal(existsSync(directory), false);
		const initialRunner = session.extensionRunner;
		await session.prompt("/insagent unexpected");
		assert.equal(existsSync(directory), false, "参数错误不得安装或重载");
		assert.equal(session.extensionRunner, initialRunner);
		await session.prompt("/insagent");
		assert.notEqual(session.extensionRunner, initialRunner);
		assert.deepEqual(lifecycle.slice(1), ["shutdown:reload", "start:reload"]);
		assert.equal(existsSync(join(sandbox.cwd, ".pi", "agents")), false, "路径只能来自宿主 agent-dir");
		const builtinSettings = join(directory, "settings.json");
		assert.deepEqual(JSON.parse(readFileSync(builtinSettings, "utf8")), {
			version: 1, builtInEnabled: true, disabledBuiltIns: ["general-purpose", "explore", "plan"],
		});
		const profiles = standardAgentProfiles();
		assert.deepEqual(profiles.map(profile => profile.name), [...STANDARD_AGENT_NAMES]);
		assert.equal(new Set(profiles.map(profile => profile.name)).size, profiles.length);
		let baseline: unknown;
		for (const profile of profiles) {
			assert.match(profile.name, /^tsgw-[a-z0-9-]+$/);
			const path = join(directory, `${profile.name}.md`);
			assert.equal(readFileSync(path, "utf8"), profile.content);
			const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(profile.content);
			assert.ok(body.trim());
			const { description, display_name, ...resources } = frontmatter;
			assert.equal(typeof description, "string");
			assert.equal(typeof display_name, "string");
			if (baseline) assert.deepEqual(resources, baseline, "各角色资源配置必须相同");
			baseline = resources;
			for (const key of ["load_skills", "load_extensions", "skills", "extensions", "enabled"]) assert.equal(resources[key], true);
			assert.equal(resources.codemode, "on");
			assert.equal(resources.mcp, "on");
			assert.equal(resources.inherit_context, false);
			assert.equal(resources.prompt_mode, "append");
			for (const key of ["model", "thinking", "max_turns", "isolation"]) assert.equal(resources[key], undefined);
		}

		const stale = join(directory, "tsgw-retired-fixture.md");
		const personal = join(directory, "personal.md");
		writeFileSync(stale, "已退出清单");
		writeFileSync(personal, "用户自定义代理");
		writeFileSync(builtinSettings, JSON.stringify({ builtInEnabled: false, maxConcurrent: 7, futureSetting: "保留" }));
		writeFileSync(join(directory, `${profiles[0]!.name}.md`), "同名内容直接覆盖");
		const previousRunner = session.extensionRunner;
		await session.prompt("/insagent");
		assert.notEqual(session.extensionRunner, previousRunner);
		assert.equal(existsSync(stale), false);
		assert.equal(readFileSync(personal, "utf8"), "用户自定义代理");
		assert.deepEqual(JSON.parse(readFileSync(builtinSettings, "utf8")), {
			version: 1, builtInEnabled: true, maxConcurrent: 7, futureSetting: "保留",
			disabledBuiltIns: ["general-purpose", "explore", "plan"],
		});
		assert.equal(readFileSync(join(directory, `${profiles[0]!.name}.md`), "utf8"), profiles[0]!.content);

		// 写入中途出错不清理旧文件、不重载；前面已写入的部分明确保留。
		const blocked = join(directory, `${profiles[1]!.name}.md`);
		rmSync(blocked);
		mkdirSync(blocked);
		writeFileSync(stale, "失败时保留旧代理");
		const beforeFailure = session.extensionRunner;
		await session.prompt("/insagent");
		assert.equal(session.extensionRunner, beforeFailure);
		assert.equal(readFileSync(stale, "utf8"), "失败时保留旧代理");
		// 宿主设置损坏同样阻止重载，不覆盖原设置。
		rmSync(blocked, { recursive: true });
		writeFileSync(builtinSettings, "{");
		await session.prompt("/insagent");
		assert.equal(session.extensionRunner, beforeFailure);
		assert.equal(readFileSync(builtinSettings, "utf8"), "{");
		const filesBeforeReload = readdirSync(directory).sort();
		await session.reload();
		assert.deepEqual(readdirSync(directory).sort(), filesBeforeReload, "普通重载不重新安装或清理文件");
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(sandbox.blocked, []);
		assert.equal(sandbox.catalogCalls, 0);
		assert.equal(sandbox.requests.length, 0);
	} finally {
		try { session?.dispose(); } finally { sandbox.restore(); }
	}
});
