# Caco Feedback: Agent Activity Observability

Problem: it's hard to tell what the agent is doing. The chat stream shows markdown responses but not which files are being created, edited, or read. The context footer relies on the agent calling `set_relevant_context`, which it forgets. The intent bar relies on `report_intent`, which also drifts.

The user sees a wall of streaming text and has to read it carefully to understand what changed.

## What We Have Today

**Context footer** — shows files and applet links below chat. Populated only when agent calls `set_relevant_context`. Agent frequently forgets, especially after context compaction.

**Intent bar** — shows current agent intent (e.g. "Fixing auth bug"). Populated by `report_intent` tool or `assistant.intent` event. Agent forgets to update it.

**Session panel** — shows model, directory, age. No per-session activity feed.

**Applets** (file-browser, git-status, git-diff, text-editor) — static snapshots. Must be manually refreshed or navigated to.

## The Core Insight

Caco's server already sees every `tool.execution_start` event with full arguments. When the agent calls `create`, `edit`, `view`, `bash`, `grep`, or `glob`, those events flow through `session-messages.ts` line ~279. We currently only intercept `report_intent` — we ignore everything else.

## Ideas

### 1. Auto-populate context footer from tool events (low effort, high value)

When `tool.execution_start` fires for file-touching tools, extract the path and auto-add it to the session's relevant context. No agent cooperation needed.

Tool → path extraction:
- `create` → `args.path`
- `edit` → `args.path`
- `view` → `args.path`

This would keep the context footer populated with files the agent is actually touching, even when it forgets to call `set_relevant_context`. The agent's explicit calls would still work (merge behavior).

**Complexity**: ~20 lines in `session-messages.ts`. Intercept `tool.execution_start`, extract path from known tool names, call existing context storage API.

### 2. Activity feed via WebSocket (medium effort)

Emit a new event type `caco.activity` to the WebSocket whenever interesting tool calls happen. The frontend renders a compact activity log — a scrolling ticker or sidebar showing:

```
edit  src/routes/api.ts
bash  npm test (exit 0)
create doc/terminal.md
view  package.json
```

This is different from the chat stream (which shows the agent's *reasoning*). The activity feed shows what the agent *did*.

**Complexity**: ~50 lines server-side (event emission), ~100 lines frontend (rendering). New component or overlay.

### 3. Applet auto-refresh via polling (low effort)

git-status, file-browser, etc. could poll their data source on a timer (e.g. every 5s when visible). Much simpler than inotify/WebSocket subscriptions.

**Complexity**: ~10 lines per applet. Add `setInterval(refresh, 5000)` when applet is visible, clear on unload.

**Downside**: Wasteful when nothing is changing. But for a local tool hitting localhost APIs, the cost is negligible.

### 4. Server-push applet refresh via tool events (medium effort)

When the server sees a `tool.execution_start` for `edit` or `create`, broadcast a `caco.fileChanged` event on the WebSocket with the affected path. Applets that care about that path can refresh.

```
tool.execution_start { toolName: "edit", args: { path: "/home/carl/caco/src/routes/api.ts" } }
  → broadcast caco.fileChanged { path: "/home/carl/caco/src/routes/api.ts" }
    → text-editor (if viewing that file) refreshes
    → git-status (if viewing that repo) refreshes
```

**Complexity**: ~30 lines server-side. Applets need a `window.appletAPI.onFileChanged(path => ...)` hook — ~20 lines in applet-runtime.

### 5. inotify-based file watching (high effort, probably overkill)

Use `fs.watch` or `chokidar` to watch directories and push changes. Requires managing subscriptions, leases, cleanup on disconnect.

**Verdict**: Probably not worth it. Options 3 or 4 cover the same need with far less complexity. The agent is the primary source of file mutations — we already see those via tool events.

### 6. Hook SDK tool calls for richer metadata

The SDK emits `hook.start` and `hook.end` events (visible in session event types). If the CLI supports registering hooks on built-in tools, we could intercept `create`/`edit`/`view` calls at a deeper level.

Current limitation: we can't *change* built-in tool behavior, but we can observe it. The `tool.execution_start` event already contains the tool name and arguments — this is sufficient for observability without hooks.

### 7. "What changed" summary on idle

When the session goes idle (`session.idle` event), automatically compute a git diff summary and surface it. Like a mini code-review that appears after every agent turn.

Could be as simple as: on `session.idle`, run `git diff --stat` in the session's cwd and emit the result as a `caco.changeSummary` event.

**Complexity**: ~30 lines. Applet or inline widget to display it.

## Recommendation

**Start with #1** (auto-populate context footer from tool events). It's the highest value-to-effort ratio: ~20 lines of code, zero agent cooperation needed, immediately makes the context footer useful.

**Then #4** (server-push file change events). This makes applets reactive without polling — git-status refreshes when the agent edits a file, text-editor reloads when its file changes.

**#3** (polling) is a good fallback if #4 proves too complex, or as a complement for changes not made by the agent (e.g. user edits in another terminal).

**#2** (activity feed) is nice-to-have but lower priority — the context footer with auto-population may be sufficient.
