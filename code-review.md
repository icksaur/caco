# Code Review -- 2026-02-28

Reviewed against `doc/code-quality.md`. 14,600 lines of server/client TypeScript, 5,500 lines of tests.

---

## Summary

The codebase is well-structured for a personal tool of this scope. Directory layout reflects the architecture. Most files are under 300 lines with clear single purposes. The event-driven SDK integration is solid, and defensive error handling is consistent. The code-quality principles of "less is more" and "simple is best" are largely followed.

The main problems are: (1) the session lifecycle is a reliability hazard due to distributed mutable state with no transactional guarantees, (2) the two largest modules (`session-manager.ts`, `storage.ts`) have become multi-concern classes that resist testing, and (3) several performance traps exist in hot paths.

---

## Critical -- Reliability

These are the root causes behind the reported flakiness in session resume/switch/start.

### R1. Session activation is a non-atomic multi-step sequence with no rollback

**Files:** `public/ts/router.ts:269-326`, `public/ts/main.ts:125-137`

When activating a session, the frontend executes 6 ordered steps across 4 modules:

```
setSessionLoading(true)        // session-panel
regions.chat.clear()           // dom-regions
POST /sessions/:id/resume      // fetch
setActiveSession(id, cwd)      // app-state
subscribeToSession(id)         // websocket
requestHistory(id)             // websocket
waitForHistoryComplete()       // history
setViewState('chatting')       // view-controller
```

If any middle step fails (resume 500, WS dropped between subscribe and history), the UI is left in an inconsistent state: chat cleared but no history loaded, or subscribed to wrong session, or form permanently disabled. The `catch` block in `activateSession()` only clears the loading spinner and shows a toast -- it does not undo `regions.chat.clear()`, so the user sees an empty chat with no way to recover except page reload.

**Suggestion:** Extract this into an explicit state machine with defined states (`idle`, `loading`, `active`, `error`) and rollback transitions. At minimum, gate the `regions.chat.clear()` call until after the resume POST succeeds.

### R2. `waitForHistoryComplete()` has no timeout

**File:** `public/ts/history.ts:22-47`

This returns a Promise that resolves when the server sends `historyComplete` via WebSocket. If the WS connection drops during history streaming, or the server errors silently, the Promise never resolves. The `await waitForHistoryComplete()` in `activateSession()` hangs indefinitely, leaving the form disabled and the UI stuck.

**Suggestion:** Add a timeout (e.g., 15 seconds) that rejects the promise and triggers recovery (re-enable form, show error toast).

### R3. WebSocket reconnect does not resend pending `requestHistory`

**File:** `public/ts/websocket.ts:136-142`

On reconnect, the client re-subscribes to the active session but does not re-request history. If the WS dropped during history streaming, the `historyComplete` event is lost forever (see R2). Combined with the lack of timeout, this creates a permanent hang.

**Suggestion:** Track whether a history request is in-flight. On reconnect, if one was pending, re-issue it.

### R4. Server-side resume can leave orphaned SDK clients

**File:** `src/session-manager.ts:323-325`, `src/session-state.ts:271-272`

`switchSession()` calls `sessionManager.resume()` which creates a new `CopilotClient` and calls `client.start()`. If the previous session was also active (never explicitly stopped), the old `CopilotClient` instance remains in `activeSessions` with its underlying connection open. Sessions are never stopped when switching -- the comment says "it may still be running." Over time this leaks SDK client handles.

The `list()` method also does sync file I/O on every call (`readFileSync` of `workspace.yaml` for each session), so the cost of having many cached sessions compounds.

**Suggestion:** Consider a bounded LRU for active SDK sessions. When the count exceeds a threshold (e.g., 5), stop the least-recently-used inactive session.

### R5. Race condition in `POST /sessions/:id/messages` resume path

**File:** `src/routes/session-messages.ts:120-131`

The route handler checks `isActive()`, then `resume()`s if not active. But `isBusy()` was already checked earlier (line 77). Between the busy check and the resume, another request could arrive and also attempt to resume the same session simultaneously. Since `resume()` is async and there's no lock, two callers could both create `CopilotClient` instances for the same session -- the second would overwrite the first in `activeSessions`, leaking the first client.

**Suggestion:** Use a per-session mutex or "resuming" state flag to serialize concurrent resume attempts.

### R6. Dispatch cleanup has a duplicate path

**File:** `src/routes/session-messages.ts:222-254 vs 344-354`

