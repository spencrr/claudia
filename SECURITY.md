# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/spencrr/claudia/security/advisories/new)**.
Please don't open a public issue for anything that could expose a user's
Copilot token or let a third party spend their quota.

This is a single-maintainer side project; expect an acknowledgement within a
week and a fix on a best-effort basis.

## What claudia handles

* **Your GitHub/Copilot OAuth token**, read from `GITHUB_TOKEN` or `gh auth
  token`, kept in memory and sent only to the GitHub endpoints discovered via
  `api.github.com/copilot_internal/user` (and `{api}/mcp` for web search).
  It is never logged.
* **An inbound HTTP surface** on `127.0.0.1` by default. Binding elsewhere
  requires `CLAUDIA_API_KEY`; anyone who can reach the port can spend your
  Copilot quota.
* **Outbound fetches on the model's behalf** (`web_fetch`), restricted to
  public addresses with redirect re-checking and size/time limits.

## Supported versions

Only the latest commit on `main`. There are no releases yet.
