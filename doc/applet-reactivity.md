# Applet Reactivity

**Status: Proposed**

Applets should react to session activity — auto-refresh when the agent edits files, show diffs from completed work, and know which session they're observing.

## Problem

1. **No way to watch the chat stream.** Applets can only receive explicit state pushes via `onStateUpdate`. They can't subscribe to SDK events (tool calls, file edits, session.idle). The git-status applet requires manual refresh.

2. **No session awareness.** When the user switches sessions, the applet doesn't know. It keeps showing data from the previous session's CWD.

3. **No "after the fact" diff view.** When a background agent finishes work, there's no easy way to see what it changed. The git-status applet shows current working tree state, not what a specific session did.

## Proposals

### 1. `onSessionEvent` — applet chat-stream callback

Expose `onEvent` to applets via `window.appletAPI`. Applets can subscribe to the same SDK event stream that the chat renders.

```typescript
interface AppletAPI {
  // ... existing ...
  onSessionEvent(callback: (event: SessionEvent) => void): () => void;
}
```

**Use cases:**
- Git-status applet refreshes when `tool.execution_complete` fires for edit/create tools
- A "file watcher" applet highlights recently modified files
- A "progress" applet shows tool call count and intent changes

**Throttling:** Applets should throttle their reactions. The runtime could provide a throttled variant:
```typescript
onSessionEvent(callback, { throttleMs: 2000 });
```

Or applets manage their own debounce.

**History vs live:** During history replay (`isLoadingHistory` is true), events fire rapidly. Applets should either:
- Ignore events during history (only react to live events)
- Batch and react once after history completes

The runtime could add a flag: `event._isHistory = true` or provide `onLiveSessionEvent` that filters automatically.

### 2. `onSessionChange` — session switch callback

Notify applets when the active session changes so they can update their context.

```typescript
interface AppletAPI {
  // ... existing ...
  onSessionChange(callback: (sessionId: string, cwd: string) => void): () => void;
}
```

**Use cases:**
- Git-status applet switches to the new session's CWD
- File-browser applet navigates to the new session's working directory
- Any applet that shows session-scoped data

**Implementation:** Add a callback set to `applet-runtime.ts`. Fire it from `setActiveSession` in `app-state.ts` (or from `activateSession` in `router.ts` after `setActiveSession`).

### 3. Git-status applet improvements

#### 3a. Auto-refresh on file changes

Subscribe to `onSessionEvent` and refresh when the agent edits files:

```javascript
const { onSessionEvent } = window.appletAPI;
let refreshTimer = null;

onSessionEvent((event) => {
  if (event.type === 'tool.execution_complete') {
    const toolName = event.data?.toolName;
    if (toolName === 'edit' || toolName === 'create') {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => refresh(), 2000);
    }
  }
  if (event.type === 'session.idle') {
    refresh();
  }
});
```

#### 3b. Show last commit when working tree is clean

When `git status` returns no changes, show the most recent commit instead of an empty state:

```javascript
async function refresh() {
  const status = await gitStatus();
  if (status.files.length === 0) {
    // Working tree clean — show last commit
    const log = await shell('git', ['log', '-1', '--format=%H %s'], cwd);
    const [hash, ...msgParts] = log.stdout.trim().split(' ');
    showLastCommit(hash, msgParts.join(' '));
  } else {
    renderFileList(status.files);
  }
}
```

The "show last commit" view would include:
- Commit hash (short) + message
- A "View diff" link that opens git-diff applet with `?ref=HEAD~1..HEAD`
- Author + relative time

#### 3c. Git-diff applet: support ref ranges

Currently git-diff shows staged/unstaged diffs. Extend it to accept a `ref` URL parameter for commit ranges:

```
/?applet=git-diff&path=/repo&ref=HEAD~1..HEAD
```

This enables viewing what a specific commit changed — useful for reviewing background agent work.

**Implementation:** In the git-diff applet script, check for `ref` param:
```javascript
const ref = appletAPI.getAppletUrlParams().get('ref');
if (ref) {
  // git diff <ref> -- shows diff for the range
  const result = await shell('git', ['diff', ref], cwd);
} else {
  // existing behavior: staged/unstaged diffs
}
```

## Implementation order

1. **`onSessionEvent`** — expose `onEvent` via appletAPI (small change in applet-runtime.ts)
2. **`onSessionChange`** — add callback for session switches (small)
3. **Git-status auto-refresh** — use `onSessionEvent` with throttle (medium)
4. **Git-status clean-tree → last commit** — show commit when no changes (medium)
5. **Git-diff ref ranges** — extend diff applet for commit ranges (medium)

## Key files

| File | Change |
|------|--------|
| `public/ts/applet-runtime.ts` | Expose `onSessionEvent`, `onSessionChange` on appletAPI |
| `public/ts/websocket.ts` | `onEvent` already exists, just needs to be exposed |
| `applets/git-status/script.js` | Add event subscription, auto-refresh, clean-tree view |
| `applets/git-diff/script.js` | Add `ref` param support for commit ranges |