The `cleanupAndComplete` function and the outer `catch` block both call `sessionManager.endDispatch()`, `broadcastGlobalEvent`, and `dispatchComplete()`. If the inner try/catch throws after `cleanupAndComplete` already ran (e.g., `unsubscribe()` throws), the outer catch will call `endDispatch` again. `endDispatch` is idempotent (Map delete), but `dispatchComplete()` decrements a counter -- calling it twice could go negative and break the restart-manager's idle detection.

**Suggestion:** Guard the outer catch with the same `dispatchCompleted` flag, or restructure to ensure only one cleanup path runs.

---

## Significant -- Maintainability

### M1. `SessionManager` is a multi-concern class (733 lines)

**File:** `src/session-manager.ts`

This class handles:
- SDK client lifecycle (create, resume, stop, delete)
- Model caching (fetch, parse, sync)
- Session discovery (disk scanning, cache)
- Correlation tracking (agent runaway guard)
- Dispatch state delegation
- History retrieval (active via SDK, inactive via disk)
- Session listing and grouping

By the code-quality doc, "classes have one purpose (SRP)." The correlation tracking (lines 690-728) and session listing/grouping (lines 510-586) are separable concerns. The disk-based history reading (lines 451-478) and discovery (lines 215-239) couple this class to the file system layout of `~/.copilot/`, making it hard to test without a real filesystem.

**Suggestion:** Extract `SessionDiscovery` (disk scanning + cache), `SessionLister` (list/group/filter), and keep `SessionManager` focused on SDK lifecycle.

### M2. `storage.ts` has three unrelated responsibilities (664 lines)

**File:** `src/storage.ts`

This file manages:
1. Session metadata (meta.json CRUD + intent + observed tracking)
2. Display output storage (store/get/list/prune with cache)
3. MCP OAuth state (separate JSON file)

These have no shared state and different lifecycles. The `getOutput()` function (lines 306-358) iterates over all session directories to find an output by ID -- a linear scan that gets slower as sessions accumulate.

**Suggestion:** Split into `session-meta.ts`, `output-store.ts`, and `mcp-auth-store.ts`. For output lookup, maintain a reverse index (outputId -> sessionId).

### M3. No tests for the two most critical modules

**Files:** No `session-manager.test.ts`, no `session-state.test.ts`

`SessionManager` (733 lines) and `SessionState` (371 lines) are the core of the application and the source of the reported reliability issues. Neither has any unit tests. These are the classes where a bug has the highest blast radius.

The test suite covers 33 files, but the test-to-source ratio reveals the gap: the pure utility modules have excellent coverage (chain-stack, rate-aggregator, event-filter), while the stateful orchestration modules have none.

**Suggestion:** These are testable if the `CopilotClient` dependency is injected rather than constructed inline. Create a `ClientFactory` interface and inject it, then test resume/switch/create flows with a mock.

### M4. `routes/api.ts` is a grab-bag (478 lines)

**File:** `src/routes/api.ts`

This single route file handles models, usage, temp files, preferences, outputs, applets, file system access, and debug endpoints. It's the third-largest file and has no unifying concern.

**Suggestion:** The file system endpoints (`GET /files`, `PUT /files`, `GET /file`) could be a separate `file-routes.ts`.

### M5. Duplicate type definitions across modules

**Files:** `src/types.ts`, `src/session-manager.ts`, `src/routes/websocket.ts`, `public/ts/types.ts`

`SessionEvent` is defined independently in three places with slightly different shapes. The server-side `SessionEvent` in `session-manager.ts` (line 62-67) uses `Record<string, unknown>` for data, while `websocket.ts` (line 56-60) adds a catch-all index signature. The frontend `types.ts` has its own version.

The `SessionManager` also re-defines `CopilotClientInstance`, `CopilotSessionInstance`, `SendOptions` (lines 14-67) rather than importing from SDK types. This is acknowledged as intentional (the SDK types may not be exported), but it means the app silently breaks if the SDK changes method signatures.

**Suggestion:** Define canonical types once in `types.ts` and import everywhere. For the SDK types, add a thin adapter that validates the interface at startup.

### M6. Mutable global singletons throughout

The code-quality doc lists "global state" and "mutable objects" as bad patterns. The codebase has at least 9 module-level mutable singletons:

