# API Reference

Complete catalog of all APIs in Caco. All endpoints are prefixed with `/api/`.

## Sessions & Messages

All session endpoints accept `X-Client-ID` header for multi-client isolation.

- `GET /api/session` - Get session info (accepts `?sessionId=`)
- `GET /api/sessions` - List all sessions with available models
- `GET /api/sessions/search` - Search message text across sessions
- `POST /api/sessions` - Create new session
- `POST /api/sessions/:id/resume` - Resume an existing session
- `POST /api/sessions/:id/fork` - Fork session into a new side conversation
- `POST /api/sessions/:id/observe` - Mark session as observed
- `GET /api/sessions/:id/agents` - List SDK custom agents visible to `/agent`
- `POST /api/sessions/:id/agent-dispatch` - Select an SDK custom agent and dispatch a prompt
- `PATCH /api/sessions/:id` - Update session metadata (name, env hint, context)
- `PATCH /api/sessions/:id/applet` - Update active applet params and panel visibility
- `DELETE /api/sessions/:id` - Delete a session
- `GET /api/sessions/:id/state` - Get session state (for agent-to-agent polling)
- `GET /api/sessions/:id/throughput` - Get session token throughput (input/output tokens + 429 count)
- `GET /api/sessions/:id/icon` - Serve session icon (icon.gif preferred, falls back to icon.png). Returns 404 if no icon exists.
- `POST /api/sessions/:id/messages` - Send message to session
- `POST /api/sessions/:id/cancel` - Cancel current streaming
- `GET /api/sessions/:id/export` - Export session as .tar.gz archive
- `POST /api/sessions/import` - Import session from .tar.gz archive
- `GET /api/peers` - List known Caco peers
- `POST /api/peers` - Update peer list (from portal)

**GET /api/session** query params:
- `sessionId` - Optional session ID (defaults to active session)

Returns:
```json
{
  "sessionId": "uuid | null",
  "cwd": "/path/to/workspace",
  "isActive": true,
  "hasMessages": true
}
```

**GET /api/sessions** - List all sessions

Returns:
```json
{
  "activeSessionId": "uuid | null",
  "currentCwd": "/path/to/cwd",
  "unobservedCount": 2,
  "sessions": [
    {
      "sessionId": "uuid",
      "cwd": "/path",
      "model": "claude-sonnet-4.5",
      "name": "Custom Name",
      "summary": "SDK-generated summary",
      "updatedAt": "2026-01-27T12:00:00.000Z",
      "isBusy": false,
      "isUnobserved": true,
      "currentIntent": "Reading file...",
      "scheduleSlug": "daily-backup",
      "scheduleNextRun": "2026-01-28T00:00:00.000Z",
      "folder": "work"
    }
  ],
  "models": [{ "id": "model-id", "name": "Model Name", "cost": 1 }]
}
```

Session display: Use `name || summary` - custom name takes precedence over SDK summary.

**POST /api/sessions** - Create new session
```json
{
  "cwd": "string (optional, defaults to server cwd)",
  "model": "string (optional)",
  "description": "string (optional, custom session name)"
}
```
Returns: `{ sessionId: "uuid", cwd: "string", model: "string" }`

**POST /api/sessions/:id/resume** - Resume session

Returns: `{ success: true, sessionId: "uuid", cwd: "string", isBusy: false }`

**POST /api/sessions/:id/fork** - Fork session into a new side conversation

Creates a new session that inherits the parent's full conversation history (via the SDK's `sessions.fork` RPC). The child has fresh caco state (no roadmap, notes, intent history, applet panel) but inherits name (prefixed with `[fork] `), folder, model, cwd, and `parentSessionId`.

Body: `{ "toEventId": "optional-uuid", "initialMessage": "optional string" }` — when `toEventId` omitted, copies all events. If `initialMessage` is provided (or even if not), the new session immediately receives a `[agent:<parentId>]`-prefixed orientation message so the model knows it has been forked.

Returns: `{ ok: true, sessionId: "new-uuid", cwd: "string", name: "[fork] ...", model: "string" }`

**POST /api/sessions/:id/observe** - Mark session as observed

Called by client when `session.idle` arrives while viewing that session.

Returns: `{ success: true, wasUnobserved: true, unobservedCount: 1 }`

**PATCH /api/sessions/:id** - Update session metadata

Body:
```json
{
  "name": "string (custom session name, empty to clear)",
  "envHint": "string (environment setup hint shown on resume)",
  "folder": "string (virtual folder name, '/' or 'root' to move to root, empty to clear)",
  "setContext": {
    "setName": "files | applet | endpoints | ports",
    "items": ["path/to/file.ts", "other/file.ts"],
    "mode": "replace | merge (default: replace)"
  }
}
```

Returns: `{ success: true }`

**DELETE /api/sessions/:id** - Delete session

Returns: `{ success: true, wasActive: true }`

**PATCH /api/sessions/:id/applet** - Update active applet state for a session

Body: `{ appletParams?: Record<string, string>, panelVisible?: boolean }`

Updates `appletParams` and/or `appletPanelVisible` in session meta. No-op if the session has no active applet. Used by the frontend to sync URL params (debounced) and panel toggle state.

