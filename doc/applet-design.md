# Applet Design

Consolidated from applet-context-awareness, applet-reactivity, applet-usability, applet-vision, applet-ux.

## What Applets Are

Applets are lightweight HTML/CSS/JS panels that share the DOM with Caco's main UI. They run in a scoped container (`.applet-instance[data-slug]`) with auto-scoped CSS. One applet at a time, destroyed on replacement.

## Layout

- **Desktop:** Side panel (default 40%, resizable via drag handle, 300px min, 80% max). Expand button goes full-width.
- **Mobile:** Full-screen toggle replaces chat view.
- **URL-driven:** `?applet=slug&param=value` — applets react to URL param changes via `onUrlParamsChange`.

## Applet API

Every applet gets `window.appletAPI` with:

| Method | Purpose |
|---|---|
| `onUrlParamsChange(cb)` | URL param changes (initial + navigation) |
| `onSessionEvent(cb)` | Live SDK events (skips history replay) |
| `onSessionChange(cb)` | Session switch (fires immediately with current) |
| `onStateUpdate(cb)` | Agent pushes state to applet |
| `setAppletState(obj)` | Applet pushes state to agent |
| `getSessionId()` | Current active session ID |
| `sendAgentMessage(prompt)` | Send message to active session |
| `callMCPTool(name, args)` | Call an MCP tool directly |
| `navigateAppletUrlParam(k,v)` | Push new URL param (creates history) |
| `updateAppletUrlParam(k,v)` | Replace URL param (no history) |
| `saveTempFile(name, data)` | Save temp file for agent consumption |

All subscriptions auto-cleanup on applet destroy.

## Agent Discovery

Agents discover applets via the `caco_applet_usage` tool which returns URL patterns and purpose descriptions. Each applet's `meta.json` has `agentUsage.purpose` and `stateSchema` for programmatic interaction.

## Event Flow

SDK events pass through a content filter (event-filter.ts) before reaching the client:
- **Always pass:** `session.idle`, `session.error`, `session.usage_info`, `assistant.turn_start`, compaction events, all `caco.*` synthetic events
- **Content filter:** Events with `content`, `deltaContent`, `toolName`, `toolCallId`, `intent`, `progressMessage`, `partialOutput`, or `agentName` pass through
- **Filtered out:** Empty/ephemeral events (reduces noise)

Applets receive the same filtered stream via `onSessionEvent`. They do NOT receive events during history replay.

## Session Metadata

Available on `SessionMeta` (server-side, `~/.caco/sessions/<id>/meta.json`):
- `name`, `kind` (interactive/agent/swarm/scheduled), `model`
- `currentIntent` — last reported agent intent
- `context` — named sets (files, endpoints, etc.)
- `parentSessionId`, `lastObservedAt`, `lastIdleAt`

## Reactivity Today

**What works:**
- `onSessionEvent` — applets can watch live tool executions (git-status auto-refreshes on file edits via 2s throttle)
- `onSessionChange` — applets update when user switches sessions (git-status changes repo path)
- `onStateUpdate` — agent can push data to applet in real-time

**What's missing for richer reactivity:**

### Gap 1: No session metadata in applet API

Applets get `sessionId` and `cwd` from `onSessionChange`, but not `name`, `kind`, `currentIntent`, `model`, or `context`. An applet that wants to show session roadmap/status needs this metadata.

**Fix:** Extend `onSessionChange` callback signature to include metadata, or add `getSessionMeta()` to the API.

### Gap 2: No cross-session event visibility

`onSessionEvent` only receives events for the ACTIVE session. An applet that tracks multiple sessions (roadmap dashboard) can't watch background sessions.

**Fix:** Add `onGlobalEvent(cb)` to applet API, or expose the existing `onGlobalEvent` from websocket.ts. The `session.busy`, `session.listChanged` global events are already broadcast.

### Gap 3: No structured tool result access

`onSessionEvent` receives `tool.execution_complete` with raw result text. For a roadmap applet that wants to parse file changes, it has to parse the text content. There's no structured data about what files were edited/created.

**Fix:** Emit a `caco.fileChanged` synthetic event when edit/create tools complete, with `{ path, action: 'edit'|'create' }`. The server already knows which tools ran.

### Gap 4: No persistent applet-scoped metadata

Applets can set state via `setAppletState`, but this is ephemeral — lost on applet reload. A roadmap applet needs persistent storage tied to the session.

**Fix:** The session's `context` field in `SessionMeta` is a `Record<string, string[]>` already available via PATCH API. Applets could use `context.roadmap` or similar. Need a read API: `GET /api/sessions/:id/context`.

