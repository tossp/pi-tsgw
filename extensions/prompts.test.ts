import assert from "node:assert/strict";
import { test } from "node:test";
import { MEMORY_RULES } from "../prompts/memory.ts";
import { createPi } from "./test-support.test.ts";

test("记忆规则：入口注册、保留其他分区且重复注入不累加", async () => {
	const pi = await createPi();
	assert.equal(pi.has("before_agent_start"), true);
	const sections = { other_extension: "保留其他扩展的提示词" } as Record<string, string>;
	const options = { sections, customPrompt: "保留宿主前缀", appendSystemPrompt: "保留用户追加提示词" };
	for (const messageType of ["user", "custom"]) {
		assert.equal(pi.invoke("before_agent_start", {
			type: "before_agent_start", messageType,
			systemPrompt: "保留完整宿主提示词", systemPromptOptions: options,
		}), undefined);
		assert.deepEqual(sections, { other_extension: "保留其他扩展的提示词", tsgw_memory: MEMORY_RULES });
		assert.equal(options.customPrompt, "保留宿主前缀");
		assert.equal(options.appendSystemPrompt, "保留用户追加提示词");
	}
});

test("记忆规则：旧宿主接口仅追加、不覆盖原提示词", async () => {
	const pi = await createPi();
	assert.deepEqual(pi.invoke("before_agent_start", {
		type: "before_agent_start", messageType: "user", systemPrompt: "原始提示词",
	}), { systemPrompt: `原始提示词\n\n${MEMORY_RULES}` });
});

test("记忆规则：保留原有职责、共享边界及条目维护授权", () => {
	for (const text of [
		"`ctx_memory` 称为“系统记忆”",
		"smemo／Blinko 称为“记忆系统”",
		"`skill:tsgw-smemo` → Blinko",
		"不跨设备共享",
		"不另存为项目记忆或写入 smemo",
		"不要求每次遍历所有入口",
		"用摘要和引用关联，不重复维护完整正文",
		"单端修改不代表已经同步",
		"smemo 条目内容维护（含永久删除）的持续授权",
		"不由此放宽文件、Git、服务、凭据或权限操作边界",
	]) assert.ok(MEMORY_RULES.includes(text), `不得丢失原规则：${text}`);
});
