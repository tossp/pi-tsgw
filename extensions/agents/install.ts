import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { standardAgentProfiles } from "./profiles.ts";

export interface AgentInstallation {
	directory: string;
	installed: string[];
	removed: string[];
}

/** 先覆盖当前定义，全部写入成功后才清理退出清单的旧定义；不维护额外状态。 */
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
	return { directory, installed: [...currentFiles], removed };
}
