# AIH request operations

`src/index.ts` is the sole Pi auto-loaded entry point.  It registers one
`before_provider_request` handler that calls the pure,
copy-on-write `applyModelOperations()` function in `operations.ts`.  It does
not log request payloads and does not make network calls.

## Thinking profile matrix

| Alias family | `off` | `high` | `xhigh` / `max` |
| --- | --- | --- | --- |
| DeepSeek V4 | `thinking.type=disabled`, remove generic effort | enabled + `reasoning_effort=high` | enabled + `reasoning_effort=max` |
| GLM 5.1 / 5.2 | disabled + `reasoning_effort=none` | enabled + `clear_thinking=false` + `high` | enabled + `clear_thinking=false` + `max` |
| MiMo / Kimi Coding | disabled, remove generic effort | enabled, remove generic effort | enabled, remove generic effort |
| MiniMax M3 | disabled + `reasoning_split=true` | adaptive + split | adaptive + split |
| Kimi K3 | remove `thinking` and effort | remove `thinking`, effort `high` | `xhigh=high`, `max=max` |
| LongCat 2.0 | disabled, remove generic effort | enabled, remove generic effort | enabled, remove generic effort |
| Qwen 3.7 | thinking/preserve false; remove budget options | thinking/preserve true + 6000/agent-max/code-interpreter | same as high |
| Gemini Flash | thoughts false, budget 0 | thoughts true, budget 16000 | `xhigh=16000`, `max=24576` |
| Gemini Pro | thoughts false + `thinkingLevel=LOW` | thoughts true + `HIGH` | `HIGH` |
| GPT Responses | retain Pi's `reasoning`; set `service_tier=flex`, text verbosity by alias | same | same |
| Claude | Pi native adaptive thinking; no operation | no operation | no operation |

For GLM, `tool_stream=true` is added only when the already-built payload has
`stream === true`.  Lower GLM levels retain Pi's existing native mapping rather
than inventing an unverified provider strength.  LongCat is explicitly an
OC/AIH compatibility policy because its public HTTP thinking schema was not
verified.  The extension does not tighten `models.ts` thinking maps, so no
model's current default `medium` level is newly clamped.

For the OpenAI Responses aliases, the installed Pi 0.82.0 implementation and
the Responses wire schema use `text: { verbosity: ... }` (not `textVerbosity`
or camelCase).  Existing `reasoning`, `include`, `store`, and
`parallel_tool_calls` remain untouched.

## Web search

`AIH_WEB_SEARCH` accepts only `off` (default), `cached`, and `live`.  For
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, and `gpt-5.5` using the
AIH/OpenAI Responses API, a missing `tools` field or an existing tools array
gets this append-only operation unless any `web_search*` tool is already
present:

```json
{
  "type": "web_search",
  "search_context_size": "medium",
  "external_web_access": false
}
```

`cached` uses `false`; `live` uses `true`. Existing function tools,
`tool_choice`, and `include` are preserved. Pi 0.82.0 drops requested sources,
so this operation deliberately does not request them.

## Pi 0.82.0 lifecycle compatibility

Pi 0.82.0 can deliver `before_provider_request` and
`before_provider_headers` from an old runner after that runner's context has
been invalidated.  These two handlers therefore never read `ctx` or `pi`.
Each loaded extension instance keeps only a private scalar snapshot of the
selected provider, model ID, API, base URL, and thinking level.

The snapshot is refreshed from a fresh context at `session_start` and
`agent_start`; `model_select` updates its model fields and
`thinking_level_select` updates its level.  It is deliberately retained on
`session_shutdown`, so a late callback from an old instance can safely apply
the state it captured.  The tracing hook uses that same snapshot and retains
the existing `AIH_TRACE_HEADERS=1` gate and the configured-root restriction.

## Scope and known limits

Only declared root fields, the three declared Google
`config.thinkingConfig` fields, and the dedicated web-search append can
change. There is no generic JSON Patch, history/messages rewrite, response
parser, auth/header/URL alteration, cache-key alteration, or token-limit
alteration.

Reasoning-content replay continues to depend on Pi's adapter. Full MiniMax
`reasoning_details` and citation support is outside this extension's scope.
