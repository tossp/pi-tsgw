import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const skillsRoot = join(root, "skills");

test("随包技能目录包含 SKILL.md 入口文件", () => {
	for (const entry of readdirSync(skillsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		assert.ok(existsSync(join(skillsRoot, entry.name, "SKILL.md")), `缺少技能入口：${entry.name}`);
	}
});

test("提交技能的仓库发现支持普通仓库、worktree 与换行文件名，且只读", async t => {
	const directory = await mkdtemp(join(tmpdir(), "tsgw-skill-git-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	Object.assign(env, { HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory,
		GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(directory, "no-global-config"), GIT_TERMINAL_PROMPT: "0" });
	const git = (path: string, ...args: string[]): string => {
		const result = spawnSync("git", ["-C", path, ...args], { env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	const repo = join(directory, "main repo");
	await mkdir(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.name", "技能测试");
	git(repo, "config", "user.email", "skill-test@example.invalid");
	await writeFile(join(repo, "base.txt"), "base");
	git(repo, "add", "--", "base.txt");
	git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "测试基线");
	const worktree = join(directory, "linked worktree");
	git(repo, "worktree", "add", "-b", "fixture", worktree);
	for (const name of ["one.txt", "line\nbreak.txt"]) {
		await writeFile(join(repo, name), "staged");
		git(repo, "add", "--", name);
	}
	await writeFile(join(repo, "untracked.txt"), "not staged");
	await writeFile(join(worktree, "two.txt"), "staged");
	git(worktree, "add", "--", "two.txt");
	const before = [git(repo, "status", "--porcelain=v1", "-z"), git(worktree, "status", "--porcelain=v1", "-z")];
	const script = join(skillsRoot, "tsgw-git-commit", "scripts", "discover-repos.mjs");
	const run = (path: string) => spawnSync(process.execPath, [script, "--json", path], { env, encoding: "utf8" });
	const result = run(directory);
	assert.equal(result.status, 0, result.stderr);
	const repositories = JSON.parse(result.stdout).repositories as { name: string; path: string; stagedFiles: number; branch: string }[];
	assert.deepEqual(repositories.map(repo => [repo.path, repo.stagedFiles, repo.branch]).sort(),
		[[repo, 2, "main"], [worktree, 1, "fixture"]].sort());
	assert.equal(JSON.parse(run(worktree).stdout).repositories.length, 1);
	assert.deepEqual([git(repo, "status", "--porcelain=v1", "-z"), git(worktree, "status", "--porcelain=v1", "-z")], before);
	const empty = join(directory, "empty");
	await mkdir(empty);
	assert.deepEqual(JSON.parse(run(empty).stdout), { repositories: [] });
	await writeFile(join(empty, ".git"), "gitdir: missing-directory\n");
	assert.notEqual(run(empty).status, 0, "损坏仓库不能伪装成没有暂存变更");
	assert.notEqual(run(join(directory, "missing")).status, 0);
});
