/**
 * 四个标准子代理的宿主 Markdown 定义。
 *
 * 只生成文件内容，不读写磁盘、不安装；同名文件由调用方直接覆盖。四者的能力与加载开关完全一致，
 * 唯一差别是名称、显示名、说明和默认方法提示词。工具与技能的实际可用性以宿主当时提供的为准，
 * 提示词不写死具体搜索工具名，也不复制技能正文。
 */

import { GENERAL_AGENT_PROMPT } from "#tsgw-prompts/agents/tsgw-general";
import { RESEARCH_AGENT_PROMPT } from "#tsgw-prompts/agents/tsgw-research";
import { ADVISOR_AGENT_PROMPT } from "#tsgw-prompts/agents/tsgw-advisor";
import { REVIEWER_AGENT_PROMPT } from "#tsgw-prompts/agents/tsgw-reviewer";

export const STANDARD_AGENT_NAMES = ["tsgw-general", "tsgw-research", "tsgw-advisor", "tsgw-reviewer"] as const;

export type StandardAgentName = (typeof STANDARD_AGENT_NAMES)[number];

interface StandardAgentRole {
  readonly name: StandardAgentName;
  readonly displayName: string;
  readonly description: string;
  readonly method: string;
}

/**
 * 统一能力与加载配置：只在本文件维护一份，四个角色共用。
 * codemode/mcp 写字符串 `on`，并同时给出 `skills`/`extensions` 别名，兼容读取别名的宿主。
 */
const STANDARD_AGENT_SETTINGS = {
  tools: "read, bash, edit, write, grep, find, ls",
  loadSkills: true,
  loadExtensions: true,
  codemode: "on",
  mcp: "on",
  enabled: true,
  inheritContext: false,
  runInBackground: true,
  promptMode: "append",
} as const;

/** 角色方法：默认做法而非权限裁剪；验证、修改与外发仍以主代理本次授权为准。 */
const STANDARD_AGENT_ROLES: readonly StandardAgentRole[] = [
  {
    name: "tsgw-general",
    displayName: "通用执行器",
    description: "通用执行兜底：承接明确委派的实现、修改或排查任务",
    method: GENERAL_AGENT_PROMPT,
  },
  {
    name: "tsgw-research",
    displayName: "调研查询",
    description: "查询调研：收集可核验证据并回答明确问题",
    method: RESEARCH_AGENT_PROMPT,
  },
  {
    name: "tsgw-advisor",
    displayName: "顾问规划",
    description: "顾问规划：给出有取舍依据的可执行方案",
    method: ADVISOR_AGENT_PROMPT,
  },
  {
    name: "tsgw-reviewer",
    displayName: "审阅验收",
    description: "审阅验收：独立核对改动是否满足目标与验收条件",
    method: REVIEWER_AGENT_PROMPT,
  },
];

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderStandardAgent(role: StandardAgentRole): string {
  const settings = STANDARD_AGENT_SETTINGS;
  return [
    "---",
    `description: ${yamlString(role.description)}`,
    `display_name: ${yamlString(role.displayName)}`,
    `tools: ${yamlString(settings.tools)}`,
    `load_skills: ${settings.loadSkills}`,
    `load_extensions: ${settings.loadExtensions}`,
    `codemode: '${settings.codemode}'`,
    `mcp: '${settings.mcp}'`,
    `enabled: ${settings.enabled}`,
    `inherit_context: ${settings.inheritContext}`,
    `run_in_background: ${settings.runInBackground}`,
    `prompt_mode: ${settings.promptMode}`,
    `skills: ${settings.loadSkills}`,
    `extensions: ${settings.loadExtensions}`,
    "---",
    "",
    role.method.trim(),
    "",
  ].join("\n");
}

/** 按标准顺序返回四个代理的宿主定义；content 为完整 Markdown 文件内容。 */
export function standardAgentProfiles(): Array<{ name: string; content: string }> {
  return STANDARD_AGENT_ROLES.map((role) => ({ name: role.name, content: renderStandardAgent(role) }));
}
