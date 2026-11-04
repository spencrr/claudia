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
  token` and kept in memory. It is sent to the Copilot API base discovered via
  `api.github.com/copilot_internal/user` (and `{api}/mcp` for web search), or
  to the `CLAUDIA_CAPI_URL` / `CLAUDIA_GITHUB_API_URL` overrides if you set
  them. Every such destination must be `https:` (plain `http:` only on
  loopback). Tokens that are not valid header values are refused before any
  request is built, and log lines are sanitized, so the token does not appear
  in logs or error responses.
* **An inbound HTTP surface** on `127.0.0.1` by default. Without
  `CLAUDIA_API_KEY`, requests that look browser-originated (an `Origin`
  header, or a non-loopback `Host`) are refused, because a web page you have
  open can reach loopback too. Binding to a non-loopback address requires a
  key; with a key configured, the key is the boundary and anyone holding it
  can spend your Copilot quota. Malformed requests are answered, not crashed
  on, and bodies are capped at 64 MiB.
* **Outbound fetches on the model's behalf** (`web_fetch`), restricted to
  public addresses: the hostname is resolved once, every resolved address is
  checked against loopback, private, link-local, CGNAT, ULA, NAT64/6to4 and
  multicast ranges (IPv4-mapped IPv6 included), the connection is pinned to
  the checked address, and every redirect hop is re-checked. Bodies are capped
  at 1 MB, requests at 30 s, and fetched text is stripped of control
  characters. The tool definition's `allowed_domains` / `blocked_domains` are
  enforced; the model can narrow them but not widen them.

## Supported versions

Only the latest commit on `main`. There are no releases yet.
