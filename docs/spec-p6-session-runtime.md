# P6 — Session runtime ownership / cwd identity

Branch: `code-review-brutal-2026-06`. Source: `code-review-backend.md`
(Critical: `ensureClientHealthy` global drop; High: output-store cwd identity,
caco-event-queue leak; Medium: eviction order, watchExtensions leak, retry
partial cleanup). Carry-forward: P1 `updatePreferences` outside the mutex; P2
deferred `restartSharedClient` + attachment scope.

## Goals

Give every active session **one owner** for its per-session runtime state, and
make **sessionId** — never cwd — the identity used to route tool output. Today
the same bug family the user reports (flaky resume/switch, multi-session-same-repo
corruption, stale duplicate events) comes from per-session state scattered across
modules with no single dispose path, plus cwd masquerading as a session key.

## Problems (current state)

1. **cwd is a fake session key.** `output-store.ts` keeps `Map<cwd, sessionId>`
   (`registerSession`/`unregisterSession`/`getSessionIdForCwd`). The user runs
   multiple sessions in the same repo; the second `registerSession(cwd, id)`
   overwrites the first, and `stop()`/`changeCwd()` call `unregisterSession(cwd)`
   which deletes the binding for *all* siblings in that cwd. Tool output then
   lands in the wrong session or falls back to the in-memory cache.

2. **CacoEventQueue leaks.** `sessionQueues: Map<sessionId, CacoEventQueue>` grows
   lazily via `getQueue()`; `deleteQueue()` has no external caller. Deleted /
   archived / evicted sessions keep pending synthetic embed events forever.

3. **`ensureClientHealthy()` is a silent global drop.** On a failed ping it sets
   `sharedClient = null` and `activeSessions.clear()` (also in `resetIdleTimer`,
   `proactiveHealthCheck` ×2). It clears the SDK client + active map but nothing
   else — dispatch state, queues, output bindings, throughput/model/usage caches,
   `SessionState` active ids all survive as orphans. One session's health check
   can invalidate every other session with no boundary event.

4. **Eviction uses Map insertion order as "oldest" and fire-and-forgets `stop()`.**
   Insertion order is not recency; a freshly-resumed session can evict a session
   the user just touched. `stop(id).catch(...)` is not awaited, so `resume()`
   returns while the evicted session's `unregisterSession(cwd)` runs later and
   stomps the cwd binding the new session just created.

5. **`watchExtensions()` leaks fd watchers.** It pushes `fs.watch` handles into a
   local array and returns nothing; `routes/websocket.ts` calls it on every `wss`
   wiring and clears only the heartbeat on close. Repeated setup leaks descriptors.

6. **Retry drop is partial.** `dispatch-retry.ts` + `dropStaleSession()` remove the
   active session but leave queue, output binding, and throughput state behind.

7. **`updatePreferences` mutates `_preferences` outside `runTransition`** (P1
   carry-forward) — a read-modify-write race against concurrent transitions.

## Design

### One owner: `SessionRuntime`

Introduce `src/session-runtime.ts`: a registry of per-session runtime objects.

```ts
interface SessionRuntime {
  readonly sessionId: string;
  readonly queue: CacoEventQueue;
  dispose(): void;            // idempotent
}
```

A module-level `Map<sessionId, SessionRuntime>` is the single home for
per-session *runtime* (not persisted) state that is tied to an **active** SDK
session's lifetime. `getRuntime(sessionId)` lazily creates;
`disposeRuntime(sessionId)` removes the entry and runs disposal: delete the
CacoEventQueue and call the live-session cache clears (`clearThroughputSession`,
plus a `usageCache` clear seam — see below) through one path. `dispose()` is
idempotent (guarded by a disposed flag) so double-disposal (stop racing
eviction racing restart) is safe.

What the runtime owns is deliberately narrow:
- **CacoEventQueue** (live-streaming producer/consumer) — see history caveat below.
- The live-session in-memory caches: throughput (`clearThroughputSession`) and
  `usageCache` (needs an exported clear seam in `routes/websocket.ts`).

What it does **not** own (corrections from review):
- There is **no per-session model cache**. `syncModelCache` writes persisted
  session meta; `cachedModels` is a global model list. Nothing to clear here.
- Persisted disk state (meta.json, events.jsonl, roadmap, notes, applet-state,
  surface docs) survives stop — addressed by their own stores, not P6.
