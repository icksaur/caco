# Spec: same-origin request guard (all routes + ws)

## Goal

One uniform guard across **every** Caco endpoint (all HTTP routes + the `/ws` upgrade) that
blocks **foreign browser scripts** from driving the local server, while keeping all current
functionality. Caco acts as the user — every command is dangerous by design ("All caco
commands are dangerous", README). So the boundary to defend is not per-resource
authorization but *"only my own browser tab may talk to Caco."* Loopback binding already
excludes remote machines; local non-browser processes already run as the user. The one gap is
the browser-as-confused-deputy: a page at `evil.com` issuing `fetch` / form-post / `WebSocket`
to `localhost:53000`.

This **supersedes** the per-channel guard added on the terminal branch; that ws check folds
into this shared predicate and the `SERVER_URL`-derived host allowlist is removed.

## Threat model

- **In scope:** CSRF against state-changing HTTP routes (notably `POST /api/shell` →
  arbitrary exec, `POST /api/sessions/:id/messages` → drives the agent) and Cross-Site
  WebSocket Hijacking against `/ws` (now a live shell channel). Both are "a web page
  weaponizes the user's browser against loopback."
- **Out of scope (decided):** per-route command allowlists (every capability is dangerous by
  design — uniform gate, not per-resource); remote attackers (loopback bind); local
  non-browser processes (already the user); devtunnel auth (separate product — Caco only knows
  "localhost in general").
- **Why CORS is not the mechanism:** CORS is enforced on the *response* — it stops the foreign
  page from *reading* the reply, not the server from *executing* the request. A "simple"
  cross-origin POST still runs. The correct control is an explicit server-side **Origin
  check**, which this spec implements ("CORS's good idea, done right for CSRF").

## Design

**The rule (one predicate, applied to every request — HTTP and ws):**

> Allow ⇔ `Origin` is **absent**, OR (`new URL(origin).host === <request Host>` **AND** that
> host ∈ `trustedHosts`).

Reject = HTTP `403` (no handler runs) / ws upgrade refused. `trustedHosts` defaults to the
loopback set `{localhost, 127.0.0.1, [::1]}` and is extended **additively** by an opt-in
`CACO_TRUSTED_HOSTS` env (comma list) — **never** derived from `SERVER_URL` (that variable is
the server's self-call address and must stay loopback). The host-membership clause is the
DNS-rebinding guard; it is **default-on** (decision resolved in §"DNS-rebinding decision" —
verified zero-config over localhost, SSH `-L`, and default Dev Tunnel).

Why each clause:

- **`origin.host === host` (same-origin), zero config.** The browser stamps `Origin` on
  every cross-origin request (and on same-origin unsafe requests). The user's own tab always
  matches (same host:port). **Normalize for comparison:** `URL.host` lowercases and applies
  default-port rules; the raw `Host` header may not — compare normalized hosts (lowercase;
  fold default ports) so `http://h` vs `h:80` and case differences don't false-reject.
- **Absent `Origin` ⇒ allow.** Preserves (a) the server's internal self-calls
  `fetch(${SERVER_URL}/api/…)` in `agent-tools` / `schedule-manager` / `delegate-tool` /
  `swarm-tool` (Node/undici sends no `Origin` — **empirically confirmed on Node v26.2.0**);
  (b) top-level navigations and the OAuth redirect to `/` (GET, no Origin); (c) local CLI
  tools. A *cross-site* browser request can never have an absent Origin, so the clause is safe.
  **WS behaviour change:** today's `isSameOrigin` *rejects* absent-Origin; the new rule
  *allows* it. Browser WebSockets always send `Origin`, so this only admits non-browser local
  clients (not the threat) — the rewritten `terminal-origin.test.ts` must invert that case
  deliberately.
- **All methods, not just unsafe.** Maximally uniform ("equal for every request") and strictly
  safer. Same-origin GETs either omit `Origin` (allowed) or match (allowed); navigation/asset
  loads carry no `Origin` (allowed); only a *cross-origin request that carries an `Origin`* —
  exactly the threat — is rejected.

**Placement:**

- HTTP: a single **unscoped** `app.use(requireSameOrigin)` in `server.ts`, mounted **after**
  the portal `transferCors` mounts (~line 175) and **before** the `/api` route mounts
  (~line 178), so the intentional cross-origin transfer routes are reached first. Unscoped
  mount keeps `req.path` = full path for the carve-out match (a scoped `app.use('/api', …)`
  would strip the prefix and silently break the path equality — pin unscoped, or match on
  `req.originalUrl`). It reads headers only.
- WebSocket: `verifyClient` calls the same predicate.

**Carve-out (intentional cross-origin):** the portal/transfer routes — `POST
/api/sessions/import` and `GET /api/sessions/:id/export` (`docs/archive/remote-instances.md`, existing
`transferCors`) — are Caco-to-Caco cross-origin by design. The guard skips them by path:
`req.path === '/api/sessions/import' || /^\/api\/sessions\/[^/]+\/export$/.test(req.path)`.
Their own `transferCors` continues to govern them.

**Module:** `src/security/same-origin.ts` exporting the pure predicate
`isSameOriginRequest(origin: string | undefined, host: string | undefined): boolean`, the
`requireSameOrigin` Express middleware (carve-out aware), and a `verifyWsUpgrade` wrapper for
`verifyClient`. Pure core is unit-tested.

## Considerations / residual risks

- **DNS-rebinding decision — resolved: ship Y (loopback-default trusted set).** Pure
  `origin.host === host` passes a rebinding attack (after `evil.com → 127.0.0.1`, both Origin
  and Host are `evil.com`) — and `/ws` is a live shell channel, so this is RCE-grade. The
  `trustedHosts` membership clause closes it. **Research settled the only objection** (tunnel
  config cost — see `docs/devtunnel-host-findings.md`): Microsoft Dev Tunnels **rewrites both
  `Host` and `Origin` to `localhost` by default**, so the loopback-default trusted set works
  over the tunnel at **zero config**, exactly like direct-localhost and SSH `-L`. So Y is
  zero-config on every normal topology AND closes rebinding — strictly better than same-origin
  only. `trustedHosts` = `{localhost, 127.0.0.1, [::1]}` by default, extended additively by
  opt-in `CACO_TRUSTED_HOSTS` (comma list), **never** derived from `SERVER_URL`. The single
  config case: a user who runs `devtunnel … --host-header unchanged` (Host becomes the tunnel
  domain) adds that host to `CACO_TRUSTED_HOSTS`; `Origin===Host` still holds for them either
  way.
- **Portal carve-out residuals (pre-existing; the carve-out preserves, does not create).** The
  transfer routes' `transferCors`/`allowLocalhostCors` set only **response** headers — they do
  not block execution (`server.ts:167-173`, `sessions.ts:46-58`). So the exempted routes keep:
  - `POST /api/sessions/import` is **CSRF-writable by any origin** (`sessions.ts:866`,
    `?force=true` overwrites); evil.com can plant/overwrite a session later opened by the user
    (attacker-controlled content fed to the agent). The portal needs cross-origin import
    (`docs/archive/remote-instances.md:13`), so the carve-out is necessary — but the residual is noted.
  - `GET /api/sessions/:id/export?delete=true` **deletes the session** — a **state-changing
    GET**, contradicting this spec's own invariant (mutating routes must be non-GET). Carved
    out + GET ⇒ doubly unguarded (`<img src=".../export?delete=true">`; needs the v4 UUID, so
    practical risk is low). **Decision: accept + document, do not change.** It is the portal
    migration path (cross-origin drag-drop, `docs/archive/remote-instances.md`); converting it to POST
    would break the portal and only trades one carved-out shape for another. Recorded as a
    known residual; revisit if the portal is reworked.
  - `export` is cross-origin **readable** via `transferCors` `ACAO:*` → session exfil to any
    origin given a known UUID. Pre-existing; out of scope to change here, recorded as residual.
- **Forward-compat (remote delegation).** `docs/archive/remote-instances.md:14` plans cross-origin
  `POST /api/sessions/:id/messages` for remote delegation (local-only today). This guard will
  **403** those once cross-origin; that feature will need its own carve-out or a token. Noted
  so it doesn't silently break later.
- **Self-calls depend on "absent Origin."** Confirmed true on Node v26.2.0; pin with a test
  asserting absent-Origin is allowed, and keep internal `fetch` Origin-free.
- **`frame-ancestors *`** in the existing CSP (clickjacking) is unrelated and out of scope.
- **`allowLocalhostCorsSimple`** on `/api/info` and `/api/favicon` (GET) is harmless and stays.

## Acceptance (oracle-first)

- **Predicate oracle (unit, write FIRST).** A reference table over `(origin, host, trusted)` →
  allow/deny, independently reimplemented: same-origin+trusted → allow; cross-origin → deny;
  absent-origin → allow; `Origin` present + `Host` absent → deny; malformed origin → deny;
  host mismatch by port → deny; default-port equivalence (`http://h` vs `h:80`) → allow;
  case-insensitive host match → allow; same-origin host ∉ trusted (rebinding) → deny. Assert
  `isSameOriginRequest` equals the table byte-for-byte (independent reimplementation, not an
  invariant).
- **Middleware integration.** Cross-origin `POST /api/shell` → 403, command never executes;
  same-origin `POST` → passes; `GET /` + static assets → pass; an Origin-less `POST`
  (simulated self-call) → passes; a portal `POST /api/sessions/import` with a foreign Origin →
  passes (carve-out).
- **GET side-effect audit.** Enumerate mutating GETs; specifically resolve
  `GET /api/sessions/:id/export?delete=true` (require POST for delete, or accept + document).
- **WS.** Cross-origin upgrade refused; same-origin accepted; absent-Origin **allowed**
  (deliberate inversion of today's behaviour — non-browser local clients only). Existing
  `tests/unit/terminal-origin.test.ts` rewritten to the shared predicate (drop `isAllowedHost`
  / `isAllowedWsUpgrade`).
- **No-regression.** App loads, sends a message, switches sessions, runs an applet, terminal
  attaches, and the agent's internal session-message/self-calls succeed (existing suite +
  manual smoke).
- **Gates:** typecheck ×2, lint:strict, knip (no dead exports), full tests, build:client.

## Plan (ordered)

1. **`src/security/same-origin.ts`** — `isSameOriginRequest(origin, host, trustedHosts)` (pure,
   normalized host compare), `requireSameOrigin` middleware (carve-out aware, unscoped-mount
   assumptions), `verifyWsUpgrade`, and `trustedHosts` resolution (loopback default +
   additive `CACO_TRUSTED_HOSTS`, never `SERVER_URL`). **Write the predicate oracle test
   first**, then the impl. (Rebinding decision is resolved — Y, default-on loopback set.)
2. **server.ts** — mount `requireSameOrigin` as an **unscoped** `app.use` after `transferCors`
   (~175), before the `/api` mounts (~178). Confirm transfer routes still reached first and
   `req.path` is the full path for the carve-out.
3. **`src/routes/websocket.ts`** — `verifyClient` → `verifyWsUpgrade`; delete `isAllowedHost`,
   `isAllowedWsUpgrade`, `WS_ALLOWED_HOSTS`, and the `SERVER_URL` + `os` imports; move
   `isSameOrigin` logic into the shared module. Rewrite `terminal-origin.test.ts` (incl. the
   deliberate absent-Origin-allowed ws case).
4. **`/api/sessions/:id/export?delete=true`** — accepted as a known residual (portal migration
   path; carve-out already exempts it; v4-UUID-gated). No code change; documented in
   §Considerations.
5. **Integration tests** — middleware allow/deny + carve-out + Origin-less self-call; ws
   accept/reject. No-regression pass.
6. **Gates → background spec/code review → visual smoke** (app works, terminal still attaches).

This lands the terminal branch's ws guard as one app-wide control and removes the `SERVER_URL`
coupling footgun. The terminal feature rides on top of it.
