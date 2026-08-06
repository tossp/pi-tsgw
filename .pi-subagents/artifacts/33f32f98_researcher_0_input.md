# Task for researcher

查证 Anthropic Claude 官方定价与模型规格（来源：https://docs.claude.com/en/docs/about-claude/models/ 和官方 pricing 页）。需要以下模型的规格：claude-opus-4、claude-opus-4.1、claude-opus-4.5、claude-opus-4.6、claude-opus-4.7、claude-sonnet-4、claude-sonnet-4.5、claude-sonnet-5。每个模型返回：官方全名、contextWindow、maxTokens、输入模态（text/image）、官方公开定价（USD/百万token：input、output、cacheRead、cacheWrite）。查不到的字段标 null，不得臆造。输出格式：JSON 数组 [{"id":"claude-opus-4","name":"...","contextWindow":N,"maxTokens":N,"input":["text"],"cost":{"input":N,"output":N,"cacheRead":N,"cacheWrite":N},"source":"URL"}]，最后附一段说明哪些字段未能从官方确认。

---
**Output:**
Write your findings to exactly this path: /root/proj/pi-tsgw/.pi-subagents/artifacts/outputs/33f32f98/research.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```