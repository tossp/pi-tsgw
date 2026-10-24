import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { standardAgentProfiles } from "./profiles.ts";

export interface AgentInstallation {
	directory: string;
	installed: string[];
	removed: string[];
}

/** 沿用 Pi Web 的设置：启用 Agent 工具，按名称停用内置档案，不关闭整个功能。 */
function disableBuiltInProfiles(directory: string): void {
	const path = join(directory, "settings.json");
	let stored: unknown = {};
	if (existsSync(path)) {
		try {
			stored = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new Error("无法读取或解析子代理 settings.json", { cause: error });
		}
	}
	if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
		throw new Error("子代理 settings.json 必须是 JSON 对象");
	}
	const settings = stored as Record<string, unknown>;
	const disabled = Array.isArray(settings.disabledBuiltIns) ? [...settings.disabledBuiltIns] : [];
	for (const name of ["general-purpose", "explore", "plan"]) {
		if (!disabled.some(entry => typeof entry === "string" && entry.trim().toLowerCase() === name)) disabled.push(name);
	}
	writeFileSync(path, `${JSON.stringify({
		...settings, version: 1, builtInEnabled: true, disabledBuiltIns: disabled,
	}, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** 先写当前定义并清理旧定义，再更新宿主设置；不维护额外状态。 */
export function installStandardAgents(agentDir: string): AgentInstallation {
	const directory = join(agentDir, "agents");
	const profiles = standardAgentProfiles();
	const currentFiles = new Set(profiles.map(profile => `${profile.name}.md`));
	mkdirSync(directory, { recursive: true });
	for (const profile of profiles) {
		writeFileSync(join(directory, `${profile.name}.md`), profile.content, "utf8");
	}
	const removed: string[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.startsWith("tsgw-") || !name.endsWith(".md") || currentFiles.has(name)) continue;
		unlinkSync(join(directory, name));
		removed.push(name);
	}
	disableBuiltInProfiles(directory);
	return { directory, installed: [...currentFiles], removed };
}
