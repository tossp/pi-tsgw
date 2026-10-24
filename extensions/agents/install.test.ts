import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installStandardAgents } from "./install.ts";
import { standardAgentProfiles } from "./profiles.ts";

function sandbox(run: (agentDir: string, directory: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "tsgw-agents-"));
	try { run(join(root, "agent"), join(root, "agent", "agents")); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

test("显式安装创建目录并写入当前定义，重复执行直接覆盖", () => sandbox((agentDir, directory) => {
	const profiles = standardAgentProfiles();
	assert.ok(profiles.length > 0);
	const first = installStandardAgents(agentDir);
	assert.equal(first.directory, directory);
	assert.deepEqual(first.installed, profiles.map(profile => `${profile.name}.md`));
	assert.deepEqual(first.removed, []);
	assert.deepEqual(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8")), {
		version: 1, builtInEnabled: true, disabledBuiltIns: ["general-purpose", "explore", "plan"],
	});
	writeFileSync(join(directory, first.installed[0]!), "本地同名内容应直接覆盖");
	const second = installStandardAgents(agentDir);
	assert.deepEqual(second, first);
	for (const profile of profiles) assert.equal(readFileSync(join(directory, `${profile.name}.md`), "utf8"), profile.content);
}));

test("只删除退出清单的 tsgw-*.md 文件，不碰无前缀文件或其他扩展名", () => sandbox((agentDir, directory) => {
	mkdirSync(directory, { recursive: true });
	const preserved = ["general.md", "personal.md", "tsgw-old.txt", "tsgw-old.md.bak"];
	for (const name of preserved) writeFileSync(join(directory, name), name);
	const stale = "tsgw-retired-fixture.md";
	writeFileSync(join(directory, stale), "已退出清单");
	const result = installStandardAgents(agentDir);
	assert.deepEqual(result.removed, [stale]);
	assert.equal(existsSync(join(directory, stale)), false);
	for (const name of preserved) assert.equal(readFileSync(join(directory, name), "utf8"), name);
	assert.deepEqual(readdirSync(agentDir), ["agents"], "不新增状态清单或其他配置");
}));

test("安装启用 Agent 并停用内置档案，保留其他设置且重复安装不重复追加", () => sandbox((agentDir, directory) => {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "settings.json");
	const original = {
		version: 1, builtInEnabled: false, disabledBuiltIns: [" PLAN ", "future-builtin"],
		maxConcurrent: 7, futureSetting: { keep: true },
	};
	writeFileSync(path, JSON.stringify(original));
	const expected = { ...original, builtInEnabled: true, disabledBuiltIns: [" PLAN ", "future-builtin", "general-purpose", "explore"] };
	installStandardAgents(agentDir);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
	installStandardAgents(agentDir);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
}));

test("无效宿主设置不得被覆盖，安装失败向调用方报告", () => sandbox((agentDir, directory) => {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "settings.json");
	for (const content of ["{", "null", "[]", "false"]) {
		writeFileSync(path, content);
		assert.throws(() => installStandardAgents(agentDir));
		assert.equal(readFileSync(path, "utf8"), content);
	}
}));

test("写入中途失败时保留旧定义，不开始清理，也不伪装整批回滚", () => sandbox((agentDir, directory) => {
	const profiles = standardAgentProfiles();
	const [first, blocked] = profiles;
	assert.ok(first && blocked);
	mkdirSync(join(directory, `${blocked.name}.md`), { recursive: true });
	const settingsPath = join(directory, "settings.json");
	const originalSettings = JSON.stringify({ version: 1, builtInEnabled: false, maxConcurrent: 7 });
	writeFileSync(settingsPath, originalSettings);
	const stalePath = join(directory, "tsgw-retired-fixture.md");
	writeFileSync(stalePath, "写入失败后必须保留");
	assert.throws(() => installStandardAgents(agentDir));
	assert.equal(readFileSync(join(directory, `${first.name}.md`), "utf8"), first.content);
	assert.equal(readFileSync(stalePath, "utf8"), "写入失败后必须保留");
	assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
}));
