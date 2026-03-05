# plan

This document must only contain the next actions, no cut or deferred work.
The items in this plan must be actionable by another agent without guesswork.
When all items are complete, remove all items.

legend:

[ ] incomplete
[*] complete

---

## Shared SDK Client (doc/shared-sdk-client.md)

Branch: `shared-client` off `master`

### Step 1: Add ensureClient + sharedClient to SessionManager

[ ] `src/session-manager.ts`:
  - Add `private sharedClient: CopilotClientInstance | null = null`
  - Add `private clientStarting: Promise<CopilotClientInstance> | null = null`
  - Add `private async ensureClient(): Promise<CopilotClientInstance>` with mutex pattern (same as `resumeInProgress`)
  - Add `async shutdown(): Promise<void>` that stops the shared client
  - Remove `client` from `ActiveSession` interface

### Step 2: Migrate create() to shared client

[ ] `src/session-manager.ts` `create()`:
  - Replace `new CopilotClient({ cwd })` + `client.start()` with `await this.ensureClient()`
  - Add `workingDirectory: cwd` to `createSession()` config
  - Store `{ cwd, session }` in activeSessions (no `client`)

### Step 3: Migrate _doResume() to shared client

[ ] `src/session-manager.ts` `_doResume()`:
  - Replace `new CopilotClient({ cwd })` + `client.start()` with `await this.ensureClient()`
  - Add `workingDirectory: cwd` to `resumeSession()` config
  - Store `{ cwd, session }` (no `client`)

### Step 4: Migrate stop() — session.destroy() only

[ ] `src/session-manager.ts` `stop()`:
  - Remove `client.stop()` call — shared client must stay alive
  - Keep `session.destroy()` call
  - Remove `client` destructuring from `active`

### Step 5: Migrate _fetchModels() and delete()

[ ] `src/session-manager.ts` `_fetchModels()`:
  - Use `await this.ensureClient()` instead of creating throwaway client
  - Remove `client.stop()` call

[ ] `src/session-manager.ts` `delete()`:
  - Use `await this.ensureClient()` instead of creating throwaway client
  - Remove `client.stop()` in finally block

### Step 6: Wire shutdown into server lifecycle

[ ] `server.ts` SIGINT handler:
  - After `sessionState.shutdown()` resolves, call `sessionManager.shutdown()`
  - This ensures all sessions are destroyed before the shared client stops

### Step 7: Test and verify

[ ] All existing tests pass
[ ] Typecheck clean
[ ] Manual test: create session, send message, get response
[ ] Manual test: create 2nd session, verify both work
[ ] Manual test: stop one session, verify other still works
[ ] Manual test: delete session, verify shared client alive
[ ] Manual test: server shutdown (Ctrl+C), verify clean exit

## ChatViewController (doc/chat-view.md)

### Step 1: Create ChatViewController class

[ ] Create `public/ts/chat-view-controller.ts` with:

```typescript
class ChatViewController {
  private viewState: 'sessions' | 'newChat' | 'chatting' = 'sessions';

  // --- View transitions ---
  showSessions(): void
    // setViewState('sessions'), loadSessions + loadUsage via showSessionManager
  
  showNewChat(): void
    // regions.chat.clear(), clearStatus(), clearContextFooter()
    // setViewState('newChat'), loadModels(), updateUrl(session=null)
  
  async activateSession(sessionId: string): Promise<void>
    // reconnectIfNeeded + waitForConnect
    // POST resume with fetchWithTimeout
    // setActiveSession, updateMenuIndicators, notifySessionChange
    // updateStatus(model, cwd)
    // historyLoader.load()
    // setViewState('chatting')
    // Error: toast + don't change view
  
  // --- Footer ---
  updateStatus(model: string, cwd: string): void
    // calls renderStatus(model, cwd)
  
  clearFooter(): void
    // calls clearStatus() + clearContextFooter()
  
  // --- CWD ---
  getCwd(): string
    // if viewState is 'newChat': getNewChatCwd()
    // else: getCurrentCwd() from app-state
  
  // --- Form ---
  setFormEnabled(enabled: boolean): void
    // delegates to view-controller setFormEnabled
  
  // --- Prompt recovery ---
  savePrompt(prompt: string, sessionId: string): void
  restorePromptIfSameSession(): void
    // only restore if active session matches saved sessionId

  getViewState(): 'sessions' | 'newChat' | 'chatting'
}

export const chatView = new ChatViewController();
```

