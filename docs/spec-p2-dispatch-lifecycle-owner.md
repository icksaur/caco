# P2 — Single dispatch lifecycle (cleanup) owner

Roadmap P2 (branch `code-review-brutal-2026-06`). Source findings:
`code-review-backend.md` High rows for `session-messages.ts:294-299` and
`:312-326` / `:492-505` (dispatch cleanup spread across callbacks and catch
blocks; the `!session` branch leaks).

## Goals

Make dispatch teardown a single, idempotent owner that every exit path routes
through, so no branch can forget part of the cleanup contract. Eliminates the
temp-file leak and missing `session.busy=false` broadcast on the early
`!session` path, and removes the scattered hand-rolled cleanup subsets.

## Problem (current behavior)

`dispatchMessage()` (`src/routes/session-messages.ts`) is long-lived: it returns
HTTP 200 after the send is accepted, but the dispatch actually completes
asynchronously later (SDK `session.idle`/`error`, watchdog timeout, or send
error). Teardown is implemented in **three** places with **different** subsets
of the same contract:

| exit path | site | endDispatch | busy=false | unlink temp | watchdog.cancel | unsubscribe | guard |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|
| idle/error event, watchdog timeout, retry-failed, send-error | `cleanupAndComplete` (312) | yes | yes | yes | yes | caller does it separately | `dispatchCompleted` |
| no active SDK session | `!session` branch (294) | yes | **no** | **no** | n/a (not created yet) | n/a | none |
| pre-watchdog throw | outer `catch` (492) | yes | yes | yes | **no** | n/a | `!dispatchCompleted` |

The cleanup contract (the set every exit must satisfy) is:
`dispatchCompleted=true` → `watchdog.cancel()` (if created) → `endDispatch` →
broadcast `session.busy=false` → unlink temp files → `unsubscribe()`.

Smells (per code-quality.md "implicit coupling"): a helper (`cleanupAndComplete`)
that callers must remember to pair with `unsubscribe()`; two other exit paths
re-implement a subset by hand; the `!session` path silently leaks temp image
files and never clears client-visible busy state.

## Design

One owner closure defined **before any exit path** (above the `!session`
check and even above the resume/ensureClientHealthy calls that can throw),
covering the cleanup contract idempotently, with existence-guards so it is
safe to call before the watchdog exists. It is `async` and returns a promise so
synchronous/pre-send exit paths can await temp-file deletion before
returning/throwing.

It deliberately does **not** own `unsubscribe()`. The retry helper
(`retryWithFreshClient`, `dispatch-retry.ts:45,64`) already tears down both the
old and the new subscription itself, which is why the two retry-failed sites
complete the dispatch *without* a local `unsubscribe()`. Folding `unsubscribe`
into the owner would double-call an already-consumed handle (SDK unsubscribe
idempotency is unspecified). So the existing `unsubscribe()` calls stay exactly
where they are; the owner centralizes only the rest of the contract.

```
let dispatchCompleted = false;
let sendStarted = false;
let watchdog: ReturnType<typeof createWatchdog> | null = null;
let unsubscribe: () => void = () => {};

const completeDispatch = async (reason: string): Promise<void> => {
  if (dispatchCompleted) return;
  dispatchCompleted = true;            // set synchronously: dedups concurrent callers
  watchdog?.cancel();
  sessionManager.endDispatch(sessionId);
  broadcastGlobalEvent({ type: 'session.busy', data: { sessionId, isBusy: false } });
  if (tempFilePaths) await Promise.all(tempFilePaths.map(p => unlink(p).catch(() => {})));
  console.log(`[DISPATCH:${rid}] Completed: ${reason}`);
};
```

### Changes

- Hoist `watchdog` to a `let ... | null = null;` declared above the `!session`
  check; assign it at `createWatchdog(...)`. Existing references
  (`watchdog.notifyEvent`, `watchdog.reset`, the retry `resetWatchdog`) become
  optional-chained (`watchdog?.`) — type-safe and behavior-identical, since
  those closures only run after assignment.
- Define `completeDispatch` at the top of the `try`, before the
  resume/ensureClientHealthy calls, so the outer `catch` (which today
  hand-rolls cleanup precisely because the old helper was defined too late) can
  route through it.
- Replace the seven `cleanupAndComplete(...)` call sites with
  `completeDispatch(...)`, preserving each site's existing `unsubscribe()` (or
  intentional absence, for the two retry-failed sites). Async SDK-callback
  sites use `void completeDispatch(...)`; synchronous/pre-send sites `await` it.