| Module | Mutable State |
|--------|--------------|
| `session-manager.ts` | `sessionManager` singleton with Maps |
| `session-state.ts` | `sessionState` singleton with Maps |
| `dispatch-state.ts` | `dispatchState` singleton with Map |
| `storage.ts` | `outputCache` Map, `cwdToSessionId` Map |
| `applet-state.ts` | module-level objects |
| `unobserved-tracker.ts` | singleton with Set |
| `usage-state.ts` | module-level state |
| `restart-manager.ts` | module-level counters |
| `caco-event-queue.ts` | module-level Map |

These interact through import-time coupling, making it difficult to reason about state transitions across the system. The `dispatchMessage()` function in `session-messages.ts` touches 7 of these singletons during a single message dispatch.

This is the architectural root cause behind the session reliability issues. State changes in one singleton are not coordinated with others -- there's no transaction boundary.

**Suggestion:** Not advocating for a rewrite, but consider a `SessionContext` object that bundles the per-session state currently spread across `dispatchState`, `CacoEventQueue`, `unobservedTracker`, and `activeSessions`. Pass it through the dispatch flow rather than looking it up globally.

---

## Moderate -- Performance

### P1. `getOutput()` linear scans all session directories

**File:** `src/storage.ts:306-358`

When an output is not in the memory cache, `getOutput()` iterates every session directory looking for the matching output ID. With many sessions, this becomes an O(sessions) disk scan. Each iteration calls `existsSync()` and potentially `readdirSync()`.

**Suggestion:** Store outputs in a flat directory (`~/.caco/outputs/`) or maintain a simple `outputId -> sessionId` index file.

### P2. `list()` does synchronous I/O per session

**File:** `src/session-manager.ts:510-531`

`list()` calls `readFileSync` on `workspace.yaml` and `getSessionMeta()` (which reads `meta.json`) for every session in the cache. This is called on every `GET /sessions` request. With 50+ sessions, this creates noticeable latency.

`getMostRecentForCwd()` (lines 568-586) is even worse -- it calls `list()` to get all sessions, then filters, then reads `workspace.yaml` again for each matching session.

**Suggestion:** Cache `updatedAt` in the session cache and invalidate it on resume/idle. The `SessionMeta` reads could be cached with a short TTL.

### P3. `_discoverSessions()` reads every events.jsonl at startup

**File:** `src/session-manager.ts:215-239`

On server start, this reads the first line of every `events.jsonl` file in `~/.copilot/session-state/`. A user with 100+ sessions incurs 100+ synchronous file reads during startup. Additionally, each `readFileSync` reads the entire file content, then splits by newline and takes only the first line.

**Suggestion:** Use `createReadStream` with a line reader to stop after the first line, or cache discovered CWDs in `~/.caco/session-index.json` and only re-scan on cache miss.

### P4. `readFileSync` of `index.html` on every `GET /` request

**File:** `server.ts:109-116`

The root route reads `index.html` from disk on every request, parses it to inject the hostname script tag, and sends the result. For a development tool this is fine, but it's trivially cacheable since the hostname doesn't change.

**Suggestion:** Read and transform once at startup, serve from memory.

### P5. Frontend `scrollToBottom()` called after every event

**File:** `public/ts/message-streaming.ts:98`

During a streaming response, `scrollToBottom()` is called on every single event (deltas, tool calls, etc.). Combined with the markdown re-rendering in `streaming-markdown.ts`, this can cause layout thrashing on large responses.

**Suggestion:** Throttle `scrollToBottom()` to at most once per animation frame (use `requestAnimationFrame` deduplication).

---

## Minor -- Code Quality

### Q1. `as unknown as` casts to work around SDK types

**Files:** `src/session-manager.ts:192,254,324`, `src/routes/session-messages.ts:254,366`

The pattern `new CopilotClient({ cwd }) as unknown as CopilotClientInstance` appears 4 times. The `.on()` subscription and `.abort()` call also use double casts. This bypasses the type system entirely.

**Suggestion:** Create a typed wrapper (`SDKClient`) that encapsulates these casts in one place. If the SDK changes, you fix one file instead of hunting for `as unknown as`.

### Q2. `console.log` used throughout for structured logging

**File:** `src/logger.ts` exists with 7 pre-created loggers, but most of the codebase still uses `console.log` directly (session-manager, session-state, server.ts, all routes). The logger module is underutilized.

**Suggestion:** Migrate to the existing logger infrastructure. It provides tag-based filtering that would help debug the session issues.

### Q3. `pruneOutputs()` counts but doesn't delete

**File:** `src/storage.ts:442-467`

The comment says "Would delete here - for now just count." This function returns a count but never actually deletes anything. Dead code that gives a false sense of cleanup.

