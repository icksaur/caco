# Applets

Applets are lightweight HTML/CSS/JS panels that share the DOM with Caco's main UI. They run inside a scoped container (`.applet-instance[data-slug]`) with auto-scoped CSS. One applet is active at a time; loading a new one destroys the previous.

## Layout

- **Desktop:** Side panel (default 40%, resizable, 300px–80%).
- **Mobile:** Full-screen toggle replaces chat view.
- **URL-driven:** `?applet=slug&param=value` — applets react to URL param changes.

## Applet Structure

Each applet lives in `applets/<slug>/` with four files:

| File | Purpose |
|---|---|
| `meta.json` | Slug, name, description, URL params, `agentUsage`, `stateSchema` |
| `content.html` | HTML body of the applet |
| `script.js` | JavaScript — runs in an IIFE with `appletContainer` scoped to the instance |
| `style.css` | CSS — auto-scoped to the applet's container (see below) |

### meta.json

```json
{
  "slug": "my-applet",
  "name": "My Applet",
  "description": "One-line description",
  "params": {
    "path": { "required": true, "description": "Absolute file path" }
  },
  "agentUsage": { "purpose": "What agents use this applet for" },
  "stateSchema": {
    "get": { "selectedFile": "string" },
    "set": null
  }
}
```

## Applet API Reference

All methods are on `window.appletAPI`. Subscriptions auto-cleanup on applet destroy.

> **Timing:** `appletAPI` is available inside event handlers, async callbacks, and any code that runs after applet initialization. At the script's top level the API may not be on `window` yet — inline logic instead of calling an `appletAPI` helper eagerly.

| Method | Description |
|---|---|
| `onUrlParamsChange(cb)` | URL param changes (fires immediately with current, then on navigation) |
| `onSessionEvent(cb)` | Live SDK events for the active session (skips history replay) |
| `onSessionChange(cb)` | Session switch — fires immediately with current session info |
| `onGlobalEvent(cb)` | Cross-session events (`session.busy`, `session.listChanged`) |
| `onStateUpdate(cb)` | Agent pushes state to applet via WebSocket |
| `setAppletState(obj)` | Applet pushes state to agent (queryable via `get_applet_state` tool) |
| `getSessionId()` | Returns current active session ID |
| `getSessionMeta(sessionId?)` | Fetch full session metadata (name, kind, model, intent, busy) |
| `sendAgentMessage(prompt, opts?)` | Send message to active session (opts: `appletSlug`, `imageData`) |
| `callFileApi(endpoint, params)` | Call Caco's file/workspace HTTP endpoints (`read_file`, `write_file`, `list_directory`). Not MCP, no agent involvement. Throws on error. |
| `callMCPTool(...)` | **Deprecated alias** of `callFileApi`. Will be removed. |
| `fetchWithRetry(url, init?, opts?)` | Fetch with retries, timeout, and exponential backoff. Retries on network errors, 5xx, 429. opts: `{ retries, timeoutMs, backoffMs, maxBackoffMs }`. |
| `watchPath(path, opts?)` | Acquire a lease to receive `{ path, eventType, filename? }` events when the file or directory changes. Returns a `WatchHandle` with `.onChange(cb)` and `.close()`. Auto-renews. Non-recursive. See `docs/file-watch-leases.md`. |
| `navigateAppletUrlParam(k, v)` | Push new URL param (creates browser history entry). Pass `null` to delete. |
| `updateAppletUrlParam(k, v)` | Replace URL param (no history entry). |
| `getAppletUrlParams()` | Get current URL params (excluding `applet`) |
| `getAppletSlug()` | Get current applet's slug from URL |
| `saveTempFile(data, opts?)` | Save temp file to `~/.caco/tmp/` (returns `{ path, filename }`) |
| `loadApplet(slug, urlParams?)` | Navigate to another applet |
| `expose(name, fn)` or `expose({fn1,fn2})` | Expose functions globally (needed for `onclick` handlers in IIFE) |
| `listApplets()` | List saved applets (`{ slug, name, description, updatedAt }[]`) |
| `fetch(url, opts?)` | fetch wrapper with 10s timeout. Throws on HTTP errors with server's error message. |
| `escapeHtml(str)` | Escape `&`, `<`, `>`, `"`, `'` for safe `innerHTML`. |
| `toast(msg, opts?)` | Show toast notification. opts: `{ type: 'info'\|'success'\|'error', autoHideMs }`. |