Returns: `{ ok: true }`

**POST /api/sessions/:id/compact** - Force context compaction

Returns:
```json
{
  "tokensRemoved": 12345,
  "messagesRemoved": 8
}
```

**GET /api/sessions/:id/data/:name** - Get session JSON document

Returns the named JSON document from `~/.caco/sessions/<id>/<name>.json`, or `{}` if not found. Name `meta` is reserved.

**PUT /api/sessions/:id/data/:name** - Write session JSON document

Body: any JSON object. Replaces the entire document. Returns 403 for reserved names.

**GET /api/sessions/:id/draft** - Get chat input draft

Returns the persisted chat input draft as `text/plain; charset=utf-8`. 404 if the session directory or draft file is missing.

**PUT /api/sessions/:id/draft** - Write chat input draft

Body: `text/plain`, max 1 MiB. Replaces the file. Returns 204 on success, 404 if the session directory does not exist (no ghost-dir creation), 413 if the body exceeds the cap.

**DELETE /api/sessions/:id/draft** - Delete chat input draft

Returns 204 on success or already-absent, 404 if the session directory does not exist.

**GET /api/draft/newchat** - Get pre-session new-chat draft

Returns the global new-chat textarea draft as `text/plain`. 404 if absent. Stored at `~/.caco/drafts/newchat.txt`.

**PUT /api/draft/newchat** - Write pre-session new-chat draft

Body: `text/plain`, max 1 MiB. Returns 204 / 413.

**DELETE /api/draft/newchat** - Delete pre-session new-chat draft

Returns 204.

**GET /api/sessions/:id/roadmap** - Get session roadmap

Returns roadmap JSON or `{}` if none exists.

**PATCH /api/sessions/:id/roadmap** - Update session roadmap

Body (any subset):
```json
{
  "title": "string",
  "documents": ["path1", "path2"],
  "steps": [{ "title": "...", "status": "pending|active|done|blocked", "description": "...", "context": ["..."] }]
}
```

Returns updated roadmap.

**GET /api/sessions/:id/data** - List session data keys

Returns `["roadmap", ...]`. Excludes meta.json and notes.

**GET /api/sessions/:id/notes** - Get session notes

Returns `{ notes: [{ ts, text }, ...] }`. Notes are NDJSON on disk.

**POST /api/sessions/:id/notes** - Append a note

Body: `{ "text": "string" }`. Returns `{ ok: true, entry: { ts, text } }`.

**POST /api/sessions/:id/notes/archive** - Archive a note

Body: `{ "ts": number }`. Moves note from active to notes-archive.json.

**GET /api/sessions/:id/state** - Get session state (agent-to-agent)

Returns:
```json
{
  "sessionId": "uuid",
  "status": "idle | inactive",
  "cwd": "/path/to/workspace",
  "model": "claude-sonnet-4.5",
  "isActive": true
}
```

**GET /api/sessions/:id/agents** - List SDK custom agents visible to `/agent`

Returns agents from `session.rpc.agent.list()` that are user-invocable and have whitespace-free names.

Returns:
```json
{
  "agents": [
    {
      "name": "reviewer",
      "id": "reviewer",
      "displayName": "Reviewer",
      "description": "Reviews code",
      "model": "gpt-5.5"
    }
  ]
}
```

**POST /api/sessions/:id/agent-dispatch** - Select an SDK custom agent and dispatch a prompt

Body:
```json
{
  "agentName": "reviewer",
  "prompt": "Check maintainability and reliability"
}
```

Selects `agentName` with `session.rpc.agent.select({ name })`, then sends `prompt` through the normal streaming dispatch path. Agent names must be whitespace-free. Returns 409 if the session is busy, 404 for unknown/non-invocable agents.

Returns: `{ "ok": true, "sessionId": "uuid" }`

**POST /api/sessions/:id/messages** - Send message to session
```json
{
  "prompt": "string (required)",
  "imageData": "data:image/...;base64,... (optional)",
  "appletState": "object (optional, batched state from applet)",
  "appletNavigation": "object (optional, navigation context)",
  "source": "'user' | 'applet' | 'agent' | 'scheduler' (optional, defaults to 'user')",
  "appletSlug": "string (optional, applet context for agent)",
  "fromSession": "string (optional, for agent-to-agent calls)",
  "scheduleSlug": "string (optional, for scheduler-originated messages)",
  "correlationId": "string (required for agent calls)"
}
```
Returns: `{ ok: true, sessionId: "uuid" }`

Response streams via WebSocket (not SSE).

**POST /api/sessions/:id/cancel** - Cancel streaming

Returns: `{ ok: true }`

## Preferences & Models

- `GET /api/preferences` - Get user preferences
- `POST /api/preferences` - Update preferences
- `GET /api/models` - List available models from SDK
- `GET /api/models/raw` - Raw SDK model objects (unfiltered, session-independent)
- `GET /api/usage` - Get usage statistics

**GET /api/preferences**

Returns: `{ preferenceKey: value, ... }`

**POST /api/preferences** - Update preferences

Body: `{ preferenceKey: newValue, ... }`
Returns: Updated preferences object

