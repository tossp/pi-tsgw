import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { modelsForRoot } from "./models/catalog.ts";
import { type ThinkingLevel } from "./models/_tools.ts";
import { HostSandbox, TEST_ROOT } from "./host-test-support.test.ts";

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

// 这些测试验证打包、Pi 名称及本地映射，不验证模型质量、
// 当前价格、技能自动调用或真实子代理执行。
test("选型表使用已注册 ID 与 Pi 思考档位", () => {
	const reference = readFileSync(skillPath, "utf8");
	const rows = reference.split("\n").filter((line) => /^\| [^|]+ \| `/.test(line));
	const choices = rows.map((row) => {
		const cells = row.split("|").map((cell) => cell.trim());
		assert.equal(cells.length, 8, "每条参考行必须有六列");
		return [cells[2]!.replaceAll("`", ""), cells[3]!.replaceAll("`", "")];
	});
	assert.ok(choices.length > 0, "选型表不能为空");
	const models = modelsForRoot(TEST_ROOT);
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	for (const [id, level] of choices) {
		const model = models.find((candidate) => candidate.id === id);
		assert.ok(model, `未注册的模型：${id}`);
		assert.ok(levels.includes(level as ThinkingLevel), `不是 Pi 思考档位：${level}`);
		assert.notEqual(model.thinkingLevelMap?.[level as ThinkingLevel], null, `${id}/${level} 已禁用`);
	}
});

test("DeepSeek 技能价格与目录共用国内高峰价基准", () => {
	const reference = readFileSync(skillPath, "utf8");
	const row = reference.split("\n").find((line) => line.includes("| `deepseek-flash` | `max` |"));
	assert.ok(row);
	const cells = row.split("|").map((cell) => cell.trim());
	const input = cells[5]!.split("–").map(Number);
	const output = cells[6]!.split("–").map(Number);
	for (const range of [input, output]) {
		assert.equal(range.length, 2);
		assert.ok(range.every(Number.isFinite) && range[0]! > 0 && range[0]! <= range[1]!);
	}
	const model = modelsForRoot(TEST_ROOT).find(({ id }) => id === "deepseek-flash")!;
	assert.equal(model.cost.input, input[1]);
	assert.equal(model.cost.output, output[1]);
});

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
			assert.match(loaded.name, /^tsgw-/);
			assert.equal(loaded.filePath, join(root, "skills", loaded.name, "SKILL.md"));
			assert.equal(loaded.sourceInfo.origin, "package");
		}
		const imageSkill = loader.getSkills().skills.find(skill => skill.name === "tsgw-image-generation");
		assert.ok(imageSkill, "生图技能必须由包清单发现");
		assert.equal(imageSkill.disableModelInvocation, false);
		assert.match(imageSkill.description, /生成图片、生图或画图/);
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
