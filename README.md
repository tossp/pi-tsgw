# pi-tsgw

Pi extension for the TOSSP AIH gateway. Registers the `tsgw` provider with a
model catalog spanning four wire protocols (openai-completions,
openai-responses, anthropic-messages, google-generative-ai) and applies
per-vendor request-body operations so thinking levels, reasoning formats, and
optional built-in web search behave correctly on the gateway.

No API keys, endpoints, or pricing are baked into this package: everything
gateway-specific is configuration.

## Install

```bash
pi install git:github.com/tossp/pi-tsgw
```

or, for npm:

```bash
pi install npm:pi-tsgw
```

Then `/reload` (or restart pi). The provider appears as `tsgw` in the model
picker.

## Configuration

All configuration lives in the `tsgw` namespace of `~/.pi/agent/settings.json`.
The plugin reads no environment variables; only Pi's own credential
resolution handles API keys.

Example:

```json
{
  "tsgw": {
    "baseUrl": "https://aih.example.net",
    "webSearch": "off",
    "traceHeaders": false,
    "includeModels": ["gpt-5.6-*", "claude-*"],
    "excludeModels": ["gpt-5.3-*"]
  }
}
```

### Gateway address

`baseUrl` points at your AIH gateway (any instance — the public one or a
self-hosted one). The `/v1` suffix is normalized away. If unset, a neutral
placeholder root is used that will not work.

### API key

The extension never reads credential files. Pi resolves the key itself:

1. **`/login`** — select the `tsgw` provider and enter the key; pi stores it
   in `~/.pi/agent/auth.json` (preferred)
2. **`TSGW_API_KEY`** environment variable — Pi's fallback when nothing is
   stored

### Options

| Setting (`settings.json` `tsgw.*`) | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | placeholder | Gateway root (the `/v1` suffix is normalized away) |
| `webSearch` | `off` | `off`, `cached`, or `live` — appends the built-in `web_search` tool for models with built-in search (GPT / Grok) |
| `traceHeaders` | `false` | Adds `AH-Thread-Id` / `AH-Trace-Id` headers for gateway-side tracing |
| `includeModels` | unset | Whitelist: only these model ids are registered (exact id or `prefix-*` glob) |
| `excludeModels` | unset | Blacklist: these model ids are dropped (exact id or `prefix-*` glob); blacklist wins over whitelist |

## Model catalog

The catalog is assembled from per-vendor slices (`extensions/models/vendors/`),
currently covering 10 vendor families: DeepSeek, GLM (Zhipu), MiMo (Xiaomi),
MiniMax, Kimi (Moonshot), Qwen (Alibaba), GPT (OpenAI), Gemini (Google),
Claude (Anthropic), and LongCat — 59 chat models in total. Each vendor file
carries the official documentation URL in its header comment. Pricing entries
mirror the vendors' public list prices; replace them with your gateway's
actual pricing if it differs.

Use `includeModels` / `excludeModels` to register only the models your
gateway plan actually supports.

## Development

```bash
npm install
npm test
```

Tests run against a fake pi host (`FakePi` + `FakeContext`) and isolate the
config directory through `PI_CODING_AGENT_DIR`, so no pi installation is
needed to run them.

## Technical details

Per-vendor thinking profiles (the request-body matrix), the built-in web
search injection semantics, and the pi lifecycle compatibility notes live in
[AGENTS.md](AGENTS.md).