**Suggestion:** Either implement the deletion or remove the function.

### Q4. `wsSendMessage()` is dead code

**File:** `public/ts/websocket.ts:383-391`

This function sends a `sendMessage` type via WebSocket, but the server handler for `sendMessage` (websocket.ts line 135) responds with an error telling clients to use POST instead. The function is exported but never called.

**Suggestion:** Remove it. `knip` should catch this if configured to check exports.

### Q5. Inconsistent error response shapes

**Files:** `src/routes/sessions.ts`, `src/routes/session-messages.ts`, `src/routes/api.ts`

Some endpoints return `{ error: string }`, others return `{ error: string, code: string }`, others use the `apiError` helper from `api-error.ts`. The frontend `catch` blocks handle both shapes but inconsistently.

**Suggestion:** Use `apiError` helpers consistently across all routes.

### Q6. CSP allows `unsafe-eval` and `unsafe-inline`

**File:** `server.ts:91-99`

The Content Security Policy includes `'unsafe-eval'` (for applet JS execution) and `'unsafe-inline'` (for scripts/styles). The comment explains the `unsafe-eval` is intentional for applets, but `unsafe-inline` for styles could potentially be replaced with nonces or hashes for the known inline styles.

This is acceptable for a personal tool, but worth documenting as a known trade-off.

### Q7. Two unrelated concerns in `prompts.ts`

**File:** `src/prompts.ts` (323 lines)

This file handles system message construction, resume context building, AND message source prefix parsing/formatting. The source prefix parsing (`parseMessageSource`, `prefixMessageSource`) is a serialization concern unrelated to prompt building.

**Suggestion:** Extract `message-source.ts` for the prefix parsing (tests already exist in `message-source.test.ts`, so the separation is natural).

### Q8. Frontend window globals for onclick handlers

**File:** `public/ts/main.ts:39-49`

Ten functions are assigned to `window` for use in HTML `onclick` attributes. This couples the HTML to global function names and prevents tree-shaking.

**Suggestion:** Replace with `addEventListener` calls during initialization.

---

## What's Done Well

- **Separation of SDK event handling:** The normalizer/transformer/filter chain (`sdk-normalizer.ts`, `event-transformer.ts`, `event-filter.ts`) cleanly isolates SDK format inconsistencies. The normalizer is the single point that handles live-vs-history format differences -- this is good architecture.

- **Tool factory pattern:** Tools are created via factory with scoped closures rather than accessing global state. The `SessionIdRef` pattern (mutable ref updated after session creation) solves the chicken-and-egg problem cleanly.

- **Agent runaway prevention:** The `CorrelationMetrics` / `RunawayRulesEngine` / `ChainStack` system is well-designed and thoroughly tested. Three orthogonal rules (depth, age, rate) compose cleanly.

- **WebSocket connection ID pattern:** The `connectionId` counter that stale callbacks check against (websocket.ts client) is a clean solution to the stale-closure reconnection problem.

- **History replay parity:** The embed queue flush logic in history replay mirrors the live streaming path, ensuring consistent rendering. This is the kind of code-that-must-be-kept-in-sync that the code-quality doc warns about, but here it's managed through shared primitives (`CacoEventQueue`, `isFlushTrigger`).

- **Test coverage of pure modules:** Files like `chain-stack.ts`, `rate-aggregator.ts`, `event-filter.ts`, `sdk-normalizer.ts`, `dispatch-state.ts` have excellent test coverage proportional to their complexity.

- **Shell execution security:** `shell.ts` uses `execFile` with args array (no shell interpretation), strips ANSI codes, enforces timeouts, and validates inputs. This is correct by design.

---

## Priority Order

If addressing these in order of impact:

1. **R2** -- Add timeout to `waitForHistoryComplete()` (5 min fix, prevents permanent hang)
2. **R1** -- Don't clear chat until resume succeeds (10 min fix, prevents empty-screen state)
3. **R5** -- Add per-session resume lock (30 min fix, prevents leaked clients)
4. **R6** -- Guard outer catch with `dispatchCompleted` flag (5 min fix, prevents counter underflow)
5. **M3** -- Add tests for `SessionManager` and `SessionState` (sustained effort, highest long-term value)
6. **P2/P3** -- Cache session metadata and discovery results (reduces latency for session list)
7. **R3** -- Re-request history on reconnect if pending (15 min fix, prevents stale UI)
8. **R4** -- Bound active SDK sessions (30 min, prevents resource leak)
