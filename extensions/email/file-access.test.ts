import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emailFilePath } from "./file-access.ts";

// 目录与凭据内容全为合成，连真实宿主配置目录的内容也不读取。
test("附件读写边界：工作/临时目录允许，配置/外部目录与越界符号链接拒绝", async () => {
	const root = mkdtempSync(join(tmpdir(), "email-file-policy-"));
	const cwd = join(root, "workspace");
	const temp = join(root, "temp");
	const agent = join(root, "agent");
	const outside = join(root, "outside");
	for (const path of [cwd, temp, agent, outside]) mkdirSync(path);
	for (const path of [join(cwd, "report.txt"), join(temp, "download.bin"), join(agent, "tsgw-email.json"), join(outside, "private.txt")])
		writeFileSync(path, "合成内容");
	const previousAgent = process.env.PI_CODING_AGENT_DIR;
	const previousTemp = process.env.TMPDIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	process.env.TMPDIR = temp;
	try {
		assert.equal(await emailFilePath("report.txt", cwd), join(cwd, "report.txt"));
		assert.equal(await emailFilePath(join(temp, "download.bin"), cwd), join(temp, "download.bin"));
		assert.equal(await emailFilePath("new.bin", cwd, true), join(cwd, "new.bin"));
		await assert.rejects(emailFilePath(join(outside, "private.txt"), cwd), /附件仅允许/);
		await assert.rejects(emailFilePath(join(agent, "tsgw-email.json"), cwd), /附件仅允许/);
		await assert.rejects(emailFilePath(join(agent, "new.json"), cwd, true), /附件仅允许/);
		await assert.rejects(emailFilePath(join(agent, "tsgw-email.json"), root), /附件仅允许/, "cwd覆盖agent时也不能读取凭据");
		await assert.rejects(emailFilePath("https://example.invalid/file", cwd), /路径不存在或不可访问/);
		symlinkSync(join(outside, "private.txt"), join(cwd, "external-link"));
		await assert.rejects(emailFilePath("external-link", cwd), /附件仅允许/);
		symlinkSync(join(agent, "tsgw-email.json"), join(cwd, "credential-link"));
		await assert.rejects(emailFilePath("credential-link", cwd), /附件仅允许/);
		symlinkSync(agent, join(cwd, "config-directory"));
		await assert.rejects(emailFilePath("config-directory/new.json", cwd, true), /附件仅允许/);
		symlinkSync(join(cwd, "report.txt"), join(cwd, "safe-link"));
		assert.equal(await emailFilePath("safe-link", cwd), join(cwd, "safe-link"));
		await assert.rejects(emailFilePath("missing", cwd), /路径不存在或不可访问/);
		await assert.rejects(emailFilePath("missing-directory/new.bin", cwd, true), /路径不存在或不可访问/);
	} finally {
		if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgent;
		if (previousTemp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTemp;
		rmSync(root, { recursive: true, force: true });
	}
});
