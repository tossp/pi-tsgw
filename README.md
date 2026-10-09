# pi-tsgw

Pi extension for the TOSSP AIH gateway. Registers the `tsgw` provider with a
model catalog spanning four wire protocols (openai-completions,
openai-responses, anthropic-messages, google-generative-ai) and applies
per-vendor request-body operations so thinking levels, reasoning formats, and
optional built-in web search behave correctly on the gateway.

No private API keys or gateway endpoints are included. The static catalog
contains model metadata and public-price estimates; these are not your gateway's
billing rates.

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
    "tsSearch": "live",
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

The extension delegates credential reading and resolution to Pi:

1. **`/login`** — select the `tsgw` provider and enter the key; pi stores it
   in `~/.pi/agent/auth.json` (preferred)
2. **`TSGW_API_KEY`** environment variable — Pi's fallback when nothing is
   stored

Startup discovery uses Pi's stored-credential API; later catalog refreshes use
the credential supplied by Pi. With environment-only authentication, the initial
catalog may fall back to static models until Pi refreshes it.

### Options

| Setting (`settings.json` `tsgw.*`) | Default | Meaning |
| --- | --- | --- |
| `baseUrl` | placeholder | Gateway root (the `/v1` suffix is normalized away) |
| `tsSearch` | `live` | GPT: `cached` or `live`; unset, legacy `off`, and invalid values fall back to `live`. Supported Grok models always use live search. |
| `traceHeaders` | `false` | Adds `AH-Thread-Id` / `AH-Trace-Id` headers for gateway-side tracing |
| `includeModels` | unset | Re-include override: matching model ids are kept even when also matched by `excludeModels` (exact id or `prefix-*` glob) |
| `excludeModels` | unset | Blacklist: matching model ids are dropped unless pulled back by `includeModels` (exact id or `prefix-*` glob) |

## Model catalog

The catalog is assembled from per-vendor slices (`extensions/models/vendors/`),
covering 11 vendor families: DeepSeek, GLM (Zhipu), MiMo (Xiaomi), MiniMax,
Kimi (Moonshot), Qwen (Alibaba), GPT (OpenAI), Gemini (Google), Claude
(Anthropic), LongCat, and Grok (xAI). The current static catalog contains 54 chat
model IDs, including retained aliases; this is not a live availability count.
Vendor files carry documentation links and metadata caveats. Alias mappings,
output limits, and shared thinking policies are not all individually verified
against gateway endpoints; public-price estimates do not guarantee billing.

Use broad `excludeModels` rules to drop model families and precise
`includeModels` rules to pull selected models back. `includeModels` is not a
global whitelist: models matching neither list remain available. To register
only selected models, use `"excludeModels": ["*"]` and pull them back through
`includeModels`. Both lists are case-sensitive and support only exact IDs or
trailing `*` prefix matching (not general globs); preserve `MiniMax-*` casing.
When a gateway catalog is available, filtering applies after intersecting it
with the static catalog. Include rules cannot add unknown or unavailable IDs.

Opening `/model` refreshes the gateway catalog in the background, with a
five-minute cache to avoid repeated requests. Run `/tsgw-refresh` to bypass the
cache and force an immediate refresh without restarting or reloading Pi. If a
refresh fails, the last successful model list remains active.

Memory and disk caches are scoped to the gateway root and credential using a
SHA-256 digest; plaintext credentials are not stored. The disk cache is a single
slot at `<agent-dir>/tsgw/models-cache.json`: changing scope may require a fresh
fetch. Legacy unscoped cache files are ignored and replaced after a successful
fetch. In-process request ordering prevents late results from replacing newer
cache writes; this is not a cross-process locking mechanism.

## Status bar and session controls

Pi Web clients supporting `command:/…` statuses render these as clickable
buttons; the terminal CLI displays status text and accepts the same commands:

- **`TSGW · N`** (`/tsgw`): one menu for **refreshing the model catalog** and
  **viewing diagnostics**. The count is the filtered registered catalog, not a
  count of healthy inference endpoints. 🟢 means a fresh directory result;
  🟡 means a static/expired directory or a failed refresh; ⚠️ means missing
  credentials or gateway configuration; ⏳ means a refresh is running.
- **Built-in search** (`/tsgw-search`): GPT offers only `cached / live`
  for the current session, defaulting to `live`. Supported Grok models use
  fixed live search: the command only shows a notice, without a picker or
  changing the GPT session mode. Unsupported TSGW models are labeled
  accordingly; this button is hidden when another provider is selected.

For GPT, you can also type `/tsgw-search cached` or `/tsgw-search live`;
`off` is no longer accepted. These controls do not modify `settings.json` or
persist across a reload or a new session; `tsgw.tsSearch` remains the startup
default. Existing `cached` configuration is preserved; unset, legacy `off`,
and invalid configuration now default to `live`.

Injection remains limited to the existing model/protocol support list. GPT
Responses appends a `web_search` tool (`external_web_access` is false for
`cached`, true for `live`); Grok Completions appends
`search_parameters: { mode: "on" }`. Existing search tools/fields are never
overwritten. This setting does not control Qwen's vendor policy, external
tools, or thinking mode and is not a global network-access switch.

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
npm ci
npm test
npm exec -- tsc -p tsconfig.json
npm pack --dry-run --json
```

Pi is installed as a development dependency; the lockfile defines the test
baseline. Tests isolate configuration and credentials using temporary agent
directories. Unit tests use a fake host; host integration tests load the extension
through the real Pi SDK with simulated HTTP responses, without production
requests. They do not verify upstream inference, native search results, or Pi
Web rendering. Run the full suite after upgrading Pi.

## Technical details

- [Vendor profiles](https://github.com/tossp/pi-tsgw/tree/main/extensions/models/vendors): model metadata, compatibility flags, and thinking mappings.
- [Request operations](https://github.com/tossp/pi-tsgw/blob/main/extensions/models/operations.ts): copy-on-write dispatch; DeepSeek/Claude response handling stays with Pi's adapters.
- [Built-in search](https://github.com/tossp/pi-tsgw/blob/main/extensions/models/web-search.ts): exact model/protocol support and append-only injection.
- [Host integration](https://github.com/tossp/pi-tsgw/blob/main/extensions/index.ts): configuration, refreshes, commands, and lifecycle snapshots. Late request callbacks must not access stale session contexts.

These source links describe the repository's current main branch; an installed
release may differ. Development rules in `AGENTS.md` are repository-only and
are not part of the npm package.
