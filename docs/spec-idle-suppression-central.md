# spec-idle-suppression-central

`spec-idle-authority` centralized the SDK-event side of idle (herd, unobserved,
quota) behind one predicate + one seam, and protected the delegate by threading
an **optional** `suppressIdle` callback into `dispatchState.waitForActive`. But
`dispatchState.emit('idle')` is a lower layer with three consumers —
`waitForActive`, `waitForIdle`, and `restart-manager` — and only `waitForActive`
consults the predicate. `waitForIdle` (cancel/abort confirmation) and
`restart-manager` (graceful restart) are unprotected, and `suppressIdle` is a
per-caller opt-in a future consumer can forget. This spec moves the predicate
INTO `dispatchState` so **every** dispatch-state idle consumer is auto-protected
from one place, and removes the forgettable opt-in.

## Goals

- A `caco_enable_tools` reveal-idle (about to auto-continue) is suppressed at the
  `dispatchState` layer, so `waitForActive`, `waitForIdle`, and `restart-manager`
  are ALL protected without each opting in.
- `suppressIdle` as a per-call `waitForActive` option is **removed** — no consumer
  can forget it; the suppression is structural.
- The single predicate (`SessionManager.hasPendingAutoContinue`) is consumed at
  exactly two structural chokepoints — the idle authority (SDK-event side) and
  `dispatchState` (dispatch-emit side) — with no scattered/opt-in usage.
- No regression: normal dispatches, cancel/abort, and graceful restart behave as
  before for non-revealing sessions; a failed continuation still resolves every
  consumer (no hang).

## Design

### Central suppressor in dispatchState (injected — no layering violation)

`dispatchState` must not import `SessionManager`. Inject the predicate exactly
like `setAutoContinuePrefProvider`:

- `dispatchState.setIdleSuppressor(fn: (sessionId: string) => boolean)` — wired
  once (from `session-manager.ts`, which owns the predicate and already imports
  `dispatchState`) as `setIdleSuppressor(id => sessionManager.hasPendingAutoContinue(id))`.
- `private isEffectivelyIdle(sessionId): boolean = !this.isBusy(sessionId) &&
  !this.idleSuppressor?.(sessionId)` — "not busy AND not about to auto-continue."
  The single internal definition every wait path uses.

### Two enforcement points for one signal

