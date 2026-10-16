import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
		assert.equal(cells.length, 8, "每条参考行必须有六列");
		return [cells[2]!.replaceAll("`", ""), cells[3]!.replaceAll("`", "")];
	});
	assert.deepEqual(choices, expected, "保留各档位顺序与显式思考深度");
	const models = modelsForRoot(TEST_ROOT);
	const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	for (const [id, level] of choices) {
		const model = models.find((candidate) => candidate.id === id);
		assert.ok(model, `未注册的模型：${id}`);
		assert.ok(levels.includes(level as ThinkingLevel), `不是 Pi 思考档位：${level}`);
		assert.notEqual(model.thinkingLevelMap?.[level as ThinkingLevel], null, `${id}/${level} 已禁用`);
	}
	for (const id of ["glm-5.3", "glm-5.3-flash", "glm-5.3-flashx"]) {
		const model = models.find((candidate) => candidate.id === id)!;
		assert.ok(model, `GLM 备选模型必须保持注册：${id}`);
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

test("DeepSeek 技能价格与目录共用国内高峰价基准", () => {
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
		assert.deepEqual(expectedNames, [
			"tsgw-delegate-model-selection", "tsgw-git-commit", "tsgw-github", "tsgw-mk-docs",
			"tsgw-programmer-go", "tsgw-smemo",
		]);
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
		assert.match(skill.description, /背景执行/);
		assert.match(skill.description, /尽量遵循/);
		assert.match(formatSkillsForPrompt([skill]), /<name>tsgw-delegate-model-selection<\/name>/);
		const body = readFileSync(skill.filePath, "utf8");
		assert.match(body, /^\| 任务等级 \| 模型 \| 思考深度 \| 评分 \| 输入价 \| 输出价 \|$/m,
			"加载的技能必须包含选型表");
		const smemoLoader = makeLoader(["skills/tsgw-smemo"]);
		await smemoLoader.reload();
		assert.deepEqual(smemoLoader.getSkills().diagnostics, []);
		assert.deepEqual(smemoLoader.getSkills().skills.map(skill => skill.name), ["tsgw-smemo"]);
		const smemo = smemoLoader.getSkills().skills[0]!;
		assert.equal(smemo.filePath, join(root, "skills", "tsgw-smemo", "SKILL.md"));
		assert.equal(smemo.baseDir, join(root, "skills", "tsgw-smemo"));
		assert.equal(smemo.sourceInfo.origin, "package");
		assert.equal(smemo.disableModelInvocation, false);
		assert.match(smemo.description, /Blinko/);
		assert.match(formatSkillsForPrompt([smemo]), /<name>tsgw-smemo<\/name>/);
		const smemoBody = readFileSync(smemo.filePath, "utf8");
		for (const boundary of [
			"个人倾向性信息", "具体现场事实", "密钥、凭据", "永久删除",
			"维护授权不扩展到文件、Git、服务、凭据、访问权限或定时任务",
			"明确外部调研仍须历史查询、当前核验与自动沉淀",
		]) assert.ok(smemoBody.includes(boundary), `smemo 技能缺少职责／授权边界：${boundary}`);
		assert.match(smemoBody, /\[Blinko 操作指南\]\(\.\/references\/blinko-guide\.md\)/);
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
