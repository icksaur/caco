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

*Server + tool discovery — available vs observed.* `GET /api/mcp/servers`
(`src/routes/workspace-api.ts`, mounted at `/api/mcp`) merges **two data sources
with different meanings**:
- **Available** — what a server *exposes*: `listMcpServers()` (`mcp.list`) +
  per-server `listMcpTools(name)` (`mcp.listTools` → `{name, description?}`). Present
  even for deferred/unused tools, but carries **no input schema**.
- **Observed** — what actually resolved into the current turn's tool set:
  `session.tools.getCurrentMetadata()` → `{name, namespacedName?, mcpServerName?,
  mcpToolName?, description, input_schema?, deferLoading?}`. Carries the **schema**
  (the bulk of a tool's per-turn token weight) but only for tools already loaded —
  a deferred or not-yet-used tool is **absent** here until a request loads it.

The handler joins them by name: each available tool is enriched with its observed
`input_schema` when a match exists (`observed:true`), else `observed:false`. The
built-in pseudo-server (`Built-in`, source `caco`) comes from `client.rpc.tools.list()`,
which returns full `{parameters, instructions}` — always observed-complete. Payload
per tool: `{name, description, namespacedName?, observed, parameters?, instructions?,
deferLoading?}`. **Honesty rule:** the UI must never synthesize a schema or token
cost for an unobserved tool — its schema is genuinely unknown until observed.

*Token cost (pure, server-computed, client-displayed).* Each tool's per-turn cost
is estimated by `estimateToolTokens`: sum the character count of **all values (not
keys)** in the tool's model-facing definition (name + description + `parameters`
schema + `instructions`), ÷ 4 — a **lower-bound** (schema keys are also billed but
not counted). Computed in the pure payload builder (real unit-test oracle) and
surfaced as `tokenCost` per tool; the applet renders it as `≈N tokens` in yellow,
tooltip labelling it a lower-bound. A tool is **observed** iff it appears in
`getCurrentMetadata()`; its `input_schema` is independently optional, so an observed
tool with no schema shows `tokenCost:null` (not fabricated) yet is not "unobserved".
An **unobserved** tool (absent from the resolved set — deferred/not-yet-loaded) shows
a grey `unobserved` label + info-icon tooltip instead of a number.

*Client-side cache (twist behavior).* The `/servers` payload carries everything, so
the applet **caches the last payload** and twists (server expand/collapse, tool
expand/collapse) only **re-render from cache** — never re-fetch. Fetching happens on
initial load and the refresh button only.

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
  discovery uses `session.rpc.mcp.listTools({serverName})` (available) and
  `session.tools.getCurrentMetadata()` (observed schema), never client-level
  `tools.list`. Client `tools.list` is used *only* for the built-in pseudo-server.
- **Never fabricate unobserved data** (invariant): a tool with no observed
  metadata shows its schema fields as grey `unobserved`, never a synthesized schema
  or token number. The whole feature's value is honest visibility of the real tax.
- **One tools list, one endpoint** (invariant): built-in tools are a synthetic
  entry in the same `/api/mcp/servers` payload, not a second endpoint or UI.
- **A twist never re-fetches** (invariant): server/tool expand/collapse re-renders
  from the cached payload; only initial load and refresh fetch.
- **No mid-session tool mutation** (fact): the resolved tool set is what it is at
  query time; the applet reflects it, cannot change it.
- **Same-origin guarded** (invariant): all `/api/mcp*` routes sit behind
  `requireSameOrigin`.

## Considerations

Status values rendered: `connected ✓`, `failed ✗`, `needs-auth 🔑`, `pending ⏳`,
`disabled/not_configured ○`. **Nested twisties** (model-info card/`dl` style):
server (expand → its tools) → tool (expand → property rows: description, parameters
schema pretty-printed, instructions). A twist re-renders from cache, never re-fetches.
Each tool name carries a yellow `≈N tokens` estimate when observed, or a grey
`unobserved` + info-icon tooltip when not. `configExists` gates an "edit
mcp-config.json" link. The built-in pseudo-server sorts first. The auth section is
driven by 401s surfaced from MCP calls, not discovery.

## Risks and Mitigations

- Discovery fails mid-session (RPC throws) → endpoint catches, returns `servers:[]` + an `error` field; applet shows a load-failed line, auth section still works.
- Applet render is untested JS → keep the endpoint's grouping pure/simple so a golden test can be added later; render is visual-signoff.

## Acceptance

- Observable: with a running session the applet lists `Built-in` + each MCP server (nested twisties); expanding a tool shows its description/parameters/instructions and a yellow `≈N tokens` estimate; a deferred/unloaded tool shows its fields as grey `unobserved` with an info tooltip; expand/collapse is instant (no network).
- Gates: typecheck ×2, lint:strict, full tests, build:client.
- Oracles: `buildMcpServerPayload` shape incl. built-in prepend + observed/unobserved merge — `tests/unit/mcp-server-payload.test.ts`; token-cost values-only sum — a pure `estimateToolTokens` unit test. OAuth PKCE/refresh + store — `tests/unit/mcp-auth-routes.test.ts` (duplicated route logic + real `refreshAccessToken`), `mcp-auth-store-atomic.test.ts`, `mcp-discovery.test.ts`; workspace path-security — `tests/unit/mcp-routes.test.ts` (duplicated `isPathAllowed`). NOT covered by tests: mounted `/api/mcp/servers` wiring, the RPC calls, applet render + twist/cost display (by-construction / visual). Same-origin — `same-origin-middleware.test.ts`.

## Plan

As-built (shipped `c6c487a`).

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | `listMcpServers()` + `listMcpTools(name)` (available) + `getCurrentToolMetadata()` (observed schema) + `listBuiltinTools()` via RPC | `src/session-manager.ts` | by-construction |
| 2 | `GET /api/mcp/servers`: merge available+observed, prepend built-in, per-tool `observed` flag | `src/routes/workspace-api.ts` | `mcp-server-payload.test.ts` |
| 3 | Applet: nested twisties (server→tool→props), model-info `dl` style, cached re-render | `applets/mcp-servers/{content.html,script.js,style.css}` | visual |
| 4 | `estimateToolTokens` (values-only ÷4) → per-tool `tokenCost`; applet shows yellow `≈N` or grey `unobserved`+tooltip | `src/routes/workspace-api.ts`, `applets/mcp-servers/script.js` | `estimateToolTokens` unit test + visual |
| 4 | OAuth auth section + flow | `src/routes/mcp-auth.ts`, `src/mcp-auth-store.ts` | mcp-auth-routes/store tests |

## Rationale

Supersedes `docs/research/mcp-servers-applet.md` (the pre-build research note whose
"Phase 2 tool list" is now shipped). The applet was rebranded from `mcp-auth` to
`mcp-servers` in `c6c487a`, which also added the live discovery section.