1. **Suppress the emit in `end()`.** `end(sessionId)` deletes the dispatch, then
   emits `'idle'` ONLY when `!idleSuppressor?.(sessionId)`. A reveal-dispatch that
   is about to auto-continue does not signal idle to the edge-triggered listeners
   (`waitForActive.onIdle`, `restart-manager`'s idle listener) during the
   suppression window.
2. **Gate the wait entry paths on `isEffectivelyIdle`.** The `end()` suppression
   covers listeners, but `waitForActive`/`waitForIdle` also resolve via
   call-time fast-paths (`if (!isBusy) resolve('idle')`) that bypass the emit. A
   consumer entering DURING the suppression window (reveal ended → `isBusy` false,
   pending set → continuation not yet started) must not short-circuit. So both the
   entry fast-path, the post-arm re-check, and the `onIdle` listener resolve only
   when `isEffectivelyIdle(sessionId)` — replacing the per-call `suppressIdle`
   option, which is deleted from `WaitForActiveOptions` and from `delegate-tool.ts`.
3. **Gate `restart-manager`'s active-count check on any-pending-continuation.**
   `restart-manager` restarts when `getActiveCount() === 0`, checked BOTH on the
   idle listener AND **immediately** in `requestRestart()`. The immediate check
   bypasses the emit entirely, so `end()`-suppression alone does NOT protect it: a
   restart requested in the reveal-end → continuation-start window sees
   `getActiveCount() === 0` (dispatch deleted, continuation not yet started) and
   restarts prematurely, losing the reveal. Fix: `checkAndRestart` defers while
   `getActiveCount() > 0` **OR** any session has a pending continuation. The
   "any pending" signal is `SessionManager.hasAnyPendingAutoContinue()`, injected
   into `restart-manager` via its existing handler-registration seam (no
   `SessionManager` import). When the continuation resolves (its `end()` emits, or
   `signalIdle` on failed-start), the idle listener re-runs `checkAndRestart` →
   now clear → restart proceeds.

### The failed-continuation replacement emit (closes the edge-trigger hole)

Suppressing the `end()` emit assumes a later emit will arrive from the
continuation's own `end()`. If the continuation is expected but **fails to
start** (a non-409/non-eviction throw — the same case `spec-idle-authority`
handles on the SDK-event side), no continuation `end()` ever fires, so the
edge-triggered listeners that missed the suppressed emit would hang. The idle
authority already knows this outcome (`runAutoContinue` returns whether a
continuation `started`). Add one seam: when `willFire && !started`, the authority
calls `deps.signalDispatchIdle(sessionId)` → `dispatchState.signalIdle(sessionId)`
(a bare `this.emit('idle', sessionId)`), which — with pending now cleared —
reaches every consumer as a real idle. On the success path the authority does NOT
signal (the continuation's `end()` will), and on a plain no-reveal idle `end()`
already emitted, so no double-emit.

### Cancel/abort must clear the pending continuation (scoped to user cancel)

The user cancel/stop path `cancelSession` confirms the abort via `waitForIdle`.
With central suppression, an aborted session that still has a pending reveal would
(a) keep `waitForIdle` suppressed until timeout+force-clear, and (b) worse, let
the route's idle authority fire a continuation **after** the abort — a rogue turn.
Both are fixed by the correct semantic: **cancel cancels the pending
continuation.** `cancelSession` calls `sessionManager.resetAutoContinue(sessionId)`
**before** `session.abort()` (clear-BEFORE-abort — ordering matters: the SDK may
emit `session.idle` immediately on abort, and the route's idle authority reads
`hasPendingAutoContinue` on that event; clearing first guarantees no continuation
launches after the cancel).

**Scope: only `cancelSession`, not the retry-path abort.** `abortStaleGeneration`
(the dispatch-retry `abortOriginal`) does NOT use `waitForIdle` and does NOT
represent a user stop — it aborts a stale cold-generation and *resends*, where the
pending reveal should survive into the resend. It is deliberately left untouched;
clearing pending there would wrongly cancel a legitimate continuation.

## Invariants

- **One predicate, two chokepoints**: `hasPendingAutoContinue` is consumed only by
  the idle authority (SDK-event side) and `dispatchState` (emit side); no
  per-caller opt-in remains (`suppressIdle` option deleted).
- **Structural protection**: every `dispatchState` idle consumer
  (`waitForActive`, `waitForIdle`, `restart-manager` — both its listener and its
  immediate `requestRestart()` check — and any future one) is protected by
  `end()`-suppression + `isEffectivelyIdle` + the `hasAnyPendingAutoContinue()`
  restart gate, without opting in.
- **No lost idle**: a suppressed reveal-idle is always followed by exactly one
  real idle — from the continuation's `end()` (success) or the authority's
  `signalIdle` (failed start); never zero, never a spurious double.
- **Abort cancels continuation**: aborting a session clears its pending
  auto-continue, so no continuation fires after a cancel and `waitForIdle`
  confirms promptly.
- **Layering preserved**: `dispatchState` receives the predicate via an injected
  suppressor; it imports no `SessionManager`.
- **Idle authority unchanged in intent**: the SDK-event-side classification is as
  in `spec-idle-authority`, plus the one `signalDispatchIdle` call on the
  willFire-but-not-started fallthrough.

## Considerations

- **Two idle notions remain, deliberately**: the SDK `session.idle` event (route
  → idle authority → herd/unobserved/quota) and the `dispatchState` emit (delegate
  /restart/cancel). Both now gate on the same predicate; they are not merged
  because they serve different consumers at different layers. "One predicate" is
  the guarantee, not "one event."
- **`signalIdle` idempotency**: `waitForActive`/`waitForIdle` have a `settled`/
  `resolved` guard, so a redundant emit is harmless; `restart-manager`'s check is
  idempotent. The authority only signals on the failed-start branch, so a
  redundant emit is not even produced on the common paths.
- **Wiring order**: `setIdleSuppressor` is registered at `session-manager.ts` load
  (early, alongside `setDeferredDefsProvider`). `hasPendingAutoContinue`
  short-circuits on an empty pending set, so a suppressor call before the pref
  provider is wired is still correct (pending is only populated after the route is
  handling dispatches).
- **restart during a continuation window**: `restart-manager` defers on both its
  idle listener (`end()` suppressed) AND its immediate `requestRestart()` check
  (via `hasAnyPendingAutoContinue()`), so it never restarts on a reveal-idle; it
  restarts on the continuation's real idle (or the `signalIdle` fallthrough) —
  closing the previously-noted "restart in the ms window loses the reveal" gap
  for BOTH the listener and the immediate-request paths.

## Risks and Mitigations

- **A suppressed idle with no replacement (continuation neither starts nor is
  reported)** → the authority's `signalDispatchIdle` on `willFire && !started` is
  the guaranteed replacement; unit-tested. Belt: `waitForActive`/`waitForIdle`
  still have their absolute/idle timeouts as backstops.
- **Abort races the continuation** (SDK emits `session.idle` on abort before
  pending is cleared) → `cancelSession` clears pending (`resetAutoContinue`)
  BEFORE `session.abort()`, so the idle authority reading `hasPendingAutoContinue`
  on that event sees it already false and launches no continuation; no rogue turn
  survives the cancel. The retry-path `abortStaleGeneration` is out of scope (it
  resends; its pending reveal is legitimate).
- **Double-emit from `end()` + `signalIdle`** → the authority signals ONLY when
  `end()` suppressed (willFire) AND the continuation did not start; the
  non-suppressed `end()` path never also signals. Consumers are settle-guarded
  regardless.
- **Future consumer bypasses `isEffectivelyIdle`** → the only public wait APIs
  (`waitForActive`/`waitForIdle`) use it internally; a raw `on('idle')` listener
  (like `restart-manager`) is protected by `end()`-suppression, and any
  active-count-based readiness check must additionally consult
  `hasAnyPendingAutoContinue()` (the restart gate) — documented as the intended
  pattern.
- **restart requested exactly in the reveal-end→continuation gap** → the immediate
  `checkAndRestart()` defers on `hasAnyPendingAutoContinue()`; when the
  continuation starts+ends (or fails → `signalIdle`), the idle listener re-runs
  `checkAndRestart()` and restart proceeds — exactly one restart, never premature.
  Covered by an interleaving oracle.

## Acceptance

- `waitForIdle` does NOT resolve on a reveal-idle (pending continuation); it
  resolves on the real idle. (Previously unprotected.)
- `restart-manager` does NOT restart on a reveal-idle — neither via its idle
  listener NOR via an immediate `requestRestart()` issued in the suppression
  window; it restarts on the continuation's real idle / failed-start signal.
  (Previously unprotected on both paths.)
- `waitForActive` behaves as before via the central gate, with the
  `suppressIdle` OPTION removed and the delegate no longer passing it.
- A continuation that fails to start still resolves `waitForActive`/`waitForIdle`
  and triggers `restart-manager` (via `signalIdle`) — no hang.
- Aborting a session with a pending reveal clears it: no continuation fires
  post-abort, and `waitForIdle` confirms promptly.
- Non-revealing sessions: normal dispatch, cancel, and restart unchanged.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client, check:specs.
- Oracles:
  - `dispatchState` suppressor unit: with the suppressor true, `end()` emits NO
    `'idle'`; with it false, `end()` emits. `isEffectivelyIdle` = not-busy ∧
    not-suppressed.
  - `waitForActive` (option removed): entry fast-path / post-arm / listener all
    resolve only when `isEffectivelyIdle`; a suppressed end() does not resolve; a
    later unsuppressed end() (or `signalIdle`) does.
  - `waitForIdle` (now protected): does not resolve while suppressed; resolves on
    the unsuppressed emit / `signalIdle`.
  - `restart-manager`: no restart on a suppressed reveal-idle via the idle
    listener; AND an immediate `requestRestart()` in the suppression window defers
    (via `hasAnyPendingAutoContinue()`); restart fires on the real idle /
    `signalIdle`.
  - **Interleaving race oracle**: `end()` suppresses, `requestRestart()` is called
    in the gap, then the continuation either (a) starts+ends or (b) fails →
    `signalIdle`; assert exactly one restart, never premature, and exactly one
    delegate/`waitForIdle` resolution.
  - `signalIdle`: emits `'idle'` reaching all consumers; idempotent under settle
    guards.
  - Idle authority: `willFire && !started` ⇒ calls `signalDispatchIdle`;
    `willFire && started` ⇒ does not; no-pending ⇒ does not.
  - Abort: `cancelSession` on a session with pending clears it
    (`resetAutoContinue`) BEFORE `session.abort()`, so `waitForIdle` is
    unsuppressed and no continuation fires post-cancel; `abortStaleGeneration`
    (retry) leaves pending intact.
  - Regression: existing dispatch-state, delegate, herd, idle-authority, and
    usage-metrics-wiring tests stay green.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | `dispatchState`: `setIdleSuppressor` + `idleSuppressor` field + `isEffectivelyIdle`; `end()` emits only when not suppressed; `signalIdle(sessionId)` = bare emit | `src/dispatch-state.ts` | suppressor unit: end() suppress/emit; isEffectivelyIdle table |
| 2 | `dispatchState`: remove `suppressIdle` from `WaitForActiveOptions`; `waitForActive` entry/post-arm/listener use `isEffectivelyIdle`; `waitForIdle` uses `isEffectivelyIdle` | `src/dispatch-state.ts` | waitForActive + waitForIdle seam tests |
| 3 | Wire `setIdleSuppressor(id => sessionManager.hasPendingAutoContinue(id))` at session-manager load; drop `suppressIdle` from the delegate call | `src/session-manager.ts`, `src/delegate-tool.ts` | delegate compiles without the option; wiring present |
| 4 | Idle authority: on `willFire && !started`, call `deps.signalDispatchIdle(sessionId)`; route wires it to `dispatchState.signalIdle` | `src/idle-authority.ts`, `src/routes/session-messages.ts` | authority unit: signal on failed-start only |
| 5 | Abort clears pending: `abortStaleGeneration` (+ sibling abort) call `resetAutoContinue` before confirming via `waitForIdle` | `src/session-manager.ts` | abort unit: pending cleared ⇒ waitForIdle unsuppressed |
| 5 | Cancel clears pending: `cancelSession` calls `resetAutoContinue` BEFORE `session.abort()` (clear-before-abort); `abortStaleGeneration` left untouched. Add `SessionManager.hasAnyPendingAutoContinue()` | `src/session-manager.ts` | cancel unit: pending cleared before abort ⇒ waitForIdle unsuppressed; retry-path abort keeps pending |
| 6 | `restart-manager`: inject `hasAnyPendingAutoContinue` via the handler seam; `checkAndRestart` defers while `active>0 OR anyPending()` (protects the immediate `requestRestart()` path) | `src/restart-manager.ts`, wiring in `server.ts`/bootstrap | restart-manager unit (listener + immediate) + interleaving race oracle |
| 7 | Regression + full gate | tests | full gate |

## Rationale

`spec-idle-authority` proved the predicate correct but left its enforcement
partly opt-in (`suppressIdle`) and partly absent (`waitForIdle`,
`restart-manager`). Moving suppression into `dispatchState.end()` + a single
`isEffectivelyIdle` makes the dispatch-emit side structurally correct for every
consumer, present and future, from one place — the strong "correct by design"
guarantee. The only added moving parts are the injected suppressor (mirrors an
existing pattern), one `signalIdle` to replace a suppressed emit when a
continuation fails to start, and clearing pending on abort (a correctness fix in
its own right: cancel now cancels the continuation).