**GET /api/models**

Returns:
```json
{
  "models": [
    { "id": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "multiplier": 1, "priceCategory": "medium", "category": "versatile", "inputPerMtok": 300, "outputPerMtok": 1500, "cachePerMtok": 30 }
  ]
}
```

**GET /api/models/raw**

Returns the untransformed SDK model array. Session-independent. Used by the model-info applet.

```json
{
  "models": [ { "id": "...", "name": "...", "capabilities": {}, "billing": { "tokenPrices": {} }, ... } ]
}
```

**GET /api/usage**

Returns:
```json
{
  "usage": {
    "remainingPercentage": 85,
    "resetDate": "2026-02-01T00:00:00.000Z",
    "isUnlimited": false,
    "updatedAt": "2026-01-27T12:00:00.000Z"
  }
}
```

Returns `null` if no usage data has been received yet.

**GET /api/themes** - List available themes

Returns `{ themes: [{ id, name }, ...] }`. Scans `public/themes/` for CSS files.

## Display Outputs

- `GET /api/outputs/:id` - Get display output by ID
- `POST /api/tmpfile` - Write temporary file to ~/.caco/tmp/

**GET /api/outputs/:id**

Query params:
- `format=json` - Return as JSON with metadata

Returns raw content with appropriate Content-Type, or JSON:
```json
{
  "id": "output-id",
  "data": "base64 or string",
  "metadata": { "type": "embed", "mimeType": "text/html" },
  "createdAt": "2026-01-27T12:00:00.000Z"
}
```

**POST /api/tmpfile** - Write temporary file

Body:
```json
{
  "data": "data:image/png;base64,... or raw base64",
  "mimeType": "image/png (optional, required if raw base64)",
  "filename": "custom.png (optional, auto-generated if omitted)"
}
```

Returns:
```json
{
  "ok": true,
  "path": "/home/user/.caco/tmp/abc123.png",
  "filename": "abc123.png",
  "size": 12345,
  "mimeType": "image/png"
}
```

## Applet State

- `GET /api/applet/state` - Get current applet state (debug)
- `POST /api/applet/state` - Update applet state

## Session Surface

Two-party collaborative document per session. See `docs/session-surface-applet.md`.

- `GET /api/sessions/:id/surface` - Read full surface document
- `GET /api/sessions/:id/surface/changes` - Read human-side `changes` map + `dataToken`
- `POST /api/sessions/:id/surface/mutate` - Agent applies `create`/`update`/`delete`, atomically clears `changes`. Requires `dataToken`.
- `POST /api/sessions/:id/surface/clear-changes` - Agent acknowledges `changes` without writing. Requires `dataToken`.
- `PUT /api/sessions/:id/surface/changes/:itemId` - Human-side write: store one full post-edit item into `changes`. Requires `dataToken`.
- `PATCH /api/sessions/:id/surface/style` - Set `style`, `customScript`, `customStyle`. Requires `dataToken`.

All mutating routes return HTTP 200 with either `{ ok: true, dataToken }` or `{ ok: false, reason, currentDataToken?, errors? }`. Protocol-level failures (`stale`, `unknown-item`, `limit`, `invalid`) are not HTTP errors.

## File Watch Leases

Time-bounded lease for fs.watch on a single file or directory (non-recursive). See `docs/file-watch-leases.md`. Caco runs as the user — no path whitelist.

- `POST /api/sessions/:id/watch` - Acquire a lease. Body: `{ path, scope?: "file"|"dir" }`. Returns `{ ok, leaseId, ttlMs, path, scope }` or `{ ok: false, reason }` (reasons: `path-not-found`, `lease-cap`, `watch-failed`).
- `POST /api/sessions/:id/watch/:leaseId/renew` - Reset the TTL. Returns `{ ok, ttlMs, expiresAt }`.
- `DELETE /api/sessions/:id/watch/:leaseId` - Release the lease. Idempotent.
- `GET /api/sessions/:id/watch` - List the session's active leases.

Change notifications arrive on the session's WebSocket as `caco.fs.changed` events with `{ leaseId, path, eventType: "change"|"rename", filename? }`. Multiple events for the same lease within 150ms are coalesced.

Process-wide cap: 16 concurrent leases. Default TTL: 5 minutes. Watchers are refcounted by canonical path so multiple leases on the same file share one underlying fs.watch.

## Saved Applets

- `GET /api/applets` - List all saved applets
- `POST /api/applets/:slug/load` - Load applet + clear server state
- `GET /api/applets/:slug/assets/:filename` - Serve static applet asset (JS bundles, images)

**GET /api/applets** response:
```json
{
  "applets": [
    {
      "slug": "calculator",
      "name": "Calculator",
      "description": "iOS-style calculator",
      "params": { "expression": "Math expression to evaluate" },
      "updatedAt": "2026-01-27T...",
      "paths": {
        "html": "~/.caco/applets/calculator/content.html",
        "js": "~/.caco/applets/calculator/script.js",
        "css": "~/.caco/applets/calculator/style.css",
        "meta": "~/.caco/applets/calculator/meta.json"
      }
    }
  ]
}
```

**POST /api/applets/:slug/load** - Load applet content

