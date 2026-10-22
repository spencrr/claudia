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
   byte-for-byte. Only `/v1/models` is translated.

## Usage

Requires Node ≥ 22.18 (runs TypeScript directly, no build step) and either a
`GITHUB_TOKEN` or a signed-in [GitHub CLI](https://cli.github.com/).

```powershell
npm install
npm start
# 2026-… info  Copilot session: login=you plan=enterprise api=https://api.enterprise.githubcopilot.com
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
Google and experimental vendors alike. Each entry carries a non-standard
`supported_endpoints` hint, because CAPI does **not** translate between vendor
wire formats:

| Model family | Works on |
|---|---|
| `claude-*` | `/v1/messages`, `/chat/completions` |
| `gpt-5*`, `o*` | `/responses` only |
| `gpt-4*`, `gemini-*`, `mai-*` | `/chat/completions` (empty hint = chat completions) |

Picking the wrong one returns a clear 400 from CAPI
(`unsupported_api_for_model`). Part of the catalog is only served when the
`Copilot-Integration-Id` header is present, so claudia sends `vscode-chat` by
default; set `CLAUDIA_INTEGRATION_ID=none` to omit it and lose those models.

### Claude Code

Claude Code talks to whatever `ANTHROPIC_BASE_URL` points at, so it only needs
env vars — no plugin. Two constraints:

* Its default model (`claude-fable-*`) is not in the Copilot catalog — pick one
  that is (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, …).
* It speaks the Anthropic format only, and CAPI serves only Claude models on
  that format — GPT/Gemini models are not reachable from Claude Code through
  this proxy. Put a format translator such as LiteLLM in front if you need that.

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
  },
  "permissions": { "deny": ["WebSearch"] }
}
```

`WebSearch` is denied because it is an Anthropic server-side tool that CAPI
does not run. `ANTHROPIC_DEFAULT_OPUS_MODEL` / `ANTHROPIC_DEFAULT_SONNET_MODEL`
remap the `opus` / `sonnet` aliases if you use those. The `total_cost_usd` Claude
Code prints is its Anthropic list-price estimate, not what Copilot bills.

## Routes

| Route | Upstream |
|---|---|
| `GET /` , `GET /health` | — (unauthenticated) |
| `GET /v1/models` | `GET {api}/models`, translated to the OpenAI list shape |
| `POST /v1/chat/completions` | `POST {api}/chat/completions` |
| `POST /v1/responses` | `POST {api}/responses` |
| `POST /v1/messages` | `POST {api}/v1/messages` (Anthropic Messages API) |
| `POST /v1/messages/count_tokens` | `POST {api}/v1/messages/count_tokens` |

The `/v1` prefix is optional. `anthropic-version` and `anthropic-beta` are the
only client headers relayed upstream. Add a route in [`src/routes.ts`](src/routes.ts).

## Configuration

All via environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDIA_PORT` | `4242` | Listen port |
| `CLAUDIA_HOST` | `127.0.0.1` | Bind address. Non-loopback **requires** `CLAUDIA_API_KEY`. |
| `CLAUDIA_API_KEY` | _(none)_ | If set, clients must send `Authorization: Bearer <key>` |
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
* Not supported: embeddings, Anthropic server-side tools (web search / fetch),
  models outside the Copilot catalog.