### Gap 5: Session change doesn't include metadata — ✅ DONE

`onSessionChange(sessionId, info)` now provides `{ sessionId, cwd, name, kind, model, currentIntent, busy }`. `getSessionMeta(sessionId?)` fetches full metadata on demand.

## Remaining Gaps

### Gap 2: Cross-session event visibility

**Problem:** `onSessionEvent` only receives events for the active session. A dashboard applet tracking multiple sessions can't watch background sessions complete.

**What exists today:**
- Server broadcasts `session.busy` and `session.listChanged` as global events
- Client receives them in `session-panel.ts` via `onGlobalEvent`
- `onGlobalEvent` is NOT exposed in the applet API

**Implementation plan:**
1. Add `onGlobalEvent(cb)` to applet API — same pattern as `onSessionEvent` with auto-cleanup
2. Applets receive `{ type: 'session.listChanged', data: { reason, sessionId, unobservedCount } }`
3. Applets receive `{ type: 'session.busy', data: { sessionId, isBusy } }`
4. A dashboard applet can then react to any session completing, not just the active one

**Effort:** ~15 lines — expose existing `onGlobalEvent` from websocket.ts, add wrapper with cleanup in applet-runtime.ts.

### Gap 3: Structured file-change events

**Problem:** Tool events have raw text results. An applet tracking file changes must parse `tool.execution_complete` result text to extract paths. Fragile and coupled to tool output format.

**What exists today:**
- `tool.execution_start` has `toolName` (e.g., `str_replace_editor`, `create_file`)
- `tool.execution_complete` has `resultContent` with raw text
- Session context `files` array tracks recently edited files (set by the `set_relevant_context` tool replacement)

**Implementation plan:**
1. Server-side: in the event forwarding pipeline (websocket.ts `broadcastEvent`), detect `tool.execution_complete` for edit/create tools
2. Emit synthetic `caco.fileChanged` event with `{ path, action: 'edit'|'create'|'view', toolName }`
3. Parse the tool result to extract the file path (edit tools include the path in their args, available from the matching `tool.execution_start`)
4. Applets subscribe via `onSessionEvent` and react to `caco.fileChanged`

**Effort:** ~40 lines — tool name detection + arg extraction in the event pipeline, synthetic event emission.

**Alternative:** Skip server-side synthesis. Applets can already watch `tool.execution_start` and check `event.data.toolName`. For file-tracking, `str_replace_editor` and `create_file` tool starts include the path in the event data. This is simpler but couples applets to tool naming.

### Gap 4: Persistent applet-scoped metadata

**Problem:** Applets lose state on reload. A roadmap applet needs persistent tasks/status tied to the session.

**What exists today:**
- `SessionMeta.context` is `Record<string, string[]>` — stores named string arrays (files, endpoints)
- Write: `PATCH /api/sessions/:id` with `{ setContext: { setName, items, mode } }`
- Read: Only available in the full session list response (`GET /api/sessions`), not per-session
- `setAppletState` is ephemeral (WebSocket push, not persisted)

**Implementation plan:**

Phase 1 — Context read API:
1. Add `GET /api/sessions/:id/context` — returns the session's `context` record
2. Add `getSessionContext(sessionId?)` to applet API — fetches context for active/specified session
3. Applets can read `context.roadmap` on load

Phase 2 — Richer context storage:
1. Change `context` type from `Record<string, string[]>` to `Record<string, unknown>` — allows objects, not just string arrays
2. Applets store structured data: `{ roadmap: [{ task: "...", status: "done" }, ...] }`
3. Add `setSessionContext(setName, data)` to applet API — wraps the PATCH call

Phase 3 — Agent integration:
1. Agent's `set_relevant_context` tool already writes to context — extend to support structured data
2. Agent updates roadmap items as it completes tasks
3. Applet watches `onSessionEvent` for `session.idle` → re-reads context → updates display

**Effort:** Phase 1: ~30 lines. Phase 2: ~20 lines (type change + API adjustment). Phase 3: tool modification.

## Roadmap Applet Feasibility

With gaps 1+5 done and gap 4 phase 1:
- Applet loads → `getSessionMeta()` for name/intent/kind
- `onSessionChange` fires with full metadata on session switch
- `getSessionContext()` reads persistent roadmap items
- `onSessionEvent` watches for `session.idle` → re-reads context
- Agent writes roadmap updates via PATCH `setContext`

This is enough for a working roadmap applet. Gap 2 (cross-session) adds multi-session dashboards. Gap 3 (file events) adds file-aware reactivity.
