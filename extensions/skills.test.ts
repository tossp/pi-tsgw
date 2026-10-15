import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { modelsForRoot } from "./models/catalog.ts";
import { applyModelOperations } from "./models/operations.ts";
import { type ThinkingLevel } from "./models/_tools.ts";
import { HostSandbox, TEST_ROOT } from "./host-test-support.test.ts";

function packageRoot(): string {
	let dir = dirname(fileURLToPath(import.meta.url));
	while (true) {
		const path = join(dir, "package.json");
		if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).name === "pi-tsgw") return dir;
		const parent = dirname(dir);
		assert.notEqual(parent, dir, "Cannot locate pi-tsgw package root");
		dir = parent;
	}
}

const root = packageRoot();
const skillDir = join(root, "skills", "delegate-model-selection");
const skillPath = join(skillDir, "SKILL.md");

// These tests validate packaging, Pi names and local mappings, not model quality,
// current prices, automatic skill invocation, or live subagent execution.
test("selection table uses registered IDs and Pi thinking levels", () => {
	const reference = readFileSync(skillPath, "utf8");
	const rows = reference.split("\n").filter((line) => /^\| [^|]+ \| `/.test(line));
	const expected = [
		["MiniMax-M3", "high"], ["gpt-6-luna", "high"],
		["glm-5.3", "low"], ["glm-5.3", "high"], ["glm-5.3", "max"],
		["gpt-6-luna", "max"], ["glm-5.3-flash", "max"], ["gpt-6.1-sol", "medium"],
		["deepseek-flash", "max"], ["gpt-6.1-sol", "high"],
		["gpt-6.1-sol", "xhigh"], ["gpt-6-astra", "high"],
		["gpt-6-astra", "xhigh"], ["gpt-6.1-sol", "max"],
		["gpt-6-astra", "max"], ["kimi-k3", "high"],
	];
	const choices = rows.map((row) => {
		const cells = row.split("|").map((cell) => cell.trim());
		assert.equal(cells.length, 8, "Each reference row must have six columns");
		return [cells[2]!.replaceAll("`", ""), cells[3]!.replaceAll("`", "")];
	});
	assert.deepEqual(choices, expected, "Preserve per-tier order and explicit thinking levels");
	const models = modelsForRoot(TEST_ROOT);
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	for (const [id, level] of choices) {
		const model = models.find((candidate) => candidate.id === id);
		assert.ok(model, `Unregistered model: ${id}`);
		assert.ok(levels.includes(level as ThinkingLevel), `Not a Pi thinking level: ${level}`);
		assert.notEqual(model.thinkingLevelMap?.[level as ThinkingLevel], null, `${id}/${level} is disabled`);
	}
	for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
		const model = models.find((candidate) => candidate.id === id)!;
		assert.ok(model, `GLM alternative must remain registered: ${id}`);
		assert.equal(model.thinkingLevelMap?.off, null);
		for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
			const effort = level === "medium" ? "high" : level === "xhigh" ? "max" : level;
			assert.equal(model.thinkingLevelMap?.[level], effort);
			const mapped = applyModelOperations(Object.freeze({}), {
				provider: "tsgw", modelId: id, api: "openai-completions",
				thinkingLevel: level, tsSearchMode: "live",
			});
			assert.deepEqual(mapped, {
				thinking: { type: "enabled", ...(level === "low" || level === "medium" ? {} : { clear_thinking: false }) },
				reasoning_effort: effort,
			});
		}
	}
	const glmPrices = { "glm-5.3": [1.18, 4.13], "glm-5.3-flash": [0.118, 0.413] };
	for (const row of rows) {
		const cells = row.split("|").map((cell) => cell.trim().replaceAll("`", ""));
		const prices = glmPrices[cells[2] as keyof typeof glmPrices];
		if (prices) assert.deepEqual([Number(cells[5]), Number(cells[6])], prices);
	}
	assert.ok(rows.some((row) => row.includes("`glm-5.3` | `high` | 待评")));
	assert.ok(rows.some((row) => row.includes("`glm-5.3` | `max` | 45")));
	assert.ok(rows.some((row) => row.includes("`glm-5.3-flash` | `max` | 42")));
	const input = Object.freeze({ reasoning_effort: "high", thinking: Object.freeze({ type: "legacy" }) });
	const mapped = applyModelOperations(input, {
		provider: "tsgw", modelId: "MiniMax-M3", api: "openai-completions",
		thinkingLevel: "high", tsSearchMode: "live",
	});
	assert.deepEqual(mapped, { thinking: { type: "adaptive" }, reasoning_split: true });
	assert.equal(input.reasoning_effort, "high");
	assert.equal(input.thinking.type, "legacy");
});

test("DeepSeek skill prices and catalog share the domestic peak-price baseline", () => {
	const reference = readFileSync(skillPath, "utf8");
	const row = reference.split("\n").find((line) => line.includes("| `deepseek-flash` | `max` |"));
	assert.ok(row);
	const cells = row.split("|").map((cell) => cell.trim());
	const input = cells[5]!.split("–").map(Number);
	const output = cells[6]!.split("–").map(Number);
	assert.deepEqual(input, [0.1475, 0.295]);
	assert.deepEqual(output, [0.59, 1.18]);
	const model = modelsForRoot(TEST_ROOT).find(({ id }) => id === "deepseek-flash")!;
	assert.equal(model.cost.input, input[1]);
	assert.equal(model.cost.output, output[1]);
	assert.match(reference, /静态目录采用区间高端，不自动按时段切换/);
});

test("Pi SDK discovers the bundled skill through the package manifest and respects filtering", { timeout: 60_000 }, async () => {
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
		const loader = makeLoader();
		await loader.reload();
		assert.deepEqual(loader.getSkills().diagnostics, []);
		assert.equal(loader.getSkills().skills.length, 1, "Only the bundled skill, no personal resources");
		const skill = loader.getSkills().skills[0]!;
		assert.equal(skill.name, "delegate-model-selection");
		assert.equal(skill.filePath, skillPath);
		assert.equal(skill.baseDir, skillDir);
		assert.equal(skill.sourceInfo.origin, "package");
		assert.equal(skill.disableModelInvocation, false);
		assert.match(skill.description, /背景执行/);
		assert.match(skill.description, /尽量遵循/);
		assert.match(formatSkillsForPrompt([skill]), /delegate-model-selection/);
		const body = readFileSync(skill.filePath, "utf8");
		assert.match(body, /^\| 任务等级 \| 模型 \| 思考深度 \| 评分 \| 输入价 \| 输出价 \|$/m,
			"The loaded skill must contain its selection table");
		await loader.reload();
		assert.deepEqual(loader.getSkills().diagnostics, []);
		assert.equal(loader.getSkills().skills.length, 1, "Reload must not duplicate the skill");
		const filtered = makeLoader([]);
		await filtered.reload();
		assert.deepEqual(filtered.getSkills(), { skills: [], diagnostics: [] });
		assert.deepEqual(sandbox.blocked, [], "Skill discovery must not make network requests");
	} finally {
		sandbox.restore();
	}
});
