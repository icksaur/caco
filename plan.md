# plan

This document must only contain the next actions, no cut or deferred work.
The items in this plan must be actionable by another agent without guesswork.
When all items are complete, remove all items.

legend:

[ ] incomplete
[*] complete
[>] in progress

---

## Code Quality Cleanup

### Step 1: Eliminate duplicate code paths

[ ] Consolidate applet loading — `router.ts:loadApplet` and `applet-runtime.ts:loadAppletBySlug`:
  - Make `loadApplet(slug)` in router.ts accept optional `urlParams`
  - Delete `loadAppletBySlug` in applet-runtime.ts
  - Have `loadAppletFromUrl` call `loadApplet` from router.ts via import

[ ] Extract session sort comparator — duplicated in `session-panel.ts:352-364` and `command-registry.ts:50-57`:
  - Create `sortSessions(sessions: SessionData[]): SessionData[]` in `ui-utils.ts`
  - Call from both session-panel and command-registry

[ ] Extract session action buttons — duplicated in `session-panel.ts` `createSessionItem` and `updateSessionItemState`:
  - Create `appendActionButtons(item, sessionId, displayName)` helper
  - Call from both paths

[ ] Consolidate model fetching — `api.ts` GET /models has its own cache, `SessionManager` has `_fetchModels`:
  - Delete the route's `cachedModels`/`modelsCacheTime` and `CopilotClient` instance
  - Route calls `sessionManager.getModels()` directly

[ ] Consolidate MIME maps — `api.ts` has two (L119 extMap, L392 mimeTypes):
  - Create one bidirectional `MIME_MAP` in config.ts
  - Derive both directions from it

### Step 2: Remove side effects from state setters

[ ] `app-state.ts` `setSelectedModel` — remove DOM hidden input sync:
  - Delete the `document.getElementById('selectedModel')` update
  - In `message-streaming.ts:291` submit handler, call `getSelectedModel()` instead of reading DOM
  - Remove the hidden input from index.html if no other code uses it

[ ] `applet-runtime.ts:294` `setAppletState` — remove CWD side effect:
  - Remove `setNewChatCwd(state.currentPath)` call from setAppletState
  - Have model-selector's CWD input subscribe to onSessionChange or read from app-state directly

[ ] Move CWD functions out of model-selector.ts:
  - Move `getNewChatCwd`/`setNewChatCwd` to app-state.ts
  - Update all importers (chat-view-controller, message-streaming, applet-runtime)

### Step 3: Fix global state scoping

[ ] `src/applet-state.ts` — key state by sessionId:
  - Change `appletUserState`/`appletNavigation`/`activeSlug`/`pendingReload` to `Map<sessionId, ...>`
  - Route handlers pass sessionId to get/set functions

[ ] `src/swarm-tool.ts:18` — key swarm lock by sessionId:
  - Change `let swarmActive` to `Set<string>` of active session IDs
  - Guard checks `swarmActive.has(sessionRef.id)` instead of global boolean

### Step 4: Consolidate SDK disk access

[ ] Create `src/sdk-session-store.ts`:
  - `readSessionUpdatedAt(sessionId)` — reads workspace.yaml
  - `readSessionEvents(sessionId)` — reads events.jsonl
  - `parseSessionModel(sessionId)` — reads model from events
  - Single import for the `~/.copilot/session-state/` path prefix

[ ] Update `session-manager.ts`:
  - `parseModelFromSDK` → calls `sdkStore.parseSessionModel`
  - `_discoverSessions` → calls `sdkStore.readSessionUpdatedAt`
  - `getHistoryFromDisk` → calls `sdkStore.readSessionEvents`
  - `list()` → calls `sdkStore.readSessionUpdatedAt`

### Step 5: Fix construction patterns

[ ] `src/unobserved-tracker.ts` — constructor injection:
  - Pass broadcast callback as constructor parameter
  - Remove `setBroadcast()` method
  - Update server.ts to pass the broadcast function at construction

[ ] `src/applet-push.ts` — constructor injection:
  - Export a factory `createAppletPush(broadcastFn)` instead of module-level nullable
  - Update server.ts to call factory after WebSocket is set up

[ ] `src/session-state.ts` — factory pattern:
  - Replace `new SessionState()` + `init(config)` with `createSessionState(config): Promise<SessionState>`
  - Update server.ts to await the factory

### Step 6: Build, test, verify

[ ] All existing tests pass
[ ] Typecheck clean
[ ] Build client
[ ] Run full test suite — no regressions
