# claudia

A small local HTTP proxy that routes model calls through your GitHub Copilot
subscription. It speaks both the OpenAI and Anthropic wire formats, so OpenAI
SDKs, Anthropic SDKs and Claude Code can all use Copilot's models (GPT, Claude,
Gemini, …) with Copilot billing.

It mirrors how VS Code's agent host bridges third-party harnesses (Claude
Agent SDK, Codex) to the Copilot API: a loopback server that re-issues each
request to CAPI with your GitHub token. Zero runtime dependencies.

## How it works

```
OpenAI client ──▶ 127.0.0.1:4242/v1/chat/completions ──▶ https://api.<…>.githubcopilot.com/chat/completions
                  (claudia)                                Authorization: Bearer <GitHub OAuth token>
```

1. **Token** — `GITHUB_TOKEN`, else `gh auth token` (the GitHub CLI's login).
2. **Discovery** — `GET api.github.com/copilot_internal/user` returns your
   CAPI base URL (`endpoints.api`); cached for 30 min, re-resolved on 401/403.
3. **Passthrough** — CAPI speaks the OpenAI and Anthropic wire formats natively,
   so request and response bodies (including SSE streams) are forwarded
   byte-for-byte whenever the model supports the format you spoke.
4. **Translation** — CAPI serves each vendor on one format only, so
   `/v1/messages` (Anthropic format) additionally translates to Chat
   Completions or Responses for non-Claude models. This is what lets Claude
   Code run GPT, Gemini and Grok. See [How requests are routed](#how-requests-are-routed).
5. **Web tools** — Anthropic's hosted `web_search` / `web_fetch` tools are
   rejected by CAPI; claudia runs them itself, using GitHub's own web search
   service for search. See [Web tools](#web-tools).

## Usage

Requires Node ≥ 22.18 (runs TypeScript directly, no build step) and either a
`GITHUB_TOKEN` or a signed-in [GitHub CLI](https://cli.github.com/).

```powershell
npm install
npm start
# 2026-… info  Copilot session: login=you plan=individual api=https://api.githubcopilot.com
# 2026-… info  claudia listening on http://127.0.0.1:4242/v1 (auth: none, loopback only)
```

```ts
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://127.0.0.1:4242/v1', apiKey: 'unused' });

await client.chat.completions.create({ model: 'claude-sonnet-5.5', messages: [{ role: 'user', content: 'hi' }] });
await client.responses.create({ model: 'gpt-5.6-sol', input: 'hi' });
```

### Models

`GET /v1/models` lists every chat model your account can use — OpenAI, Anthropic,
Google, xAI and experimental vendors alike. Each entry carries non-standard
hints from CAPI's catalog — `supported_endpoints`, `context_window`,
`max_output_tokens`, `tool_calls`, `vision` — which clients such as Lestat (the
companion VS Code extension in `../lestat`) use to size requests. Part of the
catalog is only served when the `Copilot-Integration-Id` header is present, so
claudia sends `vscode-chat` by default; set `CLAUDIA_INTEGRATION_ID=none` to
omit it and lose those models.

### How requests are routed

CAPI is **not** a format-translating gateway: each model answers only on the
wire format(s) its vendor backend speaks, advertised per model as
`supported_endpoints`. Claudia treats that list as authoritative. The format a
client speaks to claudia and the format claudia speaks to CAPI are therefore
independent — `/v1/messages` in does not mean `/v1/messages` out.

| Model family | CAPI accepts | `/v1/messages` (Anthropic clients) goes to | OpenAI routes |
|---|---|---|---|
| `claude-*` | `/v1/messages`, `/chat/completions` | `/v1/messages`, verbatim | `/v1/chat/completions` passes through |
| `gpt-5*`, `gpt-6*`, `grok-*` | `/responses` only | `/responses`, translated | `/v1/responses` passes through |
| `gemini-*`, `gpt-4*`, `mai-code-1.1` | `/chat/completions` only | `/chat/completions`, translated | `/v1/chat/completions` passes through |
| `mai-code-2-flash` | both OpenAI formats | `/responses`, translated | either |

Consequences worth knowing:

* Using an OpenAI route a model doesn't support returns CAPI's own 400
  (`unsupported_api_for_model`). `/v1/messages` works for every model because
  claudia picks the backend.
* Claude models cannot be reached through `/responses` or any OpenAI-format
  path other than `/chat/completions` — CAPI returns 400 (verified 2026-11-03).
  A Messages→Responses wrapper for Claude has nothing to talk to upstream.
* Translation drops what the target format can't carry: Anthropic `thinking`
  blocks in history, and vendor reasoning state across turns. Tool loops still
  work; the model re-derives context.

### Web tools

Claude Code's `WebSearch` is Anthropic's hosted `web_search` tool, and CAPI
rejects every hosted search tool for Claude models — Anthropic's
`web_search_20250305` on `/v1/messages` and OpenAI-style `web_search` on
`/chat/completions` both return 400 (verified 2026-11-03). So claudia
intercepts the hosted `web_search` / `web_fetch` tool definitions, swaps in
ordinary JSON-schema tools, runs them, and renders the results back as
Anthropic `server_tool_use` / `web_search_tool_result` blocks so clients show
sources natively.

| Tool | Backend | Notes |
|---|---|---|
| `web_search` | **GitHub's web search service** — the `web_search` tool of the GitHub MCP server at `{capi}/mcp`, called with the same Copilot token | The backend Copilot CLI uses. One stateless JSON-RPC call per search, ~0.5 s, two ranked results with long snippets and recency. `allowed_domains` / `blocked_domains` become `site:` / `-site:` operators plus a post-filter. Queries stay inside GitHub. |
| `web_fetch` | Local HTTP GET, HTML → text | The same model Copilot CLI and Claude Code use (both fetch client-side). Refuses loopback, private, link-local/metadata, CGNAT and ULA addresses, re-checks every redirect hop, caps bodies at 1 MB / 100K chars and requests at 30 s. |

Two things deliberately **not** done:

* OpenAI's native `web_search` on `/responses` does work through CAPI for
  `gpt-5*`/`gpt-6*`/`grok-*` (output contains `web_search_call` items), but it
  would be a second search path serving only those models, with weaker source
  metadata (citations arrived as empty `annotations` in testing). GitHub's
  search covers every model uniformly.
* Declaring `web_search` on `/chat/completions` is tolerated for Gemini/GPT-4
  but not executed — the model answers that it has no internet access.

Costs: each search round is one extra model call plus the search; Claude Code's
`max_uses` (default 5) bounds the loop, capped at 10 rounds.

### Claude Code

Claude Code talks to whatever `ANTHROPIC_BASE_URL` points at, so it only needs
env vars — no plugin. Any catalog model works, Claude or not. Its default model
(`claude-fable-*`) is not in the Copilot catalog, so set one explicitly:
`claude-sonnet-5-5`, `claude-opus-5-5`, `gpt-6-astra`, `gemini-4-argon`,
`grok-4.7`, … You can also switch mid-session with `/model <id>`; Claude Code
verifies the id with a one-token probe through the proxy before accepting it.

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:4242'
$env:ANTHROPIC_AUTH_TOKEN = 'unused'                    # or your CLAUDIA_API_KEY
$env:ANTHROPIC_MODEL = 'claude-sonnet-5-5'              # main model
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5' # background tasks
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'     # no updater/telemetry calls to the proxy
Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue
claude
```

#### Non-Claude models

Claude Code only has built-in knowledge of Claude ids, so with `gpt-6-astra`
and friends it says so in two harmless ways:

* `[claude-code:unrecognized_model] {"model":"gpt-6-astra",…}` on stderr — a
  notice only; the request is still sent as configured.
* A startup banner `Model "gpt-6-astra" isn't recognized · context assumed to be
  200k tokens`. It can't look up the window, so it defaults to 200K and compacts
  early. Tell it the real window (`context_window` on `GET /v1/models`):

  ```powershell
  $env:ANTHROPIC_MODEL = 'gpt-6-astra'
  $env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1050000'   # gpt-6-astra, gpt-5.6-*, gpt-6.1-sol
  # 1000000 gpt-6-sol/luna, claude-*-5*;  1048576 gemini-*;  500000 grok-*;  400000 gpt-5.3-codex
  ```

  For ids that don't start with `claude-` the variable applies on its own and
  the banner disappears.

Claude-specific features (adaptive thinking, prompt caching hints, 1M-context
betas) are simply skipped for other vendors; tools, images and streaming work.

bash/zsh:

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:4242
export ANTHROPIC_AUTH_TOKEN=unused
export ANTHROPIC_MODEL=claude-sonnet-5-5
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-5-5
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
unset ANTHROPIC_API_KEY
claude
```

Or make it permanent for every shell in `~/.claude/settings.json`
(`%USERPROFILE%\.claude\settings.json` on Windows):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4242",
    "ANTHROPIC_AUTH_TOKEN": "unused",
    "ANTHROPIC_MODEL": "claude-sonnet-5-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-5-5",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  }
}
```

`ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL` remap the
`opus` / `sonnet` aliases if you use those. The `total_cost_usd` Claude Code
prints is its Anthropic list-price estimate, not what Copilot bills.

All built-in tools work, including `WebSearch` and `WebFetch` — see
[Web tools](#web-tools) for how they are served without Anthropic's hosted
backend.

## Routes

| Route | Upstream |
|---|---|
| `GET /` , `GET /health` | — (unauthenticated) |
| `GET /v1/models` | `GET {api}/models`, translated to the OpenAI list shape |
| `POST /v1/chat/completions` | `POST {api}/chat/completions` |
| `POST /v1/responses` | `POST {api}/responses` |
| `POST /v1/messages` | Claude: `POST {api}/v1/messages` verbatim. Others: translated to `/chat/completions` or `/responses` per the catalog. Hosted `web_search`/`web_fetch` tools run locally. |
| `POST /v1/messages/count_tokens` | Claude: `POST {api}/v1/messages/count_tokens`. Others: a size-based estimate. |

The `/v1` prefix is optional. `anthropic-version` and `anthropic-beta` are the
only client headers relayed upstream. Add a route in [`src/routes.ts`](src/routes.ts).

Translation details worth knowing (`src/openai.ts`): `system` becomes a system
message / `instructions`; `tool_use` ⇄ function calls; `tool_result` ⇄ tool
messages / `function_call_output`; `thinking` blocks in history are dropped
(other vendors can't consume them); `output_config.effort` or a `thinking`
budget becomes `reasoning.effort` on Responses; hosted-tool blocks in history
are flattened to text. Streams are re-emitted as Anthropic events
(`message_start` → `content_block_*` → `message_delta` → `message_stop`).

## Configuration

All via environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDIA_PORT` | `4242` | Listen port |
| `CLAUDIA_HOST` | `127.0.0.1` | Bind address. Non-loopback **requires** `CLAUDIA_API_KEY`. |
| `CLAUDIA_API_KEY` | _(none)_ | If set, clients must send `Authorization: Bearer <key>` or `x-api-key: <key>` |
| `GITHUB_TOKEN` | _(from `gh`)_ | GitHub OAuth token with Copilot access |
| `CLAUDIA_GITHUB_USER` | _(active `gh` account)_ | Borrow the token of a specific `gh` login (`gh auth token --user …`) when several are signed in |
| `CLAUDIA_GITHUB_API_URL` | `https://api.github.com` | GitHub REST base (GHE: `https://api.<host>`) |
| `CLAUDIA_INTEGRATION_ID` | `vscode-chat` | `Copilot-Integration-Id` header; CAPI gates part of the catalog on it. `none` omits it. |
| `CLAUDIA_CAPI_URL` | _(discovered)_ | Skip discovery; send everything here (debugging/tests) |
| `CLAUDIA_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # node --test (unit + end-to-end against a fake CAPI)
```

## Caveats

* `copilot_internal/*` and CAPI are undocumented GitHub endpoints; behaviour
  can change without notice. Routing non-GitHub tooling through your Copilot
  seat may not be covered by your Copilot terms — check before sharing. The
  default `Copilot-Integration-Id: vscode-chat` is what Copilot Chat sends;
  claudia still identifies itself honestly via `User-Agent`.
* Every request spends your Copilot quota (premium requests / credits). Keep
  the proxy on loopback or behind `CLAUDIA_API_KEY`.
* Not supported: embeddings, Anthropic hosted tools other than web search /
  fetch (code execution, computer use, memory), models outside the Copilot
  catalog. See [How requests are routed](#how-requests-are-routed) for what
  translation drops.
* Web search returns GitHub's two top results per query (no paging). The
  `WebTools` interface in [`src/webtools.ts`](src/webtools.ts) is the seam if
  you need a different backend.
* The routing and web-tool facts above are empirical (probed 2026-11-03); CAPI
  may change them without notice.
