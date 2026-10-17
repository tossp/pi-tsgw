import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { HostSandbox } from "./host-test-support.test.ts";

function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const path = join(dir, "package.json");
		if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === "pi-tsgw") return dir;
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "无法定位 pi-tsgw 包根目录");
		dir = parent;
	}
}

const root = packageRoot();
const skillDir = join(root, "skills", "tsgw-delegate-model-selection");
const skillPath = join(skillDir, "SKILL.md");

// 只验证技能发现、资源归属与过滤，不绑定技能正文、参数示例或选型表内容。
test("Pi SDK 通过包清单发现随包技能并遵守过滤规则", { timeout: 60_000 }, async () => {
	const sandbox = new HostSandbox();
	try {
		const { DefaultResourceLoader, formatSkillsForPrompt, SettingsManager } =
			await import("@earendil-works/pi-coding-agent");
		const makeLoader = (skills?: string[]) => new DefaultResourceLoader({
			cwd: sandbox.cwd, agentDir: sandbox.agentDir,
			settingsManager: SettingsManager.inMemory({
				packages: [{ source: root, extensions: [], prompts: [], themes: [], ...(skills ? { skills } : {}) }],
			}),
			noExtensions: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		});
		const expectedNames = readdirSync(join(root, "skills"), { withFileTypes: true })
			.filter(entry => entry.isDirectory() && existsSync(join(root, "skills", entry.name, "SKILL.md")))
			.map(entry => entry.name).sort();
		assert.ok(expectedNames.length > 0);
		const loader = makeLoader();
		await loader.reload();
		assert.deepEqual(loader.getSkills().diagnostics, []);
		assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), expectedNames,
			"默认加载所有随包技能，不加载个人资源");
		for (const loaded of loader.getSkills().skills) {
			assert.equal(loaded.filePath, join(root, "skills", loaded.name, "SKILL.md"));
			assert.equal(loaded.sourceInfo.origin, "package");
		}
		const imageSkill = loader.getSkills().skills.find(skill => skill.name === "tsgw-image-generation");
		assert.ok(imageSkill, "生图技能必须由包清单发现");
		assert.equal(imageSkill.disableModelInvocation, false);
		assert.match(formatSkillsForPrompt([imageSkill]), /<name>tsgw-image-generation<\/name>/);
		const selected = makeLoader(["skills/tsgw-delegate-model-selection"]);
		await selected.reload();
		assert.deepEqual(selected.getSkills().diagnostics, []);
		assert.equal(selected.getSkills().skills.length, 1, "可仅选择一个随包技能");
		const skill = selected.getSkills().skills[0]!;
		assert.equal(skill.name, "tsgw-delegate-model-selection");
		assert.equal(skill.filePath, skillPath);
		assert.equal(skill.baseDir, skillDir);
		assert.equal(skill.sourceInfo.origin, "package");
		assert.equal(skill.disableModelInvocation, false);
		assert.match(formatSkillsForPrompt([skill]), /<name>tsgw-delegate-model-selection<\/name>/);
		await loader.reload();
		assert.deepEqual(loader.getSkills().diagnostics, []);
		assert.deepEqual(loader.getSkills().skills.map(skill => skill.name).sort(), expectedNames, "重载不得重复加载技能");
		const excluded = makeLoader(["!skills/tsgw-git-commit/**"]);
		await excluded.reload();
		assert.deepEqual(excluded.getSkills().diagnostics, []);
		assert.deepEqual(excluded.getSkills().skills.map(skill => skill.name).sort(),
			expectedNames.filter(name => name !== "tsgw-git-commit"), "排除指定技能而保留其他资源");
		const filtered = makeLoader([]);
		await filtered.reload();
		assert.deepEqual(filtered.getSkills(), { skills: [], diagnostics: [] });
		assert.deepEqual(sandbox.blocked, [], "技能发现不得发起网络请求");
	} finally {
		sandbox.restore();
	}
});
