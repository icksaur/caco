# spec-idle-authority

A session's `session.idle` event is currently observed and acted on in three
independent places — the dispatch route (unobserved-marking, quota, herd hook,
auto-continuation), the herd runtime (`onSessionIdle` → parent wake), and
dispatch-state (`emit('idle')` → delegate completion). None of them knows that an
idle which is about to trigger an **auto-continuation** (`caco_enable_tools`
reveal) is a **false idle**: the session is not done, it is about to re-dispatch.
As a result a herd child or a delegated child that reveals a tool **prematurely
wakes its parent / completes its delegation** before the continuation runs. This
spec introduces a single idle authority + one shared "effectively idle" predicate
so a reveal-driven idle is classified once and never leaks into herd-wake or
delegate-completion.


> **Amended by `spec-observation-authority`.** The authority's real-idle effects
> now carry the observation verdict past the `needsObservation` gate:
> `herdOnSessionIdle(sessionId, attended)` threads `!needsObservation` so the
> unconditional `lastIdleAt` stamp also records `lastAttendedAt`. Without it the
> live badge and the post-restart badge derived the same question two different
> ways and disagreed for every agent-requested idle.

## Goals

- A `caco_enable_tools` reveal-idle (one that will auto-continue) **MUST NOT** be
  treated as a herd child idle (no parent wake).
- The same reveal-idle **MUST NOT** be treated as a `caco_session_delegate` idle
  (the delegate keeps waiting until the session is *really* done).
- Nor mark the session unobserved, nor complete its herd-wake or
  delegate-wait, until the session reaches a **real** idle (no pending
  continuation). (Scope is these three targeted completion consumers;
  `dispatchState.end()` still emits `idle` for any other listener.)
- **One source of truth**: a single predicate + a single idle-classification seam
  that every real-idle consumer routes through, so future idle consumers cannot
  re-introduce the leak.

## Design

### The false-idle predicate (single source of truth)

Add `SessionManager.hasPendingAutoContinue(sessionId): boolean` — true iff a
continuation **will fire** on the next idle: `getPendingTools(sessionId).length >
0` AND the operator preference is on AND `getAutoContinueAttempts(sessionId) <
AUTO_CONTINUE_CAP`. It deliberately does **not** gate on `isBusy` — it answers
"is this session about to auto-continue?", evaluated at the idle boundary where
the current dispatch is ending. A capped pending set (attempts ≥ cap) returns
`false`: that idle IS real (the session is done — see the cap handling below).

This is the ONE predicate both consumers below read; neither re-derives the rule.

**Preference seam (no cyclic dependency).** SessionManager has no preference
source and must not grow one. The operator's auto-continue preference is injected
exactly like the existing `setDeferredDefsProvider` pattern: a module-level
`setAutoContinuePrefProvider(() => boolean)` wired once at startup (from
`sessionState.preferences` via `isAutoContinueEnabled`). `hasPendingAutoContinue`
reads that provider; it never imports the preference/session-state modules.

### The idle authority (one classification seam)

Introduce `handleSessionIdle(sessionId, ctx, deps)` in a new `src/idle-authority.ts`,
the single place the dispatch route calls on `session.idle`. Its deps are injected
(SessionManager accessors, the herd hook, unobserved/quota, and the
auto-continue runtime) so the classification is unit-testable in isolation. It
classifies the idle exactly once:

1. Capture `willFire = deps.hasPendingAutoContinue(sessionId)` **before** invoking
   the continuation machinery (the fire path clears the pending set).
2. If there are ANY pending tools (`getPendingTools > 0`), call
   `deps.maybeAutoContinue(sessionId)` — this internally either **fires** the
   continuation, or (at cap) **emits the terminal cap message**, or (pref off)
   no-ops. Driving it whenever a pending set exists is what closes the cap gap:
   the cap message reliably fires even though `willFire` is false.
3. If `willFire` was true ⇒ **false idle**: return now — do NOT mark unobserved,
   do NOT run the herd hook, do NOT poll quota. The session is logically still
   busy; its "real" idle comes when the continuation finishes with nothing
   pending.
4. Otherwise ⇒ **real idle** (nothing pending, OR pending-but-capped, OR
   pref-off): run the real-idle effects in order — `unobservedTracker.markIdle`
   (still gated on `needsObservation`), the herd `onSessionIdle` hook,
   `pollQuota`. A capped session therefore correctly reports done to
   herd/delegate/unobserved *after* its cap message.

`ctx` carries `{ needsObservation }`. The route's `session.idle` branch collapses
to a single `void handleSessionIdle(sessionId, { needsObservation }, deps)` call
after `completeDispatch` resolves (so `isBusy` is already false and the
continuation can start). `triggerAutoContinue` is subsumed into the authority; the
scattered inline calls (markIdle, onSessionIdle, quota, triggerAutoContinue) are
removed from the route.

