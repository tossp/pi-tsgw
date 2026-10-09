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
    "tsSearch": "off",
    "traceHeaders": false,
    "excludeModels": ["gpt-*", "claude-*"],
    "includeModels": ["gpt-5.6-*"]
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
| `tsSearch` | `off` | `off`, `cached`, or `live` — appends the built-in `web_search` tool for models with built-in search (GPT / Grok) |
| `traceHeaders` | `false` | Adds `AH-Thread-Id` / `AH-Trace-Id` headers for gateway-side tracing |
| `includeModels` | unset | Re-include override: matching model ids are kept even when also matched by `excludeModels` (exact id or `prefix-*` glob) |
| `excludeModels` | unset | Blacklist: matching model ids are dropped unless pulled back by `includeModels` (exact id or `prefix-*` glob) |

## Model catalog

The catalog is assembled from per-vendor slices (`extensions/models/vendors/`),
currently covering 10 vendor families: DeepSeek, GLM (Zhipu), MiMo (Xiaomi),
MiniMax, Kimi (Moonshot), Qwen (Alibaba), GPT (OpenAI), Gemini (Google),
Claude (Anthropic), and LongCat — 59 chat models in total. Each vendor file
carries the official documentation URL in its header comment. Pricing entries
mirror the vendors' public list prices; replace them with your gateway's
actual pricing if it differs.

Use broad `excludeModels` rules to drop model families and precise
`includeModels` rules to pull selected models back. `includeModels` is not a
global whitelist: models matching neither list remain available. To register
only selected models, use `"excludeModels": ["*"]` and pull them back through
`includeModels`.

Opening `/model` refreshes the gateway catalog in the background, with a
five-minute cache to avoid repeated requests. Run `/tsgw-refresh` to bypass the
cache and force an immediate refresh without restarting or reloading Pi. If a
refresh fails, the last successful model list remains active.

## Status bar and session controls

Pi Web 0.11.0+ renders these extension statuses as clickable buttons:

- **`TSGW · N`** (`/tsgw`): one menu for **refreshing the model catalog** and
  **viewing diagnostics**. The count is the filtered registered catalog, not a
  count of healthy inference endpoints. 🟢 means a fresh directory result;
  🟡 means a static/expired directory or a failed refresh; ⚠️ means missing
  credentials or gateway configuration; ⏳ means a refresh is running.
- **Built-in search** (`/tsgw-search`): choose a mode for the current session.
  GPT offers `off / cached / live`; supported Grok models offer `off / live`
  because the existing Grok request policy does not distinguish cache-only
  search. Unsupported TSGW models are labeled accordingly; this button is
  hidden when another provider is selected.

You can also type `/tsgw-search off`, `/tsgw-search cached`, or
`/tsgw-search live`. These controls do not modify `settings.json` or persist
across a reload or a new session; `tsgw.tsSearch` remains the startup default.

The standalone `ts_search` tool is no longer bundled. Use a separately configured
search tool such as `ts_oht.search` instead. Built-in model search remains
available and does not control external search tools.

Diagnostics show directory source, original fetch time, cache freshness,
configuration presence, and safe refresh error summaries—never API keys or
URLs. They make no extra network requests. Statuses update on session/model
activity and directory refreshes; there is no background health polling.

Icons use Emoji/Unicode: Pi Web currently strips ANSI colors from command
buttons. Busy sessions disable the buttons. The terminal CLI shows the same
statuses as text; use the slash commands there. Pi Web may not show extension
statuses until the session runtime has started.

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