Returns:
```json
{
  "ok": true,
  "slug": "calculator",
  "title": "Calculator",
  "html": "<div>...</div>",
  "js": "// script content or null",
  "css": "/* styles or null */"
}
```

## File Browser

- `GET /api/files` - List files in directory
- `GET /api/file` - Serve raw file content (max 10MB)
- `PUT /api/files/*` - Write file content (path in URL)

**GET /api/files** query params:
- `path` - Absolute or relative path (defaults to server cwd)

Returns:
```json
{
  "path": "/home/user/caco/src",
  "files": [
    { "name": "app.ts", "type": "file", "size": 1234 },
    { "name": "lib", "type": "directory", "size": 0 }
  ]
}
```

**GET /api/file** query params:
- `path` - Absolute or relative path to file

Returns raw content with appropriate Content-Type header.

Note: All file endpoints allow any filesystem path (absolute or relative to cwd). This is personal software -- the agent already has full filesystem access via Copilot tools.

**PUT /api/files/\*** - Write file content
- URL path contains file path: `PUT /api/files/src/app.ts`
- Absolute paths also accepted: `PUT /api/files//home/user/file.txt`
- Body: raw file content (text/plain)
- Creates parent directories automatically
- Returns: `{ ok: true, path, size }`

## Project Files & Prompts

- `GET /api/project-files` - Recursive file listing with fuzzy search
- `GET /api/prompts` - List available prompt templates
- `GET /api/prompts/:name` - Get prompt template content
- `GET /api/extensions` - List installed extensions
- `GET /api/extensions/:slug/style.css` - Serve extension CSS
- `GET /api/extensions/:slug/client.js` - Compile and serve extension client JS

**GET /api/project-files** query params:
- `cwd` - Root directory to scan (defaults to server cwd)
- `q` - Fuzzy search query (optional)

Excludes hidden files, binary files, and common build directories (node_modules, .git, dist, etc.). Respects `.gitignore` if present. Capped at 10,000 files. Results cached for 30s.

Returns:
```json
{
  "files": ["src/app.ts", "src/routes/api.ts", "package.json"]
}
```

**GET /api/prompts** - List prompt templates

Scans `~/.caco/prompts/*.md` (global) and `.caco/prompts/*.md` (server-local). Server-local overrides global on name collision.

Returns:
```json
{
  "prompts": [
    { "name": "review", "description": "Review the current code changes" }
  ]
}
```

**GET /api/prompts/:name** - Get prompt content

Returns:
```json
{
  "name": "review",
  "content": "# Code Review\n\nPlease review..."
}
```

**GET /api/extensions** - List installed extensions

Scans `~/.caco/extensions/*/manifest.json` (user-global) and `.caco/extensions/*/manifest.json` (server-local). Server-local overrides user-global on slug collision.

Returns:
```json
{
  "extensions": [
    { "slug": "theme-dark", "name": "Dark Theme", "description": "...", "provides": ["css"], "dir": "/home/user/.caco/extensions/theme-dark" }
  ]
}
```

**GET /api/extensions/:slug/style.css** - Extension CSS

Returns the `style.css` file from the extension directory. 404 if extension doesn't exist, doesn't provide `"css"`, or file is missing.

**GET /api/extensions/:slug/client.js** - Extension client JS

Compiles `client.ts` from the extension directory via esbuild (ESM, bundled). Cached by mtime. 404 if extension doesn't exist, doesn't provide `"client"`, or compilation fails.

## Scheduled Tasks

- `GET /api/schedule` - List all schedules
- `GET /api/schedule/:slug` - Get specific schedule
- `PUT /api/schedule/:slug` - Create or update schedule
- `PATCH /api/schedule/:slug` - Partial update (toggle enabled)
- `DELETE /api/schedule/:slug` - Delete schedule
- `POST /api/schedule/:slug/run` - Manually trigger schedule

**GET /api/schedule** - List all schedules

Returns:
```json
{
  "schedules": [
    {
      "slug": "daily-backup",
      "prompt": "Backup important files",
      "enabled": true,
      "schedule": { "type": "cron", "expression": "0 0 * * *" },
      "sessionConfig": { "model": "gpt-4", "persistSession": true },
      "lastRun": "2026-01-27T00:00:00.000Z",
      "lastResult": "success",
      "lastError": null,
      "nextRun": "2026-01-28T00:00:00.000Z",
      "sessionId": "uuid",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-27T00:00:00.000Z"
    }
  ]
}
```

**GET /api/schedule/:slug** - Get specific schedule

Returns: Same structure as single schedule in list above

**PUT /api/schedule/:slug** - Create or update schedule

Body:
```json
{
  "prompt": "string (required)",
  "enabled": true,
  "schedule": {
    "type": "cron | interval",
    "expression": "0 0 * * * (for cron)",
    "intervalMinutes": 60
  },
  "sessionConfig": {
    "model": "string (optional)",
    "persistSession": true
  }
}
```

Returns: `{ slug: "daily-backup", nextRun: "2026-01-28T00:00:00.000Z", created: true }`

**PATCH /api/schedule/:slug** - Partial update (toggle enabled)