Applets can also call the shell endpoint directly: `fetch('/api/shell', { method: 'POST', body: JSON.stringify({ command, args, cwd }) })`.

## URL Params and Navigation

Applets are opened via `?applet=slug`. Additional params are passed through:

```
?applet=git-status&path=/home/user/repo
?applet=files&openPath=/home/user/docs/notes.md
?applet=files&openFinder=1&openFinderRoot=/home/user/docs
```

Use `onUrlParamsChange(cb)` to react to param changes (including initial load and back/forward navigation). Use `navigateAppletUrlParam` for user-initiated navigation (creates history) or `updateAppletUrlParam` for silent state updates.

## Session Reactivity

### onSessionEvent(cb)

Receives live SDK events for the **active session only**. Events pass through a content filter — empty/ephemeral events are dropped. Does NOT fire during history replay.

Use cases: auto-refresh on file edits (git-status uses 2s throttle), watch for `session.idle` to re-fetch data.

### onSessionChange(cb)

Fires immediately with the current session, then again on every session switch. Callback receives `(sessionId, info)` where `info` includes `{ sessionId, cwd, name, kind, model, currentIntent, busy }`.

Use cases: reload applet data when user switches sessions.

### onGlobalEvent(cb)

Receives broadcast events across all sessions: `session.busy` (`{ sessionId, isBusy }`) and `session.listChanged` (`{ reason, sessionId }`).

Use cases: dashboard applets tracking multiple sessions.

## CSS Auto-Scoping

Every CSS rule in `style.css` is automatically prefixed with `.applet-instance[data-slug="<slug>"]`. This prevents style collisions with the main UI and other applets.

- Regular selectors: `.my-class` → `.applet-instance[data-slug="x"] .my-class`
- Comma selectors are each prefixed independently
- `@keyframes` and `@media` rules are preserved (media inner rules are scoped)
- No manual scoping needed — write plain CSS

## Built-in Applets

| Slug | Purpose |
|---|---|
| `applet-browser` | Browse and load saved applets |
| `calculator` | Basic calculator with keyboard support and history |
| `doodle` | Drawing canvas with AI integration |
| `drum-machine` | 4-track 16-step drum sequencer |
| `files` | Tabbed file viewer — markdown, image, html, diff (unstaged / staged / range). Ctrl+P opens a fuzzy file picker. Default landing for `?openPath=ABS[&diffMode=staged\|range&diffRef=<ref>]` and `?openFinder=1&openFinderRoot=ABS`. |
| `git-status` | Git staging, commits, push/pull — auto-refreshes on file edits |
| `jobs` | View and manage scheduled jobs |
| `mcp-servers` | View MCP server status, tools, and OAuth authentication |
| `session-context` | Session context dashboard: edited files, roadmap, activity, notes |
| `text-editor` | Edit text files with syntax highlighting, Ctrl+S to save |

**Deprecated** (still work via redirect to `files` when a session exists; render standalone in no-session contexts):

| Slug | Replacement |
|---|---|
| `file-finder` | `files&openFinder=1&openFinderRoot=ABS` |
| `markdown-viewer` | `files&openPath=ABS` |
| `image-viewer` | `files&openPath=ABS` |
| `html-viewer` | `files&openPath=ABS` |
| `git-diff` | `files&openPath=ABS[&diffMode=staged\|range&diffRef=<ref>]` (per-file; multi-file `ref=` without a file redirects to `git-status&path=REPO`) |

## Creating New Applets

1. Create `applets/<slug>/` with `meta.json`, `content.html`, `script.js`, `style.css`
2. Define params and `agentUsage` in `meta.json`
3. Use `window.appletAPI` for all platform interaction
4. CSS is auto-scoped — write plain selectors
5. JS runs in an IIFE — use `appletAPI.expose()` for `onclick` handlers
6. Agents discover applets via the `caco_applet_usage` tool and can create new ones via `caco_applet_howto`

The `appletContainer` variable is available in your script, pre-set to your applet's DOM container.