### Delegate: consume the predicate at the wait seam

The delegate completes via `dispatchState.waitForActive` resolving on
`emit('idle')` (fired by `dispatchState.end` inside `completeDispatch`) — a layer
below the idle authority, so it cannot be folded into `handleSessionIdle`.
Instead it consumes the **same predicate** by injection (dispatch-state must not
import SessionManager — layering): extend `WaitForActiveOptions` with an optional
`suppressIdle?: () => boolean`. The delegate tool passes `suppressIdle: () =>
sessionManager.hasPendingAutoContinue(childId)`.

**Gate EVERY idle-resolution path, not just the listener.** `waitForActive` has
three ways to resolve `'idle'`: the entry fast-path `if (!isBusy) resolve('idle')`,
the post-arm re-check `if (!isBusy) finish('idle')`, and the `onIdle` listener.
A reveal-dispatch can `end()` before the listener attaches, or between the entry
check and arming, so **all three** must consult `suppressIdle`:

- Entry fast-path: `if (!isBusy(sessionId) && !suppressIdle?.())` — otherwise arm
  the listeners and wait.
- Post-arm re-check: same guard.
- `onIdle`: `if (id === sessionId && !suppressIdle?.()) finish('idle')` — a
  suppressed idle is ignored and the listener stays armed.

With all three gated, the window between the reveal-dispatch's `end()` (idle
emitted, `isBusy` briefly false) and the continuation's `start()` (busy again)
cannot resolve the delegate: every path sees `suppressIdle` true until the
continuation reaches a real idle (predicate false), which then resolves normally.

### Herd: gate the wake on the predicate

`onSessionIdle` (herd) returns early when `hasPendingAutoContinue(sessionId)` is
true — no `markSessionIdle` stamp (a child about to continue is not idle for
staleness either), no parent wake, no own-herd re-eval. Because the idle
authority already skips the herd hook on a false idle, this guard is a
belt-and-suspenders invariant at the herd entry so any *other* future caller of
`onSessionIdle` is also protected.

## Invariants

- **One predicate**: `hasPendingAutoContinue` is the sole definition of
  "effectively not idle"; the idle authority, the herd hook, and the delegate
  wait all read it — none re-implements the rule.
- **False idle is inert to completion signals**: when a continuation will fire,
  the idle marks nothing unobserved, wakes no parent, and completes no delegation
  — only the auto-continuation runs. (Narrow scope: the herd hook, the delegate
  wait, and unobserved-marking; `dispatchState.end` still emits `idle` for
  unrelated listeners.)
- **Capped continuation is a real idle, WITH its cap message**: at `attempts ≥
  cap` the predicate is false, so the session is reported done to herd/delegate —
  but the authority still drives `maybeAutoContinue` (because a pending set
  exists), so the terminal cap message fires before the real-idle effects. A
  capped reveal-idle never finishes silently.
- **Real idle still propagates everywhere**: with no pending continuation, herd
  wake + delegate completion + unobserved-marking behave exactly as before (no
  regression for non-revealing sessions).
- **Layering preserved**: dispatch-state does not import SessionManager; it
  receives the predicate as an injected `suppressIdle` callback.

## Considerations

- **Ordering**: the route calls `handleSessionIdle` inside the
  `completeDispatch().then(...)` callback (as `triggerAutoContinue` is today), so
  `isBusy` is false and the continuation's `startDispatch` succeeds. The herd hook
  moves from before-completeDispatch to after — a behavior change, but strictly
  more correct (the wake now sees the fully torn-down dispatch, matching the
  auto-continue timing).
- **Delegate watchdog during a continuation**: the continuation is real work, so
  its `activity` events feed `waitForActive`'s watchdog — a suppressed idle does
  not risk a false timeout as long as the continuation streams events. All three
  idle-resolution paths (entry fast-path, post-arm re-check, `onIdle`) consult
  `suppressIdle`, so no resolve can slip through the end()→start() window. Worst
  case (a continuation that itself immediately idles with nothing pending)
  resolves the delegate normally on the next real idle.
- **`markSessionIdle` semantics**: skipping the stamp on a false idle means a
  revealing child does not advance its herd-staleness clock mid-continuation —
  correct, since it is actively working.
- **No new event subscriptions**: this reuses the existing `session.idle` seam
  and the existing `dispatchState` idle emit; it adds one predicate + one options
  field, not a parallel idle funnel.

## Risks and Mitigations

- **A suppressed delegate idle never resolves** (continuation never reaches a real
  idle, e.g. runaway) → bounded by the auto-continue cap (≤3) after which the
  predicate goes false and the next idle resolves the delegate; plus the
  delegate's own `maxTotalMs`/watchdog timeouts remain as backstops.
