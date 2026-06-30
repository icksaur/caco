# MCP Servers Applet

## Goal

Rebrand the `mcp-auth` applet to `mcp-servers`. Add a server + tool list section above the existing authentication UI. Provide visibility into which MCP servers are configured, their connection status, and what tools each exposes — enabling users to configure tool filters in `mcp-config.json`.

## Problem

Users with many MCP servers (a dozen at work) have no visibility into which tools each server provides. Some servers expose dozens of tools that consume context, when only a few are useful. The only way to filter is hand-editing `mcp-config.json`, but users can't discover tool names without asking the agent (a round-trip). VS Code shows tool lists in its UI; Caco has no equivalent.

## Requirements

1. Rename applet from `mcp-auth` to `mcp-servers` (slug, meta.json, all references)
2. Top section: **MCP Servers & Tools** — live server status + tool discovery
   - Each configured MCP server shown with name, status (connected/failed/needs-auth/disabled), and source
   - Tool list per server, discovered at runtime via `client.rpc.tools.list()` — MCP tools have `namespacedName` like `"servername/toolname"`
   - Tools grouped under their server by parsing the namespace prefix
   - When SDK client is not running: show "Start a session to discover tools" message
   - Built-in (non-MCP) tools excluded from display
3. Link to edit `mcp-config.json` via text-editor applet (if file exists)
4. Bottom section: **Authentication** — existing OAuth auth UI (unchanged)

## Non-goals

- No tool toggle UI (would require writing to mcp-config.json + session reload — too risky for v1)
- No changes to auth API routes or backend auth logic

## Phases

**Phase 1: Rename** — `mcp-auth` → `mcp-servers`. Zero new functionality. Mechanically verifiable.

**Phase 2: Server status + tool list** — Add API endpoints and the server/tool list UI section.

## API Changes

### New endpoint: `GET /api/mcp/servers`

Returns MCP server status and tool list. Requires an active SDK client.

```json
{
  "configPath": "/home/user/.copilot/mcp-config.json",
  "configExists": true,
  "clientRunning": true,
  "servers": [
    {
      "name": "playwright",
      "status": "connected",
      "source": "user",
      "error": null,
      "tools": [
        { "name": "navigate", "description": "Navigate to a URL" },
        { "name": "screenshot", "description": "Take a screenshot" }
      ]
    },
    {
      "name": "azure-graph",
      "status": "needs-auth",
      "source": "user",
      "error": null,
      "tools": []
    }
  ]
}
```

Implementation:
- Call `session.rpc.mcp.list()` on any active session → server names + status
- Call `client.rpc.tools.list()` → all tools. Filter to MCP tools (`namespacedName` containing `/`). Group by server name (prefix before `/`).
- Merge: each server gets its status from `mcp.list()` and tools from `tools.list()`.
- If no client running: `{ clientRunning: false, servers: [] }`
- If `mcp-config.json` is malformed: `configExists: true` with `error` field
- `configPath` exposes a local filesystem path — acceptable for local-only tool, needed for text-editor link.

### Existing endpoint unchanged: `GET /api/mcp/auth/servers`

Auth UI continues to use this for OAuth status.

## Implementation

### Phase 1: Rename

**Applet rename:** `applets/mcp-auth/` → `applets/mcp-servers/`
- Rename directory
- Update `meta.json`: slug → `mcp-servers`, name → `MCP Servers`

**LLM-facing tool descriptions:** `src/mcp-auth-tools.ts` — update `applet=mcp-auth` → `applet=mcp-servers` (4 occurrences). These are strings the LLM reads and relays to users — a wrong slug means the agent directs users to a nonexistent page.

**Dev docs:** `src/dev-docs-tool.ts` — update reference.

**Route file:** `src/routes/mcp-auth.ts` keeps its name — it handles auth routes and the new endpoint is auth-adjacent. `src/routes/index.ts` unchanged.

**`stateSchema` in meta.json:** Unchanged. The existing `serverCount`/`pendingAuthCount` fields describe the auth section which is still present.

**No redirect from old slug:** Low-traffic applet, only agent-generated links updated in the same commit.

### Phase 2: Server status + tool list

**Backend:** `src/routes/mcp-auth.ts`

Add `GET /api/mcp/servers` endpoint:
- Check if SDK client is running (session manager exposes this)
- If running: call `session.rpc.mcp.list()` for server status, `client.rpc.tools.list()` for tool names
- Filter tools to MCP tools (those with `namespacedName` containing `/`)
- Group tools by server name (split `namespacedName` on `/`, prefix = server)
- Merge server status + tools into response
- Read `~/.copilot/mcp-config.json` for `configPath`/`configExists`
- If client not running: return `clientRunning: false`

**`src/session-manager.ts`:** Expose methods for the route:
- `listMcpServers()` — calls `session.rpc.mcp.list()` on any active session
- `listAllTools()` — calls `client.rpc.tools.list()` on the shared client
- Guard both with client-running check

**content.html:**
- Add server list section (`#mcp-server-list`) above existing auth section
- Add section divider between servers and auth
- Add "Edit mcp-config.json" link (hidden if no config file)

**script.js:**
- Add `fetchMcpServers()` — calls `GET /api/mcp/servers`
- If `clientRunning: false`: show "Start a session to discover tools"
- Render server headings with status badge and collapsible tool lists
- Status indicators: ✓ connected, ✗ failed, 🔑 needs-auth, ○ disabled
- Tool list: simple bullet list with tool name and description
- Collapse state in memory (not persisted — low-traffic applet)
- Text-editor link: `/?applet=text-editor&path=<configPath>`
- Existing auth functions unchanged

**style.css:**
- Server section heading and status badges
- Tool list styles (simple list, muted descriptions)
- Section divider
- "No client" empty state

## Risks

1. **Rename breaks LLM-facing links** — `/?applet=mcp-auth` used in 4 tool description strings in `src/mcp-auth-tools.ts`. Grep-verifiable, same commit.
2. **RPC calls require active client** — `tools.list()` and `mcp.list()` fail if no SDK client. Endpoint handles gracefully with `clientRunning: false`.
3. **`namespacedName` format assumption** — we assume `"server/tool"` format for MCP tools. If the SDK changes this, tool grouping breaks. Low risk: it's the documented format.
4. **Session RPC access** — need to expose session RPC from session-manager to the route. Minimal surface area: two new methods.
5. **Cannot test MCP servers locally** — User has no MCP config on this machine. Changes must be low-risk: auth section is unchanged, new section degrades gracefully.

## Code Analysis

### Files to modify
- `applets/mcp-auth/` → `applets/mcp-servers/` (rename + edit)
- `src/routes/mcp-auth.ts` — add `GET /api/mcp/servers` endpoint
- `src/session-manager.ts` — expose `listMcpServers()` and `listAllTools()` methods
- `src/mcp-auth-tools.ts` — update `applet=mcp-auth` → `applet=mcp-servers` (4 occurrences)
- `src/dev-docs-tool.ts` — update reference

### Files unchanged
- `src/mcp-auth-service.ts` — auth logic, no applet references
- `src/storage.ts` — `mcp-auth.json` is data storage, not applet slug
- `src/routes/index.ts` — route import unchanged
