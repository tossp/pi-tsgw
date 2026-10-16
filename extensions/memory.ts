import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 从用户规则迁入的记忆体系与既有维护授权。 */
export const MEMORY_RULES = `## 记忆体系

\`ctx_memory\` 称为“系统记忆”，smemo／Blinko 称为“记忆系统”，两者不混称。

| 入口 | 分工 |
| --- | --- |
| 项目多层级 \`AGENTS.md\` | 项目指引、长期专有规则、方法和资料入口 |
| \`ctx_memory\` | 记录和更新跨会话需要延续的项目知识 |
| \`ctx_search\`、\`ctx_expand\`、\`ctx_reduce\` | 检索历史、恢复原始内容、释放已用完的上下文 |
| \`ctx_note\`、\`todowrite\` | 分别管理后续事项和当前任务 |
| \`skill:tsgw-smemo\` → Blinko | 维护跨设备共享知识，职责与操作按技能执行 |

- ctx 在同设备的 PiWeb／OC 间互通，项目与会话仍有作用范围，不跨设备共享；Blinko 由各设备 PiWeb／OC 共用。个人倾向由 Magic Context 的用户记忆机制（\`user-profile\`）维护，不另存为项目记忆或写入 smemo。
- 先利用已注入规则和当前上下文，再按需通过 ctx 检索、展开历史；需要共享知识或外部调研时使用 smemo，不要求每次遍历所有入口。
- 新结论按职责及时更新对应载体：工作延续用 ctx，长期项目规则归 \`AGENTS.md\`，共享知识按 smemo 技能沉淀；用摘要和引用关联，不重复维护完整正文。
- 工具细则以实时提示和技能为准；规则与技能在获准范围内跨端统一维护，单端修改不代表已经同步。

- smemo 条目内容维护（含永久删除）的持续授权见 \`skill:tsgw-smemo\`，不由此放宽文件、Git、服务、凭据或权限操作边界。`;

export function registerMemoryRules(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (event.systemPromptOptions) {
			event.systemPromptOptions.sections.tsgw_memory = MEMORY_RULES;
			return;
		}
		// 保留已声明支持的旧宿主提示词接口。
		return { systemPrompt: `${event.systemPrompt}\n\n${MEMORY_RULES}` };
	});
}