Body:
```json
{
  "enabled": true
}
```

Returns: `{ slug: "daily-backup", enabled: true, nextRun: "2026-01-28T00:00:00.000Z" }`

**DELETE /api/schedule/:slug** - Delete schedule

Returns: `{ success: true }`

**POST /api/schedule/:slug/run** - Manually trigger

Returns: `{ slug: "daily-backup", status: "executed", sessionId: "uuid" }`

## MCP Tools (HTTP Proxy)

HTTP endpoints for applet JS to call MCP tools directly.

- `GET /api/mcp/servers` - List MCP servers with status and tools (requires active SDK client)
- `GET /api/mcp/tools` - List available MCP tools
- `POST /api/mcp/read_file` - Read file contents
- `POST /api/mcp/write_file` - Write file contents
- `POST /api/mcp/list_directory` - List directory contents

**Allowed directories:** Current workspace, `~/.caco/`, `/tmp/`

**GET /api/mcp/servers** - List MCP servers with status and discovered tools

Requires an active SDK client. Returns server connection status from `session.rpc.mcp.list()` and tool names from `client.rpc.tools.list()`, grouped by server.

Returns:
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
    }
  ]
}
```

When no SDK client is running: `{ clientRunning: false, servers: [] }`.

**GET /api/mcp/tools** - List available tools

Returns:
```json
{
  "tools": [
    { "name": "read_file", "description": "Read file contents", "parameters": { "path": "string" } },
    { "name": "write_file", "description": "Write file contents", "parameters": { "path": "string", "content": "string" } },
    { "name": "list_directory", "description": "List directory contents", "parameters": { "path": "string" } }
  ],
  "allowedDirectories": ["/current/cwd", "/home/user/.caco", "/tmp"]
}
```

**POST /api/mcp/read_file** - Read file

Body: `{ "path": "/path/to/file.txt" }`
Returns: `{ ok: true, content: "file contents" }`

**POST /api/mcp/write_file** - Write file

Body: `{ "path": "/path/to/file.txt", "content": "new content" }`
Returns: `{ ok: true, path: "/path/to/file.txt" }`

**POST /api/mcp/list_directory** - List directory

Body: `{ "path": "/path/to/dir" }`
Returns:
```json
{
  "ok": true,
  "files": [
    { "name": "file.txt", "path": "/path/to/dir/file.txt", "isDirectory": false, "size": 123, "modified": "2026-01-27T12:00:00.000Z" }
  ]
}
```

## Shell Execution

Execute allowlisted shell commands for applets and developer tools.

- `POST /api/shell` - Execute shell command

**POST /api/shell** - Execute command

Body:
```json
{
  "command": "git",
  "args": ["status", "--porcelain=v2"],
  "cwd": "/optional/working/directory"
}
```

Returns (success):
```json
{
  "stdout": "1 M. N... 100644 src/file.ts\n",
  "stderr": "",
  "code": 0
}
```

Returns (command error, e.g., not a git repo):
```json
{
  "stdout": "",
  "stderr": "fatal: not a git repository\n",
  "code": 128
}
```

**Security:**
- Uses `execFile` with args array (no shell metacharacter interpretation)
- Working directory must be absolute path and exist
- Timeout: 60s, max output: 10MB

**Output sanitization:**
- ANSI escape codes stripped
- CRLF normalized to LF
- Carriage returns removed

See [shell-api.md](shell-api.md) for full specification.

## Server Management

- `POST /api/restart` - Schedule a graceful server restart. Waits for active sessions to complete.

Returns:
```json
{
  "ok": true,
  "activeDispatches": 0,
  "message": "Restart initiated."
}
```

## Session Migration

Export and import sessions between Caco instances (e.g., work → home).

**GET /api/sessions/:id/export** — Download session as `.tar.gz` archive.

Query params:
- `?delete=true` — Remove session after export (migration mode)

Archive structure:
```
sdk/<sessionId>/workspace.yaml, events.jsonl, checkpoints/, files/
caco/<sessionId>/meta.json, outputs/, icon.*, roadmap.json
```

Example — export from machine A:
```bash
curl -o session.tar.gz http://machineA:53000/api/sessions/084c42d2-.../export
# Or with delete (migration):
curl -o session.tar.gz http://machineA:53000/api/sessions/084c42d2-.../export?delete=true
```

**POST /api/sessions/import** — Upload a `.tar.gz` archive (raw body, not multipart).

Query params:
- `?cwd=/new/path` — Rewrite CWD if the project path differs on the target machine
- `?force=true` — Overwrite if session ID already exists

Example — import on machine B:
```bash
curl -X POST --data-binary @session.tar.gz http://machineB:53000/api/sessions/import
# With CWD rewrite (Windows → Linux):
curl -X POST --data-binary @session.tar.gz "http://machineB:53000/api/sessions/import?cwd=/home/user/workspace/caco"
```

Returns:
```json
{
  "ok": true,
  "sessionId": "084c42d2-...",
  "message": "Session 084c42d2-... imported successfully"
}
```

If CWDs match across machines (e.g., both use `~/workspace/`), no rewrite is needed — just export and import.

## Debug

- `GET /api/debug/messages` - Raw message structure

Returns:
```json
{
  "count": 5,
  "messages": [
    { "type": "user.message", "content": "Hello", "hasToolRequests": false }
  ]
}
```

## Agent Tools (Custom MCP Tools)

Custom tools available to the Copilot agent via SDK.

### Applet Tools

Defined in `src/applet-tools.ts`:

- `caco_applet_howto` - Get documentation for creating applets
- `caco_applet_usage` - Get applet URL patterns for linking users to applets
- `get_applet_state` - Query state pushed by applet JS
- `set_applet_state` - Push state to running applet via WebSocket
- `reload_page` - Trigger browser page refresh
- `restart_server` - Schedule server restart after delay

**caco_applet_howto** - no parameters

Returns comprehensive documentation on:
- File structure (`~/.caco/applets/<slug>/`)
- Required files (meta.json, content.html) and optional (script.js, style.css)
- JavaScript APIs available (setAppletState, sendAgentMessage, listApplets)
- How to share applets via URL (`?applet=slug`)

**caco_applet_usage** - no parameters

Returns markdown link examples for showing files, diffs, git status, images, etc. via installed applets. Lists applet URL patterns and parameter schemas.

**get_applet_state** parameters:
- `key` (string, optional) - Get specific key instead of full state

Returns: State object + navigation context (stack, urlParams)

**set_applet_state** parameters:
- `data` (object, required) - State object to push to applet
- `sessionId` (string, optional) - Target session (broadcasts to all if omitted)

Pushes state via WebSocket to running applet. Applet receives via `onStateUpdate()` callback.

**reload_page** - no parameters

Sends reload signal to browser.

**restart_server** parameters:
- `delay` (number, optional) - Seconds to wait before restarting (1-30, default: 3)

Schedules graceful restart, waiting for active sessions to complete.

### Display Tools

Defined in `src/display-tools.ts`:

- `embed_media` - Embed YouTube/Vimeo/SoundCloud/Spotify. Takes `url` (string, required).

Note: Embedding happens client-side. The tool returns confirmation that the embed was queued, but cannot confirm successful rendering.

### Context Tools

Defined in `src/context-tools.ts`:

- `set_relevant_context` - Track files and resources for session continuity
- `get_relevant_context` - Retrieve saved session context

**set_relevant_context** parameters:
- `setName` (string, required) - Name of context set (`files`, `applet`, `endpoints`, `ports`)
- `items` (string[], required) - Items for this set (max 10 per set, 50 total)
- `mode` (string, optional) - `replace` (default) or `merge` with existing

Persists context to session metadata. Broadcasts `caco.context` event to connected clients.

**get_relevant_context** parameters:
- `setName` (string, optional) - Specific set to retrieve, or omit for all

Returns stored context for the session.

### Agent-to-Agent Tools

Defined in `src/agent-tools.ts`:

- `send_agent_message` - Send a message to another agent session
- `get_session_state` - Check current state of an agent session
- `list_models` - List available models for creating sessions
- `create_agent_session` - Create a new agent session

**send_agent_message** parameters:
- `sessionId` (string, required) - Target session ID
- `message` (string, required) - Message/prompt to send

Sends message with `source: 'agent'` and includes originating session ID for callbacks. Requires correlationId from dispatch context.

**get_session_state** parameters:
- `sessionId` (string, required) - Target session ID to check

Returns session status (`idle`/`inactive`), cwd, model, isActive.

**list_models** - no parameters

Returns available models from SDK.

**create_agent_session** parameters:
- `cwd` (string, required) - Working directory for the new session
- `model` (string, required) - Model ID (e.g., `claude-sonnet-4.5`)
- `initialMessage` (string, optional) - First message to send immediately

Creates a new session and optionally sends an initial message. Returns the new session ID.

### Session Memory Tools

Defined in `src/roadmap-tool.ts`:

- `get_roadmap` - Read session roadmap (steps, documents, status)
- `update_roadmap` - Add/update/remove steps, set title and documents
- `session_note` - Append or read timestamped notes that survive compaction

**get_roadmap** parameters:
- `sessionId` (string, optional) - Read another session's roadmap

**update_roadmap** parameters (all optional):
- `title` (string) - Set title
- `steps` (array) - Replace entire step list
- `documents` (string[]) - Replace document list
- `addStep` (object) - Append a step `{ title, description?, status?, context? }`
- `stepTitle` (string) - Find step by title (case-insensitive prefix match)
- `updateStep` (object) - Update fields on matched step
- `removeStepIndex` / `removeStepTitle` - Remove a step

**session_note** parameters:
- `append` (string, optional) - Add a timestamped note
- `sessionId` (string, optional) - Read another session's notes

### Session History Tool

Defined in `src/session-history-tool.ts`:

- `caco_session_store_sql` - Query the global session history database

**caco_session_store_sql** parameters:
- `query` (string, required) - SQL query (SELECT only)

Executes read-only SQL against `~/.copilot/session-store.db` — the cross-session history database maintained by the Copilot CLI. Tables: `sessions`, `turns`, `checkpoints`, `session_files`, `session_refs`, `search_index`.

Uses `sql.js` (WASM SQLite). Returns up to 500 rows as `{ columns, rows, rowCount, truncated }`.

This works around a limitation where SDK-spawned sessions don't get the CLI's built-in `session_store` SQL routing.

### Dev and Extension Tools

Defined in `src/dev-docs-tool.ts` and `src/extensions-tool.ts`:

- `caco_dev_docs` - Get Caco documentation (usage, setup, architecture, build commands)
- `caco_extensions` - Discover loaded extensions and extension API

## JavaScript APIs (Applet Runtime)

Global functions available to applet JavaScript code via `window.appletAPI` or legacy globals.

Defined in `public/ts/applet-runtime.ts`

### API Access

All APIs are available on `window.appletAPI`:
```javascript
const { setAppletState, sendAgentMessage, listApplets } = window.appletAPI;
```

Legacy globals also work for backward compatibility:
```javascript
setAppletState({ key: 'value' });  // window.setAppletState
expose('myFunc', myFunc);           // window.expose
```

### State Management

#### setAppletState(state)

Push state to server for agent to query via `get_applet_state` tool.

```javascript
setAppletState({
  inputValue: document.getElementById('input').value,
  selectedOption: currentSelection
});
```

Uses WebSocket when connected for real-time sync.

#### onStateUpdate(callback)

Receive state updates pushed by agent via `set_applet_state` tool.

```javascript
onStateUpdate((state) => {
  console.log('Agent pushed state:', state);
  document.getElementById('result').textContent = state.result;
});
```

### Navigation

#### listApplets()

Get list of saved applets.

```javascript
const applets = await appletAPI.listApplets();
// Returns: [{ slug, name, description, updatedAt }, ...]
```

#### getAppletSlug()

Get current applet slug from URL.

```javascript
const slug = appletAPI.getAppletSlug();
// Returns: string | null ('calculator' if URL is /?applet=calculator)
```

#### onUrlParamsChange(callback)

Register callback for URL param changes. **Recommended** for applets that use URL params.

Handles both initial load and navigation (back/forward, chat links to same applet with different params).

```javascript
appletAPI.onUrlParamsChange(function(params) {
  loadContent(params.path || '');
});
```

#### getAppletUrlParams()

Get URL query params (excluding 'applet' slug).

```javascript
const params = appletAPI.getAppletUrlParams();
// { file: '/path/to/file.jpg', mode: 'edit' }
```

#### updateAppletUrlParam(key, value)

Update URL query param (uses replaceState, no history entry).

```javascript
appletAPI.updateAppletUrlParam('page', '2');
// URL becomes /?applet=my-app&page=2 (no back button entry)
```

#### navigateAppletUrlParam(key, value)

Update URL query param with history entry (uses pushState).

```javascript
appletAPI.navigateAppletUrlParam('file', '/new/path');
// URL changes, creates back button entry
```

### Agent Communication

#### sendAgentMessage(prompt, options?)

Send a message to the agent from applet JS. Creates an "applet" bubble (orange) in the chat.

**Options:**
- `appletSlug` (string, optional) - Applet slug for context (defaults to current applet)
- `imageData` (string, optional) - Base64 data URL for image submission (max 100KB)

```javascript
await appletAPI.sendAgentMessage('Set the calculator value to 42');

