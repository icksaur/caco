# spec-mcp-servers

The **MCP Servers applet** and its backend: live server status + per-server tool
discovery, plus OAuth authentication for servers that need it. As-built (shipped
in `c6c487a`); this replaces the stale research note `docs/research/mcp-servers-applet.md`.

## Goals

A user with many MCP servers can open one applet and see, per server: its
connection status, the tools it exposes (name + description, collapsible), and —
for OAuth servers — an authenticate action. Tool/server data is discovered live
from the running SDK client; auth state is Caco-owned and persists.

## Design

**Two independent sections, two data sources.**

*Server + tool discovery* (top section). `GET /api/mcp/servers`
(`src/routes/workspace-api.ts`, mounted at `/api/mcp`) returns
`{ configPath, configExists, clientRunning, servers[] }`. When a client is
running it calls `sessionManager.listMcpServers()` (`session.rpc.mcp.list()` →
`{name, status, source?, error?}`) and, **per server**, `listMcpTools(name)`
(`session.rpc.mcp.listTools({ serverName })` → `{name, description?}[]`), then
assembles the payload via the pure `buildMcpServerPayload`. No client running →
`{clientRunning:false, servers:[]}`. **Critical mechanism:** MCP tools come from the
**session-scoped** `mcp.listTools` RPC, one call per server — NOT from
client-level `tools.list` (which returns *built-in model tools*, not MCP tools,
and was the original bug: it left every server showing "no tools").

*Built-in pseudo-server.* Caco's own built-in tools (`client.rpc.tools.list()` —
the built-in model tools) are surfaced as **one synthetic server entry** named
`Built-in` (source `caco`, status `connected`) **in the same `servers[]` array**,
so there is a single tools list and a single HTTP endpoint — no second UI or route.
It is prepended by `buildMcpServerPayload`; the applet renders it identically to a
real server. This is the sanctioned use of client `tools.list` (built-ins are
exactly what it returns); MCP tools still never come from it.

*Client-side tool cache (twist behavior).* The `/servers` payload carries every
server's tools eagerly, so the applet **caches the last payload** and a twist
(expand/collapse) only **re-renders from that cache** — it never re-fetches.
Fetching happens on initial load and the explicit refresh button only. So:
twist-open shows the cached tool list (no HTTP), twist-close hides it (no HTTP).

*Authentication* (bottom section). `GET /api/mcp/auth/servers` returns the
Caco-owned OAuth store (`~/.caco/mcp-auth.json`) merged with CLI OAuth configs;
`/api/mcp/auth/{start,callback,config}` drive the PKCE popup flow. This is the
pre-existing mcp-auth surface, unchanged by the discovery feature.

The applet (`applets/mcp-servers/`) renders both: `fetchMcpServers()` paints the
discovery section (status icon per `status`, tool count, click-to-toggle tool
list via event delegation); `fetchServers()` paints the auth section. Mechanism:
tool grouping lives server-side (one response the applet renders verbatim) rather
than the applet making N calls — keeps the applet a thin renderer.

## Invariants

- **Two endpoints, two concerns** (invariant): discovery (`/api/mcp/servers`,
  runtime, read-only) and auth (`/api/mcp/auth/*`, Caco store) stay separate;
  merging them would couple runtime state to persisted credentials.
- **Discovery needs a running client** (fact): `rpc.tools.list`/`rpc.mcp.list`
  require an active SDK session; absent one the endpoint returns `clientRunning:false`,
  never an error.
- **MCP tools come from the session-scoped RPC** (invariant): MCP-server tool
  discovery must use `session.rpc.mcp.listTools({serverName})`, never client-level
  `tools.list`. Client `tools.list` is used *only* to populate the built-in
  pseudo-server. Regressing MCP tools to the client RPC silently returns "no tools".
- **One tools list, one endpoint** (invariant): built-in tools are a synthetic
  entry in the same `/api/mcp/servers` payload, not a second endpoint or UI.
- **A twist never re-fetches** (invariant): expand/collapse re-renders from the
  cached payload; only initial load and the refresh button fetch. Re-fetching on
  twist regresses this (the prior behavior).
- **No mid-session tool mutation** (fact): the tool set is fixed at create/resume;
  the applet reflects it, cannot change it.
- **Same-origin guarded** (invariant): all `/api/mcp*` routes sit behind
  `requireSameOrigin`.

## Considerations

Status values rendered: `connected ✓`, `failed ✗`, `needs-auth 🔑`, `pending ⏳`,
`disabled/not_configured ○`. Tool lists default collapsed; **a twist re-renders
from the cached payload, never re-fetches** (only initial load + the refresh button
hit the network). `configExists` gates an "edit mcp-config.json" link into the text
editor. The built-in pseudo-server sorts first so Caco's own tools are always visible.
The auth section is driven by 401s surfaced from MCP calls, not discovery.

## Risks and Mitigations

- Discovery fails mid-session (RPC throws) → endpoint catches, returns `servers:[]` + an `error` field; applet shows a load-failed line, auth section still works.
- Applet render is untested JS → keep the endpoint's grouping pure/simple so a golden test can be added later; render is visual-signoff.

## Acceptance

- Observable: with a running session, the applet lists a `Built-in` server (Caco's tools) plus each MCP server with a status icon and an expandable tool list; expanding/collapsing is instant with no network request (only refresh re-fetches); no session → "Start a session to discover servers and tools".
- Gates: typecheck ×2, lint:strict, full tests, build:client.
- Oracles: `buildMcpServerPayload` shape incl. the prepended built-in entry (per-server tools, null-normalized fields, empty-tools default) — `tests/unit/mcp-server-payload.test.ts`. OAuth PKCE/refresh + store logic — `tests/unit/mcp-auth-routes.test.ts` (duplicated route logic + real `refreshAccessToken`), `mcp-auth-store-atomic.test.ts`, `mcp-discovery.test.ts`; workspace path-security — `tests/unit/mcp-routes.test.ts` (duplicated `isPathAllowed`, not mounted routes). NOT covered by tests: the mounted `/api/mcp/servers` route wiring, the `mcp.listTools`/`tools.list` RPC calls, and the applet render + twist-cache behavior (by-construction / visual). Same-origin is covered separately by `same-origin-middleware.test.ts`.

## Plan

As-built (shipped `c6c487a`).

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | `listMcpServers()` (status) + `listMcpTools(serverName)` (per-server) + `listBuiltinTools()` (client `tools.list`) | `src/session-manager.ts` | by-construction |
| 2 | `GET /api/mcp/servers`: per-server tool fetch + prepend built-in via `buildMcpServerPayload` | `src/routes/workspace-api.ts` | `mcp-server-payload.test.ts` |
| 3 | Applet: cache payload; twist re-renders from cache (no re-fetch) | `applets/mcp-servers/script.js` | visual |
| 4 | OAuth auth section + flow | `src/routes/mcp-auth.ts`, `src/mcp-auth-store.ts` | mcp-auth-routes/store tests |

## Rationale

Supersedes `docs/research/mcp-servers-applet.md` (the pre-build research note whose
"Phase 2 tool list" is now shipped). The applet was rebranded from `mcp-auth` to
`mcp-servers` in `c6c487a`, which also added the live discovery section.
