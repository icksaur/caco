# Session Loading — Known Issues and Attempted Fixes

**Current state:** Cold loads flash the throbber and show empty chat history. Second or third click makes the request and shows the session correctly.

## Symptom

When clicking a session in the session panel:
1. Loading throbber appears briefly (< 1 second)
2. Chat area shows empty
3. No POST /resume appears in network tab
4. Clicking the same session again works — throbber shows longer, resume POST fires, history loads

This happens consistently on "cold" sessions (not previously loaded in this browser session). It does NOT happen if the session was already loaded and the user navigates away and back.

## Root Cause Theories Investigated

### 1. Short-circuit firing incorrectly
**Theory:** `isShowingSession()` returns true when it shouldn't, skipping the resume+load.
**Evidence:** The short-circuit checks `viewState === 'chatting'` + `activeSessionId === id` + `chat has content` + `!isStale`. On a cold load, `viewState` should be `'sessions'` and chat should be empty, so this shouldn't fire.
**Fixes tried:**
- Added `chatHasContent` guard (commit f7a5996)
- Moved short-circuit into `isShowingSession()` method (commit d781ae9)
- Bug kept recurring → the conditions are met in unexpected ways

### 2. Double history requests
**Theory:** Two `requestHistory` WS messages sent, first `historyComplete` resolves with empty content.
**Evidence:** Server logs showed `streamHistory called` twice for the same session before one `historyComplete`.
**Fixes tried:**
- Server-side dedup with `pendingHistory` Set (commit 7f02217) — later removed
- Client-side `HistoryLoader` class with cancel semantics (commit 51c9087)
- History generation counter (commit cddc7ea) — later replaced by HistoryLoader

### 3. WS reconnect racing with activateSession
**Theory:** `reconnectIfNeeded()` inside activateSession triggers `onReconnect` → `historyLoader.load()` which races with activateSession's own `historyLoader.load()`.
**Evidence:** Two `streamHistory called` in server logs, one empty completion.
**Fixes tried:**
- Moved `reconnectIfNeeded` before resume POST (commit 08f7a79)
- onReconnect handler checks `historyLoader.loading` to skip (commit 08f7a79)
- onReconnect checks `chatView.getViewState() !== 'chatting'` (message-streaming.ts)

### 4. historyComplete resolving wrong load
**Theory:** A stale `historyComplete` WS message from a previous session resolves the current load's promise.
**Evidence:** `historyComplete` messages don't include session ID filtering on the client side — they fire for any session.
**Fixes tried:**
- History generation counter to discard stale completions (commit cddc7ea)
- HistoryLoader class with pending.sessionId tracking (commit 51c9087)

### 5. setViewState('chatting') called before history loads
**Theory:** The view transitions to chatting with an empty chat DOM.
**Evidence:** User sees empty chat immediately, then content would have loaded but the UI already shows "chatting".
**Fixes tried:**
- ChatViewController: only call setViewState('chatting') AFTER historyLoader.load() resolves (commit 9e20238)

### 6. `activeSessionId` set from preferences at startup
**Theory:** On page load, `loadPreferences()` sets `activeSessionId` in app-state but doesn't load history. When user clicks the same session, `isShowingSession` sees matching ID.
**Evidence:** `initFromPreferences` calls `setActiveSession(prefs.lastSessionId, prefs.lastCwd)` in app-state.
**Fix tried:** Added `viewState === 'chatting'` to isShowingSession guard — but the viewState might be set by a previous flow.

## What We Haven't Tried

1. **Logging in the short-circuit.** We've never added a console.log inside `isShowingSession` to confirm whether it fires on the bad click. This is the #1 diagnostic gap.

2. **Verifying the WS subscribe timing.** `historyLoader.load()` calls `subscribeToSession()` then `requestHistory()`. If the subscribe hasn't registered on the server when the history events start streaming, the client filters them out (WS client filters by active session at line 275 of websocket.ts).

3. **Checking if `sessionClick` is called vs `activateSession`.** The Navigation API handler in router.ts also calls `chatView.activateSession()` on URL changes. If both fire for the same click, two activations race.

4. **Race between `loadSessions()` and session click.** When opening the session panel, `loadSessions()` fetches `/api/sessions` and calls `sessionTracker.syncFromList()`. If a `session.listChanged` event arrives simultaneously, `loadSessions()` runs twice, re-rendering the session items. The user might click a session item that gets destroyed and re-created mid-click.

## Current Code Path

```
User clicks session item in session panel
  → session-panel.ts: item.onclick = () => sessionClick(session.sessionId)
  → router.ts: sessionClick(id)
  → chat-view-controller.ts: chatView.activateSession(id)
    → isShowingSession(id)?
      YES → return (no POST, no history load)
      NO → setSessionLoading(true)
           → resumeAndLoad(id)
             → reconnectIfNeeded() + waitForConnect()
             → POST /sessions/:id/resume
             → setActiveSession(id, cwd)
             → historyLoader.load(id)
               → subscribeToSession(id)
               → requestHistory(id)
               → wait for historyComplete WS message
           → showChat(id, cwd, model)
           → finally: setSessionLoading(false)
```

## Key Files

| File | Role |
|------|------|
| `public/ts/chat-view-controller.ts` | `activateSession`, `isShowingSession`, `resumeAndLoad`, `showChat` |
| `public/ts/history-loader.ts` | `load()`, `isStale()`, WS subscribe + request + wait |
| `public/ts/router.ts` | `sessionClick()` delegates to chatView |
| `public/ts/session-panel.ts` | session item onclick handler |
| `public/ts/websocket.ts` | subscribe, requestHistory, onHistoryComplete, session filtering |