await appletAPI.sendAgentMessage('Load file', { appletSlug: 'files' });

const imageData = canvas.toDataURL('image/png');
await appletAPI.sendAgentMessage('What is this?', { imageData });
```

Returns a Promise that resolves when message is sent (not when agent responds).

#### getSessionId()

Get the active chat session ID.

```javascript
const sessionId = appletAPI.getSessionId();
// Returns: string | null
```

### File Operations

#### saveTempFile(dataUrl, options?)

Save data to `~/.caco/tmp/` for agent viewing.

> **Note:** For images, prefer `sendAgentMessage` with `imageData` option for direct submission.

```javascript
const canvas = document.getElementById('myCanvas');
const { path } = await appletAPI.saveTempFile(canvas.toDataURL('image/png'));
await appletAPI.sendAgentMessage(`Analyze image at ${path}`);
```

Options:
- `filename` (string, optional) - Custom filename
- `mimeType` (string, optional) - MIME type if using raw base64

#### callFileApi(endpoint, params)

Call one of Caco's built-in file/workspace HTTP endpoints from applet JS. These are not MCP tools and do not consume agent tokens — they are plain Caco backend routes under `/api/mcp/*`.

For arbitrary shell commands, use `fetch('/api/shell', ...)` directly.

```javascript
const result = await appletAPI.callFileApi('read_file', { path: '/path/to/file.txt' });

await appletAPI.callFileApi('write_file', {
  path: '/path/to/output.txt',
  content: 'Hello world'
});

const files = await appletAPI.callFileApi('list_directory', { path: '/home/user' });
```

#### callMCPTool(...)

Deprecated alias of `callFileApi`. Misnamed — these endpoints have nothing to do with MCP. Will be removed in a future release.

#### fetchWithRetry(url, init?, options?)

Fetch wrapper with retries, per-attempt timeout, and exponential backoff with jitter. For applet `customScript` to call flaky external APIs (Azure DevOps, internal services, third parties).

Retries on:
- Network errors (offline, DNS, connection reset)
- HTTP 5xx
- HTTP 429
- Per-attempt timeout

Does NOT retry on other 4xx (won't fix themselves on retry).

```javascript
const res = await appletAPI.fetchWithRetry('https://api.example.com/data', {
  headers: { 'Authorization': 'Bearer ' + token }
}, {
  retries: 3,         // default 3
  timeoutMs: 15000,   // default 15s per attempt
  backoffMs: 500,     // default 500ms, doubles each retry
  maxBackoffMs: 8000  // default 8s cap
});
const data = await res.json();
```

On final failure, throws `FetchWithRetryError` with `attempts` and `lastStatus`.

### Function Exposure

#### expose(name, fn) / expose({ fn1, fn2 })

Expose functions to global scope for onclick handlers.

```javascript
function handleClick() { /* ... */ }
expose('handleClick', handleClick);

