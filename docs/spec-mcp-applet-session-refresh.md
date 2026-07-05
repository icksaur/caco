# spec-mcp-applet-session-refresh

Status: draft. Branch: `feature/tool-reveal-r0-r1`.

## Goals

The mcp-servers applet must show the tool state of the session the operator is
**currently viewing**, and refresh automatically when they switch sessions. Today
it (a) never re-fetches on a session switch — its subscription is missing — and (b)
its endpoint resolves the target from `mostRecentActiveSessionId()`, ignoring the
viewed session, so even a manual refresh can show a *different* session's
enabled/deferred state (the exact confusion the operator hit comparing two
sessions).

After this: switching sessions re-fetches the applet, and the payload reflects the
viewed session's live exclusion set (its per-session deferred/enabled tools).

## Design

**Endpoint honors the viewed session.** `GET /api/mcp/servers` reads an optional
`?sessionId=` query param. Target resolution: `sessionId` when it names an ACTIVE
session (`sessionManager.isActive`), else the existing
`mostRecentActiveSessionId()` fallback (unchanged behaviour when the param is
absent or names an inactive/unknown session — e.g. a cold session with no live SDK
connection, whose per-session exclusion set isn't in memory anyway). The resolved
`target` continues to thread through `listMcpServers` / `listMcpTools` /
`getCurrentToolMetadata` / `getExcludedToolKeys` exactly as today — only its
*source* changes. Telemetry (`ctx`, from `getContextInfo()`, which takes no target)
is unchanged: it stays first-active-scoped, out of scope here.

**Applet passes the viewed session + refreshes on switch.** `fetchMcpServers`
appends `?sessionId=` from `appletAPI.getSessionId()` (omitted when null — falls
back to server default). A new `appletAPI.onSessionChange(() => fetchMcpServers())`
subscription re-fetches on every switch, matching how git-status / files /
session-surface already refresh. The refresh reuses the existing `fetchMcpServers`
path (loading state → fetch → render), so no new render path.

## Invariants

- **The applet reflects the viewed session.** When a `sessionId` for an active
  session is supplied, the payload's per-tool `state` and per-server `deferred`
  flag are computed against THAT session's exclusion set, not the most-recent one.
- **Graceful fallback, unchanged default.** Absent/inactive/unknown `sessionId`
  resolves exactly as today (`mostRecentActiveSessionId()`); no behaviour change for
  callers that don't pass the param.
- **One fetch path.** Session-switch refresh calls the same `fetchMcpServers` as the
  manual refresh button and defer toggle; no parallel render path.

## Acceptance

- Observable (needs signoff): with two sessions in different tool states, switching
  the viewed session updates the mcp-servers applet automatically to the newly-viewed
  session's state (no manual refresh needed), and the shown enabled/deferred states
  match that session.
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `npm run check:specs` — all green.
- Oracles: endpoint unit — `?sessionId=<active>` targets that session's excluded
  keys; `?sessionId=<inactive>` and absent both fall back to
  `mostRecentActiveSessionId()`. (Applet wiring is visual signoff, matching the
  other applets' onSessionChange refresh, which has no unit harness.)

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| P1 | `GET /servers`: read `req.query.sessionId`; `target = isActive(q) ? q : mostRecentActiveSessionId()` | `src/routes/workspace-api.ts` | endpoint/unit: active id targets it; inactive/absent → fallback |
| P2 | Applet: `fetchMcpServers` appends `?sessionId=` from `appletAPI.getSessionId()`; add `onSessionChange` re-fetch | `applets/mcp-servers/script.js` | visual signoff (switch → auto-refresh) |
