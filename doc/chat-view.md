# Chat View Architecture

**Status: Proposed**

## Problem

The chat view is implemented across 7 modules (1,602 lines) that interact via side effects and long call chains. Per `doc/code-quality.md`:

**"coupling — source of complexity!"** — 12 cross-module calls connect these modules in a web where any change can break something unexpected.

**"relying on side effects"** — `setFormEnabled`, `clearContextFooter`, `renderStatus`, `loadModels` are called from 3-4 different modules each. The caller doesn't know what other modules will react.

**"only one way to do one thing"** — Footer is cleared in 3 places (`view-controller setViewState('newChat')`, `router newSessionClick`, `history-loader load()`). Form state is set from 4 places. `renderStatus` is called from 3 places with different parameter sources.

**"code must be kept in sync"** — Adding a new view transition requires updating multiple modules. Bugs emerge because one module forgets to call a function that another module expects.

## Current Architecture

```
router.ts ──→ view-controller.ts ──→ DOM (panels, form classes)
    │              │
    │              └──→ context-footer.ts ──→ DOM (footer)
    │
    ├──→ history-loader.ts ──→ view-controller (setFormEnabled)
    │         │                context-footer (clearContextFooter)
    │         │                model-selector (loadModels)
    │         │                session-state-tracker (setBusy)
    │
    ├──→ context-footer.ts ──→ DOM (footer)
    │
    └──→ model-selector.ts ──→ context-footer (renderStatus)

message-streaming.ts ──→ view-controller (setFormEnabled)
         │                context-footer (renderStatus, handleContextEvent)
         │                multiline-input (resetTextareaHeight)
         │                history-loader (load on reconnect)

multiline-input.ts ──→ view-controller (isViewState)
                       model-selector (getNewChatCwd)
```

Every arrow is a function call that assumes specific preconditions. When they're wrong, we get the bugs we've been fixing.

## Proposed: ChatViewController

A single class that owns the chat view lifecycle. All state transitions go through it. Modules that need to affect the view call one API instead of reaching into 4 modules.

```typescript
class ChatViewController {
  // --- State ---
  private viewState: 'sessions' | 'newChat' | 'chatting';
  private formEnabled: boolean;
  
  // --- Composed owners ---
  private historyLoader: HistoryLoader;   // already exists
  private sessionTracker: SessionStateTracker;  // already exists
  
  // --- View transitions ---
  showSessions(): void
  showNewChat(): void
  async activateSession(sessionId: string): Promise<void>
  
  // --- Form state ---
  setFormEnabled(enabled: boolean): void
  
  // --- Footer ---
  updateStatus(model: string, cwd: string): void
  clearFooter(): void
  
  // --- Input ---
  getCwd(): string  // returns newChat CWD or active session CWD
  restorePrompt(prompt: string, sessionId: string): void
}
```

### What this consolidates

| Current (scattered) | Proposed (one method) |
|---------------------|----------------------|
| `setViewState('newChat')` + `clearStatus()` + `clearContextFooter()` + `loadModels()` + `updateUrl()` | `chatView.showNewChat()` |
| `setActiveSession()` + `notifySessionChange()` + `updateMenuIndicators()` + `updateStatusBar()` + `historyLoader.load()` + `setViewState('chatting')` | `chatView.activateSession(id)` |
| `setFormEnabled()` from 4 callers | `chatView.setFormEnabled()` — one entry point |
| `isViewState('newChat') ? getNewChatCwd() : getCurrentCwd()` in multiline-input | `chatView.getCwd()` |
| `lastSentPrompt` + `lastSentSessionId` + timeout restore logic | `chatView.restorePrompt(prompt, sessionId)` |

### What stays the same

- `dom-regions.ts` — still owns scoped DOM access for chat content
- `ChatRegion` — still owns event rendering into the chat area
- `SessionStateTracker` — still owns busy/unobserved state
- `HistoryLoader` — still owns the history request lifecycle
- `handleEvent` in message-streaming — still routes SDK events to ChatRegion
- `streamResponse` — still handles the POST + new session creation flow

### Layering

```
┌─────────────────────────────────────────────┐
│  router.ts                                   │
│  (URL + navigation — calls chatView)         │
├─────────────────────────────────────────────┤
│  ChatViewController                          │
│  (view transitions, form state, footer)      │
│  Owns: viewState, formEnabled, footer        │
│  Composes: historyLoader, sessionTracker     │
├─────────────────────────────────────────────┤
│  message-streaming.ts                        │
│  (SDK event routing, stream lifecycle)       │
│  Calls: chatView.setFormEnabled()            │
├─────────────────────────────────────────────┤
│  dom-regions.ts + ChatRegion                 │
│  (DOM rendering — no state)                  │
└─────────────────────────────────────────────┘
```

### Benefits

1. **One way to do one thing.** All view transitions go through ChatViewController methods. No more 6-step sequences spread across 4 modules.

2. **Testable.** The class can be unit tested with mock DOM. Test: "activateSession sets form enabled based on isBusy, calls historyLoader.load, sets viewState to chatting."

3. **Fewer regressions.** New features (like the newChat CWD footer sync) are added to one class, not wired across 4 modules.

4. **getCwd() is correct by design.** Instead of every caller checking `isViewState('newChat')`, the controller knows which CWD source to use.

### What this does NOT do

- Does not merge modules — `view-controller.ts`, `context-footer.ts`, `model-selector.ts` continue to exist as low-level DOM helpers
- Does not change the event rendering pipeline (ChatRegion + dom-regions)
- Does not change the WebSocket or history loader internals
- Does not add new UI — just reorganizes who calls what

## Migration path

1. Create `ChatViewController` class with the consolidated API
2. Move `activateSession` from `router.ts` into the class
3. Move `newSessionClick` logic into `showNewChat()`
4. Replace scattered `setFormEnabled` / `clearFooter` / `renderStatus` calls with class methods
5. Have `router.ts` call `chatView.showNewChat()` / `chatView.activateSession()` instead of the current call chains
6. Move `getCwd()` logic from multiline-input into the class
7. Move prompt restore logic from message-streaming into the class

Each step is independently shippable and testable.

## Key files

| File | Role after migration |
|------|---------------------|
| `public/ts/chat-view-controller.ts` | NEW — owns view lifecycle |
| `public/ts/router.ts` | Calls chatView methods, owns URL/navigation only |
| `public/ts/message-streaming.ts` | SDK event routing, calls chatView.setFormEnabled |
| `public/ts/view-controller.ts` | Low-level DOM panel visibility (called by chatView) |
| `public/ts/context-footer.ts` | Low-level DOM footer rendering (called by chatView) |
| `public/ts/model-selector.ts` | Model list rendering (called by chatView.showNewChat) |
| `public/ts/history-loader.ts` | History lifecycle (composed by chatView) |
| `public/ts/multiline-input.ts` | Input handling, calls chatView.getCwd() |
