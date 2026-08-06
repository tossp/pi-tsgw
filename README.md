# pi-tsgw

Pi extension for the TOSSP AIH gateway. Registers the `aih` provider with a
model catalog spanning four wire protocols (openai-completions,
openai-responses, anthropic, gemini) and applies per-model request-body
operations so thinking levels, reasoning formats, and optional web search
behave correctly on the gateway.

No API keys, endpoints, or pricing are baked into this package: everything
gateway-specific is configuration.

## Install

```bash
pi install git:github.com/<you>/pi-tsgw
```

or, for npm:

```bash
pi install npm:pi-tsgw
```

Then `/reload` (or restart pi). The provider appears as `aih` in the model
picker.

## Configuration

### Gateway address

Point the extension at your AIH gateway (any instance — the public one or a
self-hosted one). Resolution order:

1. `settings.json` — `"aih": { "baseUrl": "https://aih.example.net" }`
2. `AIH_BASE_URL` environment variable
3. built-in placeholder (`https://aih.example.com`, which will not work)

Example `~/.pi/agent/settings.json`:

```json
{
  "aih": {
    "baseUrl": "https://aih.example.net",
    "webSearch": "live",
    "traceHeaders": false
  }
}
```

### API key

The extension never reads credential files. Pi resolves the key itself, in
this order (per the pi-ai auth resolution):

1. **`/login`** — select the AIH provider and enter the key; pi stores it in
   `~/.pi/agent/auth.json`
2. **`AIH_API_KEY`** environment variable — used when nothing is stored

### Options

| Setting (settings.json `aih.*`) | Env fallback | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | `AIH_BASE_URL` | placeholder | Gateway root (the `/v1` suffix is normalized away) |
| `webSearch` | `AIH_WEB_SEARCH` | `off` | `off`, `cached`, or `live` — appends the Responses `web_search` tool for the GPT aliases when missing |
| `traceHeaders` | `AIH_TRACE_HEADERS=1` | `false` | Adds `AH-Thread-Id` / `AH-Trace-Id` headers for gateway-side tracing |

## Model catalog

`models.ts` is the static catalog. Pricing entries mirror the vendors' public
list prices (input/output/cache per 1M tokens); replace them with your
gateway's actual pricing if it differs. Model-level `compat`,
`thinkingLevelMap`, and `baseUrl` entries are what let pi dispatch four wire
protocols through the single `aih` provider id.

## Thinking profiles

See [README in the source tree](src/README.md) for the full per-family
thinking matrix (DeepSeek, GLM, MiMo/Kimi, MiniMax, Kimi K3, LongCat, Qwen,
Gemini, GPT Responses, Claude), the web-search append semantics, and the pi
lifecycle compatibility notes (state snapshots for stale runners).

## Development

```bash
bun install
bun test
```

Tests run against a fake pi host (`FakePi` + `FakeContext`) and isolate the
config directory through `PI_CODING_AGENT_DIR`, so no pi installation is
needed to run them.

## Scope and known limits

Only declared root fields, the three declared Google
`config.thinkingConfig` fields, and the dedicated web-search append can
change. There is no generic JSON Patch, history/messages rewrite, response
parser, auth/header/URL alteration, cache-key alteration, or token-limit
alteration. Reasoning-content replay depends on pi's adapter; full MiniMax
`reasoning_details` and citation support is outside this extension's scope.