// Or expose multiple at once:
expose({ handleClick, handleSubmit, handleCancel });
```

**Alternative (recommended):** Use addEventListener instead:
```javascript
document.getElementById('btn').addEventListener('click', handleClick);
```

### Global Variables

| Variable | Description |
|----------|-------------|
| `appletContainer` | Reference to `.applet-content` element |

### DOM APIs

Applet JS runs in global scope with full DOM access:

```javascript
document.getElementById('myElement')
document.querySelector('.my-class')

const response = await fetch('/api/applets');
const data = await response.json();
```

### Shell Commands

Use `fetch('/api/shell', ...)` for shell command execution (see [Shell Execution](#shell-execution)):

```javascript
const result = await fetch('/api/shell', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    command: 'git',
    args: ['status', '--porcelain=v2']
  })
});
const { stdout, stderr, code } = await result.json();
```

---

## WebSocket Protocol

WebSocket connection at `/ws`.

### Connection

Connect to WebSocket (no query params needed):
```javascript
const ws = new WebSocket('ws://localhost:53000/ws');
```

After connecting, subscribe to a session and request history:
```javascript
ws.send(JSON.stringify({ type: 'subscribe', sessionId }));
ws.send(JSON.stringify({ type: 'requestHistory', sessionId }));
```

### Server → Client Messages

All messages are JSON with a `type` field:

| Type | Description |
|------|-------------|
| `event` | Session-scoped SDK event (wraps all streaming data) |
| `globalEvent` | Broadcast to all clients (session list changes, unobserved count) |
| `stateUpdate` | Applet state pushed from agent or another tab |
| `historyComplete` | History streaming finished for requested session |
| `state` | Response to `getState` request |
| `pong` | Response to ping |
| `error` | Error message |

**Event wrapper** (session-scoped):
```json
{
  "type": "event",
  "sessionId": "uuid",
  "event": {
    "type": "assistant.message.delta",
    "data": { "content": "incremental text" }
  }
}
```

Common SDK event types inside `event.type`:
- `user.message` - User message (enriched with `source`, `appletSlug`, `fromSession`)
- `assistant.message`, `assistant.message.delta` - Assistant response
- `assistant.turn_start` - Start of assistant turn
- `tool.execution_start`, `tool.execution_complete` - Tool activity
- `session.idle` - Session finished processing
- `session.error` - Session error
- `session.compaction_start`, `session.compaction_complete` - Conversation compaction
- `caco.embed` - Media embed queued for rendering
- `caco.context` - Session context changed
- `caco.reload` - Browser should refresh

**GlobalEvent wrapper**:
```json
{
  "type": "globalEvent",
  "event": {
    "type": "session.listChanged",
    "data": { "reason": "created", "sessionId": "uuid" }
  }
}
```

**StateUpdate**:
```json
{
  "type": "stateUpdate",
  "sessionId": "uuid",
  "data": { "key": "value" }
}
```

### Client → Server Messages

| Type | Description |
|------|-------------|
| `subscribe` | Subscribe to session events (with `sessionId`) |
| `requestHistory` | Request history replay for session (with `sessionId`) |
| `setState` | Push applet state to server |
| `getState` | Request current applet state |
| `ping` | Keep-alive |

**subscribe**:
```json
{
  "type": "subscribe",
  "sessionId": "uuid"
}
```

**requestHistory**:
```json
{
  "type": "requestHistory",
  "sessionId": "uuid"
}
```

**setState**:
```json
{
  "type": "setState",
  "data": { "key": "value" }
}
```

Note: `sendMessage` via WebSocket is deprecated. Use `POST /api/sessions/:id/messages` instead.

---

## URL Parameters

| Parameter | Description |
|-----------|-------------|
| `?applet=slug` | Load applet on page load |

Example: `http://localhost:53000/?applet=calculator`

---

## File Storage

### Applet Storage Structure

Location: `~/.caco/applets/<slug>/`

```
~/.caco/
└── applets/
    └── calculator/
        ├── meta.json      # { slug, name, description, createdAt, updatedAt }
        ├── content.html   # HTML content
        ├── script.js      # JavaScript
        └── style.css      # CSS styles
```

The `~/.caco/` directory has its own git repository, separate from the main project.
