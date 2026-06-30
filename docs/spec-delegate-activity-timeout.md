# Spec: Activity-aware `caco_session_delegate` timeout

Status: done

## Goals
Stop `caco_session_delegate` from reporting a false `(timed out after 15 minutes)`
while the delegate session is actively working. Replace the flat wall-clock deadline
with an **inactivity** timeout that resets on the delegate's event stream, so the wait
only fails after a genuine silence — never mid-progress.

## Problem
`delegate-tool.ts` calls `waitForSessionIdle(sessionId, 15min, isGone)`. That helper
(`dispatch-state.ts`) resolves on exactly: `'idle'` (the delegate's dispatch fully ends),
`'gone'` (session disappears), or `'timeout'` (a flat `setTimeout`). The flat timer is
total-budget, not activity-aware: a delegate emitting tool calls and messages for >15 min
still trips it. Yet the signal already exists — every delegate event runs through
`handleEvent` in `session-messages.ts`, which already feeds a `createWatchdog`
(`dispatch-watchdog.ts`) for the *delegate's own* dispatch (with tool-execution pause and
a long-running bump). The caller just doesn't see that activity.

## Design
Two small pieces, reusing existing primitives:

1. **Activity signal on `DispatchState`.** Add `notifyActivity(sessionId, eventType)`
   that emits an `'activity'` event `{ sessionId, eventType }`. Call it from
   `handleEvent` in `session-messages.ts` for every forwarded SDK event (the same place
   that already calls `watchdog.notifyEvent`). `DispatchState` is a process singleton and
   the delegate tool runs in the same process, so the caller's wait sees it directly — no
   event-bus or session-object plumbing.

2. **Activity-aware wait.** Add `waitForSessionActive(sessionId, { idleTimeoutMs,
   maxTotalMs, isGone })` to `dispatch-state.ts`. It keeps the `'idle'`/`'gone'`
   resolutions unchanged, but the timeout has two bounds:
   - an **idle gap** — a `createWatchdog({ initialTimeoutMs: idleTimeoutMs,
     betweenEventTimeoutMs: idleTimeoutMs, longRunningTimeoutMs: idleTimeoutMs,
     onTimeout })` fed each matching `'activity'` event via `watchdog.notifyEvent`.
     Reusing `createWatchdog` gives **tool-execution pause for free** — a delegate running
     one long silent tool (e.g. a 30-min build) won't false-timeout, matching how
     interactive dispatches already behave.
   - an **absolute cap** — a single `setTimeout(maxTotalMs)` started at wait entry that is
     NOT reset by activity. This is the caller-side backstop (see below).
   Both resolve `'timeout'`. All exit paths (`'idle'`/`'gone'`/either timeout) `cancel()`
   the watchdog and clear the absolute timer.

`delegate-tool.ts` switches to `waitForSessionActive(d.sessionId, { idleTimeoutMs:
DELEGATE_IDLE_TIMEOUT_MS, maxTotalMs: DELEGATE_MAX_TOTAL_MS, isGone })`.
`DELEGATE_IDLE_TIMEOUT_MS` is 15 min (now "15 min of silence," not total);
`DELEGATE_MAX_TOTAL_MS` is 60 min. On `'timeout'` the result message becomes
`(delegate still running after N min — check the session list)`, making clear the delegate
session is NOT killed; only the caller stops blocking.

### Why an absolute cap (and why it's generous)
`createWatchdog` cancels its timer entirely while a tool is executing
(`dispatch-watchdog.ts` `notifyEvent` on `tool.execution_start`). So a hung tool — or an
endless trickle of sub-idle-gap events — would leave a pure idle-gap wait blocked forever,
and the delegate's own dispatch watchdog has the same tool-pause and so cannot be relied on
to always end the turn. The absolute cap is the only guaranteed release for the *caller*.
It is set well above any realistic delegate task (60 min vs. the 15-min idle gap) so it
effectively never bites legitimate work; when it does fire, the delegate keeps running
autonomously (the cap bounds the caller's block, not the delegate), and the message points
the user to the session list.

## Considerations
- `notifyActivity` must fire on the delegate's events even though the delegate's terminal
  `session.idle`/`session.error` already drive `completeDispatch` → `'idle'`. Ordering is
  fine: `'idle'` resolves the wait regardless of a preceding `'activity'`.
- Only `waitForSessionIdle`'s sole caller (delegate) changes. `DispatchState.waitForIdle`
  (used by `session-manager.ts`) is untouched. Keep or remove `waitForSessionIdle` — it is
  now unused; remove it to avoid two ways to do one thing (knip will flag it otherwise).
- Listener hygiene: the `'activity'` listener and watchdog must be torn down on every exit
  path (idle/gone/timeout), mirroring the current cleanup.

## Acceptance
- **Idle gap resets, absolute cap doesn't**: emit activity every `idleTimeoutMs - ε` and
  assert no `'timeout'` until `maxTotalMs`, then assert `'timeout'` fires at `maxTotalMs`.
  (invariant + hand case, fake timers)
- **Times out on silence**: busy session, no activity for `idleTimeoutMs` (< `maxTotalMs`);
  resolves `'timeout'`. (hand case, fake timers)
- **Idle wins**: `dispatchState.end(sessionId)` resolves `'idle'` even with prior activity;
  both timers cleared (no later spurious fire). (hand case)
- **Gone wins**: `isGone()` true resolves `'gone'`. (hand case)
- **Tool pause**: emit `tool.execution_start`, then silence past `idleTimeoutMs` (but under
  `maxTotalMs`), then `tool.execution_complete`; assert NO timeout during the tool. (invariant
  — proves watchdog reuse)
- Full gate green; no dangling `waitForSessionIdle`.

## Plan
1. Add `notifyActivity(sessionId, eventType)` + `'activity'` emission to `DispatchState`;
   unit-test the emission.
2. Add `waitForSessionActive(sessionId, { idleTimeoutMs, maxTotalMs, isGone })` reusing
   `createWatchdog` for the idle gap plus a non-resetting `setTimeout` for the absolute
   cap; write the fake-timer acceptance tests FIRST.
3. Call `dispatchState.notifyActivity(sessionId, event.type)` in `handleEvent`
   (`session-messages.ts`), beside the existing `watchdog?.notifyEvent`.
4. Switch `delegate-tool.ts` to `waitForSessionActive`; add `DELEGATE_IDLE_TIMEOUT_MS`
   (15 min) + `DELEGATE_MAX_TOTAL_MS` (60 min); change the result message to "(delegate
   still running after N min — check the session list)".
5. Remove the now-unused `waitForSessionIdle`.
6. `npm run build`.