- **Predicate/΄state races** (pending set cleared between the emit and the
  `onIdle` check) → `hasPendingAutoContinue` reads SessionManager's live maps
  synchronously; the continuation clears `pendingTools` only *inside* the fire
  path (after the decision), so a concurrent read is consistent with "will fire."
- **A future idle consumer bypasses the authority** → the herd hook's own
  belt-and-suspenders guard + documenting `hasPendingAutoContinue` as the
  required gate; the single `handleSessionIdle` seam is the intended entry point.
- **Behavior change from moving the herd hook after completeDispatch** → covered
  by the herd tests; the wake still fires for every real idle, just after teardown.

## Acceptance

- A herd **child** that calls `caco_enable_tools` and idles does **not** wake its
  parent on that idle; the parent is woken only after the child's continuation
  finishes with nothing pending.
- A **delegated** session that calls `caco_enable_tools` and idles does **not**
  resolve the delegate's `waitForActive`; it resolves only on the real idle after
  the continuation.
- A non-revealing session's idle wakes the herd parent / completes the delegate
  exactly as before (no regression).
- A capped-out pending continuation reports a real idle (herd wake + delegate
  completion fire).
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client, check:specs.
- Oracles:
  - `hasPendingAutoContinue` unit table: pending+enabled+under-cap ⇒ true;
    no-pending ⇒ false; at-cap ⇒ false; pref-off ⇒ false (pref via the injected
    provider).
  - Idle-authority unit (injected deps): **false idle** (willFire) ⇒ fires
    continuation, calls NONE of {markIdle, herd onSessionIdle, pollQuota};
    **real idle, nothing pending** ⇒ calls all three, invokes no continuation;
    **real idle, pending-but-capped** ⇒ drives `maybeAutoContinue` (cap message)
    AND calls all three; **pref-off** ⇒ real-idle effects, no continuation.
  - Delegate seam (pure dispatch-state): with `suppressIdle` true, NONE of the
    three resolution paths resolve — entry fast-path, post-arm re-check, and an
    `emit('idle')` all keep waiting; a later `emit('idle')` with `suppressIdle`
    false resolves `'idle'`.
  - Herd guard: `onSessionIdle` with `hasPendingAutoContinue` true ⇒ no
    `markSessionIdle`, no `wakeParent` (mock the predicate + wake deps).
  - Route behavior (SHOULD): on a false idle, assert no parent wake, no delegate
    completion, no unobserved mark; on a real idle, all three fire — via the
    idle-authority unit with spy deps (the route delegates to it).
  - Regression: existing herd + usage-metrics-wiring + delegate tests stay green.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | `SessionManager.hasPendingAutoContinue` = pending non-empty ∧ pref-on ∧ attempts<cap; add `setAutoContinuePrefProvider(() => boolean)` (mirrors `setDeferredDefsProvider`) wired from `isAutoContinueEnabled(sessionState.preferences)` at startup — no session-state import in SessionManager | `src/session-manager.ts`, wiring in `server.ts`/route | predicate unit table (incl. pref-off via provider) |
| 2 | `src/idle-authority.ts` `handleSessionIdle(sessionId, ctx, deps)` — capture `willFire` first; if pending>0 drive `maybeAutoContinue` (fire OR cap message); willFire ⇒ return; else markIdle+herd+quota | new `src/idle-authority.ts` | idle-authority unit: false / real-empty / real-capped / pref-off branches |
| 3 | Route: replace the inline `session.idle` block (markIdle/pollQuota/onSessionIdle/triggerAutoContinue) with one `handleSessionIdle(..., deps)` call inside `completeDispatch().then(...)`; remove the now-dead `triggerAutoContinue` | `src/routes/session-messages.ts` | route delegates to authority; explicit false-idle (no wake/complete/mark) + real-idle oracle via the authority unit |
| 4 | Delegate seam: add `suppressIdle?: () => boolean` to `WaitForActiveOptions`; gate ALL THREE resolve paths (entry fast-path, post-arm re-check, `onIdle`); `delegate-tool.ts` passes `() => sessionManager.hasPendingAutoContinue(childId)` | `src/dispatch-state.ts`, `src/delegate-tool.ts` | dispatch-state seam test over all three paths |
| 5 | Herd guard: early-return in `onSessionIdle` when `hasPendingAutoContinue` (no stamp/wake) | `src/herd-runtime.ts` | herd guard unit |
| 6 | Regression + gate | tests | full gate |

## Rationale

The leak exists because "idle" is overloaded: the SDK's `session.idle` fires
between the reveal dispatch and the auto-continuation, but only the
auto-continuation machinery knows another dispatch is imminent. Centralizing the
classification behind one predicate (`hasPendingAutoContinue`) and one seam
(`handleSessionIdle`), and feeding the same predicate to the one consumer that
lives a layer below (the delegate wait), makes "a reveal-idle is not a real idle"
a single, testable fact rather than an emergent property of call ordering.