- **Durable per-session module state that must outlive stop but be cleaned on
  delete/archive** (git-edit-poller watchers `src/git-edit-poller.ts:381-386,
  594-600`; pending file-edit writes `src/file-edits-store.ts:111-126`) is cleaned
  via the **existing `SessionState.onSessionEnd` seam** (`src/session-state.ts:249-265`,
  fired from `deleteSessionLocked`), not via `SessionRuntime`. P6 only needs to
  confirm/add their `onSessionEnd` registration; they are not active-session
  runtime.

Disposal of the runtime is triggered from every active-session exit path through
`SessionManager`: `stop()`, `dropStaleSession()`, eviction, and the new
`restartSharedClient()`. `delete`/`archive` go through `stop()` first, then
`onSessionEnd` handles durable cleanup. The retry drop routes through
`dropStaleSession()` so it inherits full runtime disposal.

### sessionId output identity (removes the cwd map)

`storeOutput` takes the session identity by **reference**, not cwd. The
`SessionIdRef` ( `{ id: string }` ) is already threaded into every tool via
`ToolFactory(cwd, sessionRef)` and is mutated to the real id immediately after
`createSession` / at resume. Because tools read the ref at *call* time (after
`sessionRef.id` is populated), passing the ref is correct and eliminates the cwd
lookup entirely.

Changes:
- `output-store.ts`: delete `cwdToSessionId`, `registerSession`,
  `unregisterSession`, `getSessionIdForCwd`. `storeOutput(sessionId, data, meta)`
  takes a sessionId string; metadata gains `sessionId` **and keeps `sessionCwd`**
  (informational + legacy authorization). A shared `requireSessionId(ref)` guard
  (throws on empty/`'PENDING'`) is used by every runtime-id consumer, not just
  `storeOutput`.
- `server.ts` toolFactory: `storeOutput(requireSessionId(sessionRef), …)` closure.
  Also fix the embed-queue producer (`server.ts:224-229`), which currently treats
  `'PENDING'` as truthy and would queue under a placeholder id — gate it on the
  same guard.
- `observe/hook.ts`: `createObservationHook(sessionRef)` → `storeOutput(sessionRef.id, …)`.
  Wire the ref through `createSession`/resume `hooks.onPostToolUse` (the ref is in
  `_doCreate`/`_doResume` scope at the call site).
- `observe/retrieve-tool.ts`: `createRetrieveOutputTool(sessionCwd, sessionRef)`.
  **Authorize by `sessionId` when the stored metadata has it; fall back to the
  legacy `sessionCwd` check for pre-P6 outputs that lack `sessionId`.** This keeps
  existing on-disk outputs retrievable.
- `workflow/tool.ts`: `createWorkflowTool(sessionCwd, sessionRef)` — keep cwd for
  `runWorkflow`, use `sessionRef.id` for `storeOutput` and drop `getSessionIdForCwd`.
- `session-manager.ts`: remove all `registerSession`/`unregisterSession` calls
  (create 593, resume 783, stop 840, changeCwd 862, fork 1552).
- `storage.ts`: drop the `registerSession`/`unregisterSession` re-exports.

`changeCwd` no longer needs to re-register output; the binding is the live
session, not the cwd. This deletes a whole class of cwd-rebind bugs.

### `restartSharedClient()` transaction

Replace the inline `sharedClient = null; activeSessions.clear()` sites — in
`ensureClientHealthy`, `resetIdleTimer`, `proactiveHealthCheck` (×2), **and
`handleClientError` (`src/session-manager.ts:309-317`)** — with a single private
`restartSharedClient(reason)` that:
1. captures the affected sessionIds (`[...activeSessions.keys()]`),
2. force-stops the client and nulls it + stops the health check,
3. for each affected id: `dispatchState.end(id)`, `disposeRuntime(id)`, delete
   from `activeSessions`,