- `!session` branch: emit the existing `session.error` event, then
  `await completeDispatch('no-session'); return;` instead of a bare
  `endDispatch()`. This now unlinks temp files and broadcasts busy=false.
  (busy=false with no prior busy=true is harmless — the client tracker clamps
  to not-busy.)
- Outer `catch`: keep the `if (!dispatchCompleted)` guard; replace the body's
  hand-rolled cleanup with `onEvent(error); await completeDispatch('outer-error');`.
  Preserve `if (!sendStarted) throw error;`.
- Add `if (dispatchCompleted) return;` at the top of `handleEvent` so an SDK
  callback already queued when teardown runs cannot re-process after
  completion (review-flagged late-event window; cheap guard).

### Invariants preserved

- Idempotency: `dispatchCompleted` set synchronously at owner entry, so racing
  exit paths (e.g. sync send-error throw → outer catch) collapse to one teardown.
- Subscription teardown timing is unchanged: every site that called
  `unsubscribe()` after cleanup still does; retry paths still own their own.
- The happy path (send accepted, events stream, idle later completes) is
  unchanged.
- `startDispatch` still brackets the whole function; `endDispatch` runs exactly
  once via the owner. Order endDispatch → busy=false broadcast preserved
  (restart-manager listens on the dispatchState 'idle' from endDispatch).

## Out of scope — deferred to P6

`ensureClientHealthy()` (`session-manager.ts:321`) force-stops the shared client
and does `this.activeSessions.clear()` on ping failure, dropping **all** active
sessions' in-memory handles without clearing their dispatch state, queues, or
subscriptions (the Critical finding). The correct fix is a `restartSharedClient`
transaction that returns affected sessions and routes their cleanup/resume
through one lifecycle owner — which is exactly the `SessionRuntime` owner built
in **P6**. Building a restart transaction now, before that owner exists, would
duplicate work and leave a half-owned lifecycle. P2 therefore fixes only the
dispatch-teardown contract; the client-restart Critical moves to P6.

## Test seam

`dispatchMessage` is exported. Add a focused test for the previously-leaking
`!session` path, module-mocking the heavy dependencies (`session-manager`,
`session-state`, `./websocket`, `session-throughput`). Drive `getSession` →
`null`, pass `tempFilePaths` pointing at real temp files, and assert after
`dispatchMessage` resolves (deterministic — the `!session` path awaits the
owner):

1. the temp files are unlinked (no leak),
2. `broadcastGlobalEvent` was called with `session.busy` `isBusy:false`, and
   **no** `session.busy` `isBusy:true` was broadcast on this path,
3. `endDispatch(sessionId)` was called once,
4. a `session.error` ("No active session") event reached `onEvent`.

This test fails against the current `!session` branch (temp files remain;
busy=false never broadcast) and passes after the owner refactor.

## Verification

`npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npx vitest run`
(existing 1134 + new). No behavior change on the happy path.

## Acceptance

- Observable: the `!session` path unlinks temp image files and broadcasts `session.busy` `isBusy:false`; every exit path produces exactly one `endDispatch` call.
- Budgets: n/a — happy path is behaviorally unchanged.
- Gates: `npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npx vitest run`
- Oracles:
  - `tests/unit/session-messages-dispatch.test.ts` — `!session` path: (a) temp files are unlinked, (b) `broadcastGlobalEvent` called with `session.busy` `isBusy:false`, (c) `endDispatch(sessionId)` called once, (d) `session.error` event emitted. All asserted RED against the pre-refactor branch.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | Hoist `watchdog` as `let ... \| null = null`; define `completeDispatch` owner above the `!session` check | `src/routes/session-messages.ts` | tsc clean |
| 2 | Replace `cleanupAndComplete` call sites with `completeDispatch`; route `!session` branch through owner; optional-chain `watchdog?.cancel()` | `src/routes/session-messages.ts` | tsc clean |
| 3 | Route outer `catch` through `completeDispatch`; add `if (dispatchCompleted) return` guard at top of `handleEvent` | `src/routes/session-messages.ts` | tsc clean |
| 4 | Add `session-messages-dispatch.test.ts` `!session` path cases; verify RED→GREEN | `tests/unit/session-messages-dispatch.test.ts` | oracle: test file |
