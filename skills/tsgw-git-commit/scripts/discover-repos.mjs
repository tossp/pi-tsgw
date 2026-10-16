#!/usr/bin/env node
// 只读检查目标及直接子目录，不读取凭据、不修改工作区或暂存区。
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function git(path, args, allowFailure = false) {
	const result = spawnSync("git", ["-C", path, ...args], {
		encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.error || result.signal || result.status !== 0) {
		if (allowFailure && !result.error && !result.signal && result.status === 1) return null;
		throw new Error(`Git 检查失败：${path}（${args[0]}）`);
	}
	return result.stdout;
}

export function discoverRepositories(projectRoot) {
	const root = realpathSync(resolve(projectRoot));
	if (!statSync(root).isDirectory()) throw new Error("目标必须是目录。");
	const candidates = [root, ...readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && entry.name !== ".git")
		.map(entry => join(root, entry.name))];
	const repositories = [];
	const seen = new Set();
	for (const candidate of candidates) {
		// 普通仓库是目录，worktree 和 submodule 通常是文件；由 Git 核验真实根目录。
		if (!existsSync(join(candidate, ".git"))) continue;
		const path = realpathSync(git(candidate, ["rev-parse", "--show-toplevel"]).trim());
		if (seen.has(path)) continue;
		seen.add(path);
		const staged = git(path, ["diff", "--cached", "--name-only", "-z"]);
		const stagedFiles = staged.split("\0").filter(Boolean).length;
		if (stagedFiles === 0) continue;
		const branch = git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], true)?.trim()
			?? `detached:${git(path, ["rev-parse", "--short", "HEAD"]).trim()}`;
		repositories.push({ name: basename(path), path, stagedFiles, branch });
	}
	return { repositories };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const paths = args.filter(arg => arg !== "--json");
	try {
		if (paths.length !== 1 || paths[0].startsWith("--"))
			throw new Error("用法：node discover-repos.mjs [--json] <project-root>");
		const result = discoverRepositories(paths[0]);
		if (args.includes("--json")) console.log(JSON.stringify(result, null, 2));
		else if (result.repositories.length === 0) console.log("未发现有暂存变更的仓库。");
		else for (const repo of result.repositories)
			console.log(`${repo.name}：${repo.path}（${repo.branch}，${repo.stagedFiles} 个暂存文件）`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : "仓库检查失败。");
		process.exitCode = 1;
	}
}