Export singleton. Unit test `tests/unit/chat-view-controller.test.ts` covering:
- showNewChat clears footer + chat
- activateSession sets view to chatting on success, stays on error
- getCwd returns newChat CWD vs session CWD based on view state
- restorePromptIfSameSession only restores when session matches

### Step 2: Migrate router.ts to use chatView

[ ] `router.ts`:
  - Remove `activateSession()` function body — replace with `chatView.activateSession()`
  - Remove `newSessionClick()` body — replace with `chatView.showNewChat()`
  - Remove imports for: setActiveSession, getCurrentCwd, reconnectIfNeeded, waitForConnect, fetchWithTimeout, setSessionLoading, updateMenuIndicators, renderStatus, clearStatus, clearContextFooter, loadModels, notifySessionChange, historyLoader
  - Keep: sessionClick (delegates), toggleSessions (delegates to showSessions or restores), URL management, applet loading
  - `sessionClick` uses `chatView.getViewState()` and `historyLoader.isStale()` for short-circuit

### Step 3: Migrate message-streaming.ts to use chatView

[ ] `message-streaming.ts`:
  - Replace `setFormEnabled` calls with `chatView.setFormEnabled()`
  - Replace `renderStatus` calls with `chatView.updateStatus()`
  - Replace `lastSentPrompt/lastSentSessionId` with `chatView.savePrompt()` / `chatView.restorePromptIfSameSession()`
  - Remove imports for: view-controller (setFormEnabled), context-footer (renderStatus), multiline-input (resetTextareaHeight — keep this one, it's input-specific)
  - onReconnect handler: call `chatView.activateSession()` instead of `historyLoader.load()` directly
  - Import chatView instead of the 4 separate modules

### Step 4: Migrate multiline-input.ts to use chatView

[ ] `multiline-input.ts`:
  - Replace `isViewState('newChat') ? getNewChatCwd() : getCurrentCwd()` with `chatView.getCwd()`
  - Remove imports: isViewState from view-controller, getNewChatCwd from model-selector, getCurrentCwd from app-state
  - Import: chatView from chat-view-controller

### Step 5: Clean up view-controller.ts

[ ] `view-controller.ts`:
  - Remove the `clearContextFooter` call from `setViewState('newChat')` — chatView.showNewChat() handles it
  - `setViewState` becomes a pure DOM mutator (no side effects)
  - `setFormEnabled` stays as-is (low-level DOM helper called by chatView)

### Step 6: Test and verify

[ ] All existing tests pass
[ ] New unit tests pass
[ ] Typecheck clean
[ ] Lint clean (changed files)
[ ] Build client
[ ] Knip clean

## Applet Reactivity (doc/applet-reactivity.md)

### Step 1: Expose `onSessionEvent` to applets

[ ] `public/ts/applet-runtime.ts`:
  - Import `onEvent` from `websocket.js` and `isLoadingHistory` from `app-state.js`
  - Add `onSessionEvent` to the `AppletAPI` interface and the `window.appletAPI` object
  - Implementation: wraps `onEvent` but filters out events during history replay (`isLoadingHistory()` is true). Returns unsubscribe function.

### Step 2: Expose `onSessionChange` to applets

[ ] `public/ts/applet-runtime.ts`:
  - Add a module-level callback set `sessionChangeCallbacks`
  - Add `onSessionChange(cb: (sessionId: string, cwd: string) => void): () => void` to AppletAPI
  - Export `notifySessionChange(sessionId, cwd)` for `router.ts` to call
[ ] `public/ts/router.ts` `activateSession()`:
  - After `setActiveSession`, call `notifySessionChange(sessionId, cwd)`

### Step 3: Git-status auto-refresh on file changes

[ ] `applets/git-status/script.js`:
  - Subscribe to `onSessionEvent`. On `tool.execution_complete` for edit/create tools, schedule a throttled refresh (2s debounce). On `session.idle`, refresh immediately.
  - Subscribe to `onSessionChange`. Update the applet's CWD and refresh.

### Step 4: Git-status shows last commit when working tree clean

[ ] `applets/git-status/script.js`:
  - After `git status --porcelain=v2` returns empty, run `git log -1 --format=%H%n%s%n%an%n%ar`
  - Render a "clean tree" view with: short hash, message, author, relative time
  - Include a clickable link to `/?applet=git-diff&path=<cwd>&ref=HEAD~1..HEAD`

### Step 5: Git-diff ref range support

[ ] `applets/git-diff/script.js`:
  - Check `appletAPI.getAppletUrlParams()` for a `ref` parameter
  - If present, run `git diff <ref>` instead of the default staged/unstaged diff
  - Show a header indicating the ref range being viewed

## Chat View + Footer Collaboration Fixes

### Bugs to fix

**B1. Timeout restores message to wrong session**
`message-streaming.ts`: `lastSentPrompt` is global. The no-events watchdog restores it to the textarea without checking which session is active. If the user switched sessions during the 60s timeout, the old prompt appears in the new session's input.

**B2. Context footer files stale on session switch**
`router.ts newSessionClick()` calls `clearStatus()` but not `clearContextFooter()`. Old session's file links persist in the footer.

**B3. Pound (#) file reference uses wrong CWD in new-chat**
`multiline-input.ts`: Pound provider calls `getCurrentCwd()` which returns the *previous* session's directory. For new-chat view, it should use the CWD from the `#newChatCwd` input.

**B4. Footer should show model+cwd in new-chat view**
When user types a CWD in new-chat, the footer should update with that path (clickable to file-browser). Currently footer is empty until session is created.

### Implementation

[ ] **Fix B1: Scope lastSentPrompt to session**
  - `message-streaming.ts`: Store `lastSentSessionId` alongside `lastSentPrompt`
  - In watchdog timeout: check `lastSentSessionId === getActiveSessionId()` before restoring
  - If session changed, discard the stale prompt (just re-enable form, don't restore text)

[ ] **Fix B2: Clear context footer on new chat and session switch**
  - `router.ts newSessionClick()`: Add `clearContextFooter()` call alongside `clearStatus()`
  - `router.ts activateSession()`: `historyLoader.load()` already calls `clearContextFooter()` internally — verify this works

[ ] **Fix B3: Pound provider uses correct CWD**
  - `multiline-input.ts`: When pound triggers, check `isViewState('newChat')`. If true, read CWD from `getNewChatCwd()` (model-selector.ts) instead of `getCurrentCwd()`
  - Import `isViewState` from view-controller and `getNewChatCwd` from model-selector

[ ] **Fix B4: New-chat CWD updates footer**
  - `model-selector.ts`: Add a `debounced input` handler on `#newChatCwd` that calls `renderStatus(selectedModel, cwdValue)` on each change (debounce 300ms)
  - This gives the user a clickable cwd link in the footer while typing, and shows the selected model name

## Extract HistoryLoader class

### Problem

History loading is spread across 4 files with 3 call sites, a generation counter, pending/stale flags, and a server-side dedup Set. This caused a bug where double history requests left the UI empty. The root cause per `doc/code-quality.md`: wrong abstraction — no single owner of the history lifecycle.

### Current state (what to remove)

| File | State/Logic | Problem |
|------|-------------|---------|
| `history.ts` | `historyPending`, `lastHistoryConnectionId`, `historyGeneration`, `isHistoryPending()`, `isHistoryStale()`, `waitForHistoryComplete()` | 3 module-level flags, generation counter for dedup |
| `message-streaming.ts` | `reloadAfterReconnect()`, reconnect handler calls `requestHistory` | Second call site for history |
| `router.ts` | `activateSession()` calls `requestHistory` + `waitForHistoryComplete` | Third call site, uses `isHistoryStale()` for short-circuit |
| `websocket.ts` (server) | `pendingHistory` Set, dedup logic in `requestHistory` handler | Server-side bandaid for client-side double request |

### Design: `HistoryLoader` class

Single class that owns the full request→stream→complete lifecycle. One way to load history. Impossible to double-request.

```typescript
// public/ts/history-loader.ts

class HistoryLoader {
  private pending: PendingLoad | null = null;
  private lastLoadSessionId: string | null = null;
  private lastLoadConnectionId = -1;

  /**
   * Load history for a session. Cancels any in-flight request.
   * Clears chat, requests history via WS, waits for completion.
   * Sets tracker busy state and form state from server response.
   */
  async load(sessionId: string): Promise<void> {
    this.cancel();
    
    setLoadingHistory(true);
    regions.chat.clear();
    clearContextFooter();
    subscribeToSession(sessionId);
    requestHistory(sessionId);
    
    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        console.warn('[HISTORY] Timed out waiting for historyComplete');
        this.finish(resolve);
      }, TIMEOUT_MS);
      
      const unsub = onHistoryComplete((data) => {
        // Ignore completions for wrong session (stale WS message)
        if (this.pending?.sessionId !== sessionId) return;
        this.finish(resolve, data);
      });
      
      this.pending = { sessionId, resolve, timer, unsub };
    });
  }

  /**
   * Whether the last loaded history is stale (WS reconnected since).
   * Used by sessionClick to decide if short-circuit is safe.
   */
  isStale(sessionId: string): boolean {
    return this.lastLoadSessionId !== sessionId 
        || getConnectionId() !== this.lastLoadConnectionId;
  }

  private finish(resolve: () => void, data?: { isBusy?: boolean }): void {
    if (!this.pending) return;
    const { timer, unsub } = this.pending;
    clearTimeout(timer);
    unsub();
    
    this.lastLoadSessionId = this.pending.sessionId;
    this.lastLoadConnectionId = getConnectionId();
    this.pending = null;
    
    setLoadingHistory(false);
    
    const isBusy = data?.isBusy ?? false;
    const activeId = getActiveSessionId();
    if (activeId) sessionTracker.setBusy(activeId, isBusy);
    setFormEnabled(!isBusy);
    
    if (regions.chat.el.children.length === 0) loadModels();
    resolve();
  }

  private cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.unsub();
    this.pending.resolve();
    this.pending = null;
  }
}

export const historyLoader = new HistoryLoader();
```

### Implementation steps

[ ] **Step 1: Create `public/ts/history-loader.ts`**
  - Class as designed above
  - Imports: `setLoadingHistory` from app-state, `setFormEnabled` from view-controller, `onHistoryComplete`/`getConnectionId`/`subscribeToSession`/`requestHistory` from websocket, `clearContextFooter` from context-footer, `regions` from dom-regions, `sessionTracker` from session-state-tracker, `getActiveSessionId` from app-state, `loadModels` from model-selector
  - Export singleton `historyLoader`
  - Unit test: `tests/unit/history-loader.test.ts`

[ ] **Step 2: Replace callers**
  - `router.ts activateSession()`: Replace `requestHistory` + `waitForHistoryComplete` with `historyLoader.load(sessionId)`
  - `router.ts sessionClick()`: Replace `isHistoryStale()` with `historyLoader.isStale(sessionId)`
  - `message-streaming.ts reloadAfterReconnect()`: Replace with `historyLoader.load(sessionId)`
  - `message-streaming.ts onReconnect`: Replace `isHistoryPending()` + `requestHistory()` with just calling `historyLoader.load()` (which cancels in-flight)
  - `main.ts`: Replace `activateSession` call (which already uses historyLoader internally)

[ ] **Step 3: Delete old code**
  - `history.ts`: Remove `waitForHistoryComplete`, `isHistoryPending`, `isHistoryStale`, `historyGeneration`, `historyPending`, `lastHistoryConnectionId`. Keep `loadPreferences` (unrelated).
  - `websocket.ts` (server): Remove `pendingHistory` Set and dedup logic from requestHistory handler (no longer needed — client won't double-request)

[ ] **Step 4: Test and verify**
  - All existing tests pass
  - Typecheck clean
  - Lint clean
  - Build client
  - Manual test: click session → history loads. Click same session again → short-circuit (no reload). Click different session while first is loading → first cancelled, second loads.
