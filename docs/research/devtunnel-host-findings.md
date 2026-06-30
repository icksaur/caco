# Dev Tunnel `Host`/`Origin` header findings

Research basis for the same-origin guard spec (`docs/spec-same-origin-guard.md`). Settles
whether a loopback-default trusted-host guard works over a Microsoft Dev Tunnel.

## Headline

**Microsoft Dev Tunnels rewrites BOTH the inbound `Host` and `Origin` headers to `localhost`
(with the forwarded port) by default**, before forwarding to the local service. The original
public hostname is preserved in `X-Forwarded-Host`. So the local server sees
`Origin.host === Host === localhost:<port>` for a legitimate same-origin browser request
through the tunnel.

## Origin-vs-Host match verdict

**They MATCH** (both `localhost:<port>`). This is the *opposite* of the feared "Host rewritten
but Origin preserved → false-reject" mode. Consequences for the guard:

- Pure `Origin.host === Host` **passes** over the tunnel (no false-reject).
- A **loopback-only trusted set works over the tunnel with ZERO config** (Host is
  `localhost:<port>`), as long as the user keeps the default (no `--host-header unchanged`).
- A genuinely foreign `Origin` (a real attacker domain, not the tunnel host) is left
  **unchanged** by the edge, so the guard still sees the real cross-origin value. Near-ideal.

## Q&A

- **Q1 — Host seen locally:** rewritten to `localhost:<port>`, not the tunnel domain (default).
  Microsoft maintainer quoting CLI help, `microsoft/dev-tunnels#284`: *"--host-header … By
  default Host header is changed to 'localhost'."*
  (https://github.com/microsoft/dev-tunnels/issues/284#issuecomment-1701506761). Corroborated
  by the response-side `localhost`→tunnel `Location` rewrite (`#532`) and the Security doc's
  *"After TLS termination, header rewriting takes place."*
- **Q2 — X-Forwarded-*:** original public host preserved in `X-Forwarded-Host`; also
  `X-Forwarded-Proto: https`, `X-Forwarded-For: <client ip>`. Observed repro
  (`microsoft/dev-tunnels#507`).
- **Q3 — Configurable:** yes — `--host-header` / `--origin-header` (`unchanged` keeps the
  original); default rewrites to localhost. **Undocumented / preview** (not in the official CLI
  reference), stable since ≥2023 but could change.
- **Q4 — WebSocket:** WS upgrade is an HTTP GET through the same rewrite pipeline → local WS
  server sees `Host: localhost:<port>` and (page served from the tunnel) `Origin:
  http://localhost:<port>`. Rule the edge applies (curl repros in `#284`): *if Origin/Host
  matches the tunnel host, rewrite to `localhost:<local-port>`; otherwise leave unchanged.*
  Confidence HIGH for the rule; MEDIUM specifically for a real *browser* WS handshake (no
  browser-WS repro printing headers found — inferred from the shared pipeline + the #284 rule).

## Caveats

1. **`--host-header unchanged` opts out:** then Host = the tunnel domain and a loopback-only
   set rejects unless the user adds the tunnel host via `CACO_TRUSTED_HOSTS`. `Origin===Host`
   still holds (both the tunnel domain), so the *pure* same-origin path remains the robust
   cross-config check.
2. **Multi-port:** Origin is rewritten to the *backend's* local port; collapses cleanly for
   Caco's single-port (page+API+WS all on 53000).
3. Edge proxy is closed-source; the match algorithm is inferred from observed behavior, not
   read from code.

## Net for the spec

Option **Y** (same-origin **+** loopback-default trusted set) is **zero-config on direct
localhost, SSH `-L`, AND default Dev Tunnel** — and closes DNS rebinding. The only config case
is a user who explicitly runs `--host-header unchanged`, who then adds their tunnel host to
`CACO_TRUSTED_HOSTS`. The earlier "Y costs tunnel users an env var" assumption was wrong for
the default config.
