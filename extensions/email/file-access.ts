import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { EmailError } from "./types.ts";

function within(path: string, root: string): boolean {
	const difference = relative(root, path);
	return difference === "" || (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
}

/** 附件只允许工作目录与临时目录；真实路径检查避免符号链接越出边界。 */
export async function emailFilePath(input: string, cwd: string, writing = false): Promise<string> {
	const path = resolve(cwd, input);
	const agentDir = resolve(getAgentDir());
	const roots = [resolve(cwd), resolve(tmpdir())];
	let canonical: string;
	let canonicalAgent: string;
	let canonicalRoots: string[];
	try {
		canonical = writing ? join(await realpath(dirname(path)), basename(path)) : await realpath(path);
		canonicalAgent = await realpath(agentDir).catch(() => agentDir);
		canonicalRoots = await Promise.all(roots.map(root => realpath(root)));
	} catch {
		throw new EmailError("FILE_UNAVAILABLE", "附件路径不存在或不可访问；未执行文件操作。");
	}
	// 即使 cwd 本身覆盖配置目录，也不能把凭据作为邮件附件或下载目标。
	if (within(path, agentDir) || within(canonical, canonicalAgent)
		|| !canonicalRoots.some(root => within(canonical, root)))
		throw new EmailError("FILE_NOT_ALLOWED", "附件仅允许当前工作目录或系统临时目录，且不得访问宿主配置目录。");
	return path;
}
