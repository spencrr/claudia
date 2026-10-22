# claudia

A small OpenAI-compatible HTTP proxy that routes model calls through your
GitHub Copilot subscription. Point any OpenAI SDK at `http://127.0.0.1:4242/v1`
and use Copilot's models (GPT, Claude, Gemini, …) with Copilot billing.

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
3. **Passthrough** — CAPI speaks the OpenAI wire format natively, so request and
   response bodies (including SSE streams) are forwarded byte-for-byte.

## Usage

Requires Node ≥ 22.18 (runs TypeScript directly, no build step) and either a
`GITHUB_TOKEN` or a signed-in [GitHub CLI](https://cli.github.com/).

```sh
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

`GET /v1/models` lists the chat models available to your account. Each entry
carries a non-standard `supported_endpoints` hint — newer OpenAI models answer
only on `/responses`, and CAPI returns a clear 400 if you pick the wrong one.

## Routes

| Route | Upstream |
|---|---|
| `GET /` , `GET /health` | — (unauthenticated) |
| `GET /v1/models` | `GET {api}/models`, translated to the OpenAI list shape |
| `POST /v1/chat/completions` | `POST {api}/chat/completions` |
| `POST /v1/responses` | `POST {api}/responses` |

The `/v1` prefix is optional. Add a route in [`src/routes.ts`](src/routes.ts).

## Configuration

All via environment variables.

| Variable | Default | Purpose |
|---|---|---|
| `CLAUDIA_PORT` | `4242` | Listen port |
| `CLAUDIA_HOST` | `127.0.0.1` | Bind address. Non-loopback **requires** `CLAUDIA_API_KEY`. |
| `CLAUDIA_API_KEY` | _(none)_ | If set, clients must send `Authorization: Bearer <key>` |
| `GITHUB_TOKEN` | _(from `gh`)_ | GitHub OAuth token with Copilot access |
| `CLAUDIA_GITHUB_API_URL` | `https://api.github.com` | GitHub REST base (GHE: `https://api.<host>`) |
| `CLAUDIA_INTEGRATION_ID` | _(none)_ | Sends `Copilot-Integration-Id`. `vscode-chat` exposes extra models on some SKUs. |
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
  seat may not be covered by your Copilot terms — check before sharing.
* Every request spends your Copilot quota (premium requests / credits). Keep
  the proxy on loopback or behind `CLAUDIA_API_KEY`.
* Not supported: embeddings, token counting, Anthropic Messages API input
  (CAPI's `/v1/messages` exists, but this proxy only speaks OpenAI shapes).