4. broadcasts a boundary event per affected session (busy=false / "session
   reset, please retry") so the FE doesn't sit on a dead dispatch,
5. eagerly re-establishes the client (`ensureClient`).

`ensureClientHealthy`, `resetIdleTimer`, `proactiveHealthCheck`, and
`handleClientError` call this instead of clearing inline. The method name states
the destructive effect.

**`SessionState` client→session pointers are deliberately NOT cleared.**
`_clientSessions` / `_clientPendingResume` (`src/session-state.ts:11-12`) are
*durable view pointers* — the session a browser is looking at. The underlying
session still exists on disk, so the correct recovery is to let the next
`ensureSession` re-resume it (P1 transitions already serialize this), not to drop
the user's view. The boundary event from step 4 prevents the FE from believing a
dispatch is still in-flight. The original finding listed "SessionState active
ids" as uncleared; the design decision here is that they *should* persist, and
the leak it actually cared about (orphan dispatch/queue/cache) is closed by steps
3–4. This is documented so an implementer does not wrongly null those pointers.

### Eviction: recency + awaited

Add `lastUsedAt: number` to `ActiveSession`; stamp it on resume/create and on
each dispatch start (where `isBusy`/dispatch begins). `evictInactiveSessions`
becomes `async`, sorts non-busy candidates by `lastUsedAt` ascending, and
`await`s each `stop()` so `resume()` does not return while eviction cleanup runs.
Callers (`_doResume`) `await` it.

### `watchExtensions()` disposer

`watchExtensions()` returns `{ close(): void }` that closes every `fs.watch`
handle it opened. `routes/websocket.ts` stores the handle and calls `close()` in
the `wss.on('close')` path alongside `clearInterval(heartbeat)`. If `wss` wiring
can run more than once, guard so only one watcher set is live.

### P1 carry-forward: `updatePreferences` inside the mutex

Move the `_preferences` read-modify-write into `runTransition` (or the existing
preferences-ownership path) so it serializes with session transitions.

## Slices (each independently shippable + gated + committed)

- **A — output-store sessionId identity.** Largest blast radius but mechanical and
  self-contained; do first. Delete cwd map; thread `sessionRef`/sessionId through
  display/observe/workflow/retrieve tools + session-manager call sites; add
  `requireSessionId(ref)` guard. Oracle: (1) two sessions in the *same cwd* store
  + retrieve independently (today this fails — sibling overwrite); (2) a stored
  output that has only legacy `sessionCwd` (no `sessionId`) is still retrievable.
  Gates green.
- **B — SessionRuntime owner + queue disposal.** `session-runtime.ts` registry;
  `getRuntime`/`disposeRuntime` (idempotent dispose); move the live `getQueue`
  consumers onto the runtime; export a `usageCache` clear seam from
  `routes/websocket.ts`; call `disposeRuntime` from stop/dropStale/eviction.
  Confirm git-edit-poller + file-edits cleanup is wired via `onSessionEnd`.
  Oracle: dispose removes the queue + throughput + usage entries (no stale
  pending/usage after stop). Gates green.
- **C — `restartSharedClient()` transaction.** Replace the inline clears in
  `ensureClientHealthy`/`resetIdleTimer`/`proactiveHealthCheck`/`handleClientError`;
  per affected session: end dispatch, dispose runtime, broadcast boundary; do not
  touch `_clientSessions`. Oracle: a forced restart disposes runtimes + emits a
  boundary event for each affected id and leaves no orphan dispatch/queue/usage
  entry. Gates green.
- **D — eviction recency + awaited.** `lastUsedAt` + sorted, awaited eviction.
  Oracle: most-recently-used session is never the eviction victim; `resume`
  awaits cleanup. Gates green.
- **E — `watchExtensions` disposer + retry-drop completeness.** Return `{close()}`,
  call on ws close; route retry drop through `dropStaleSession` (full disposal).
  Oracle: ws close closes extension watchers; retry drop leaves no orphan runtime.
  Gates green.
- **F — P1 carry-forward.** Move `updatePreferences` read-modify-write inside the
  per-client transition (mutex). Oracle: concurrent `updatePreferences` +
  transition do not interleave a lost write. Gates green.

Slice order respects dependencies: B introduces the owner that C/E dispose
through; A is independent and de-risks the identity change first. D, E, and F are
small and independent after B.

## Considerations

- **Ref timing & the `requireSessionId` guard.** On create, `sessionRef.id` is
  `'PENDING'` until `session.sessionId` is assigned (session-manager ~581); tools
  and the observation hook only read it at execution time, after assignment — so
  passing the ref is safe. But `server.ts:224-229` treats `'PENDING'` as truthy
  and would queue an embed under the placeholder. Add a shared
  `requireSessionId(ref)` (throws on empty/`'PENDING'`) used by **every** runtime-id
  consumer (storeOutput, embed-queue producer), so a future caller that stores
  during construction fails loudly instead of misrouting.
- **`usageCache` cleanup seam.** `usageCache` is module-local in
  `routes/websocket.ts:34`. There is no disposal API today; B must export a
  `clearUsage(sessionId)` (or equivalent) that `disposeRuntime` calls.
- **History replay path.** Live streaming uses `getQueue(sessionId)`
  (`src/routes/session-messages.ts:390`) — that queue belongs to the active
  session's runtime. Websocket **history replay constructs its own local
  `new CacoEventQueue()`** (`src/routes/websocket.ts:351`) and does NOT touch the
  registry. Therefore `SessionRuntime`/`getRuntime` must NOT be invoked for
  inactive-session history replay — doing so would create undisposed runtimes for
  sessions that are merely being viewed. The runtime registry is strictly for
  *active* sessions.
- **Idempotent dispose.** stop racing eviction racing restart must not throw or
  double-clear. `dispose()` guards on a disposed flag.
- **Disk back-compat.** Output files already live under `sessions/<id>/outputs/`;
  only the in-memory routing key changes, and `getOutput` scans by id. Pre-P6
  metadata has `sessionCwd` but no `sessionId`; `retrieve-tool` must authorize by
  `sessionId` when present and fall back to the legacy `sessionCwd` check
  otherwise, so existing outputs stay retrievable.
- **Don't over-own.** Roadmap, notes, applet-state, surface docs are addressed by
  their own stores and many are intentionally durable across stop; do not fold
  them into `SessionRuntime` in P6.

## Risks and Mitigations

- **R: A tool stores output during session construction (ref still PENDING).**
  Mitigation: `requireSessionId(ref)` throws on `'PENDING'`; audit the 3 store
  call sites (display, observe, workflow) + the embed-queue producer — all run
  post-construction.
- **R: Legacy outputs become unretrievable after the identity switch.**
  Mitigation: keep `sessionCwd` in metadata; `retrieve-tool` falls back to the cwd
  check when `sessionId` is absent (Slice A oracle covers this).
- **R: `restartSharedClient` broadcast storms the FE.** Mitigation: one boundary
  event per affected session, reusing the existing busy=false/error envelope the
  FE already handles (P2/P3 transactions).
- **R: Awaited eviction slows resume under load.** Mitigation: eviction only runs
  when over `MAX_ACTIVE_SESSIONS` and bounds the number stopped; `stop()` is fast
  (disconnect + map deletes).

## Acceptance

- Observable: two sessions in the same cwd store and retrieve tool output independently; after `stop`/delete, the session's CacoEventQueue is gone; a forced client restart emits one boundary event per affected session; eviction never targets the MRU session; ws close closes extension watchers.
- Budgets: n/a.
- Gates: `tsc` (×2 configs), `eslint --max-warnings 0`, `knip`, `vitest` — green after each slice.
- Oracles:
  - Slice A: two sessions same-cwd store + retrieve independently (sibling overwrite bug); legacy cwd-only output still retrievable after identity switch.
  - Slice B: `tests/unit/session-runtime.test.ts` — `disposeRuntime` removes queue, throughput, and usage entries; no stale pending after stop.
  - Slice C: forced `restartSharedClient` disposes runtimes + emits boundary event per affected session; no orphan dispatch/queue/usage entry remains.
  - Slice D: MRU session is never the eviction victim; `resume` does not return before eviction cleanup settles.
  - Slice E: ws close closes all `fs.watch` handles opened by `watchExtensions`; retry drop via `dropStaleSession` leaves no orphan runtime.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| A | Delete cwd map from `output-store`; thread `sessionRef`/sessionId through display/observe/workflow/retrieve tools + session-manager call sites; add `requireSessionId` guard | `src/output-store.ts`, `src/server.ts`, `src/observe/hook.ts`, `src/observe/retrieve-tool.ts`, `src/workflow/tool.ts`, `src/session-manager.ts`, `src/storage.ts` | Slice A oracles (sibling independence + legacy fallback) |
| B | Introduce `src/session-runtime.ts` registry; `getRuntime`/`disposeRuntime` (idempotent); move `CacoEventQueue` onto runtime; export `clearUsage` seam; call `disposeRuntime` from stop/dropStale/eviction | `src/session-runtime.ts`, `src/session-manager.ts`, `src/routes/websocket.ts` | `tests/unit/session-runtime.test.ts` |
| C | Replace inline `sharedClient=null; activeSessions.clear()` in 4 health-check sites with `restartSharedClient(reason)` transaction | `src/session-manager.ts` | Slice C oracle (boundary event per affected session) |
| D | Add `lastUsedAt` to `ActiveSession`; sorted ascending eviction; `await` each `stop()` in `evictInactiveSessions` | `src/session-manager.ts` | MRU not evicted; resume awaits cleanup |
| E | Return `{close()}` from `watchExtensions`; call on `wss.on('close')`; route retry drop through `dropStaleSession` | `src/session-manager.ts`, `src/routes/websocket.ts`, `src/dispatch-retry.ts` | ws close closes watchers; retry drop leaves no orphan |
| F | Move `updatePreferences` read-modify-write inside `runTransition` per-client mutex (P1 carry-forward) | `src/session-state.ts` | concurrent preference update + transition do not interleave |
