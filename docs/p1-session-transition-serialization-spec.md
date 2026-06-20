# P1 — Serialize per-client session transitions

Roadmap P1 (branch `code-review-brutal-2026-06`). Source findings:
`code-review-backend.md` Critical rows for `src/session-state.ts:80` and `:154`.

## Goal

Make per-client session-state transitions correct under concurrency. Two
overlapping transitions for one client must not (a) double-commit active
session / preferences last-writer-wins, nor (b) let a slower older transition
overwrite the state of a newer one. This is the root cause of flaky
start/switch reported by the user.

## Problem (current behavior)

`SessionState` (`src/session-state.ts`) holds per-client mutable maps
(`_clientSessions`, `_clientPendingResume`) and shared `_preferences`. Four
methods mutate that state across `await` points with no serialization:

| method | route | mutation |
|---|---|---|
| `ensureSession` | POST `/sessions` (newChat=true) | resume-pending or `sessionManager.create`, then set active + `lastSessionId`/`lastCwd` + `savePreferences` |
| `switchSession` | POST `/sessions/:id/resume` | `sessionManager.resume`, then set active + prefs + save |
| `prepareNewChat` | DELETE `/sessions/:id` (active) | clear active + prefs + save |
| `deleteSession` | delete flows | `sessionManager.delete`, clear active if it was active, fire listeners |

Because each `await`s the SDK (resume/create) before committing, two calls for
the same client interleave: both pass their guard, both commit, last writer
wins. Concurrent switches can also commit out of completion order, so the
slower resume overwrites the active session the user already moved on from.

`session-messages.ts` is NOT a caller — it operates on an explicit URL
`sessionId` and calls `sessionManager.resume` directly. So the only writers of
`SessionState`'s active/preference state are the four methods above.

## Design

**One mechanism: a per-client serialized transition chain (promise mutex)**,
keyed by `clientId` (default `DEFAULT_CLIENT`). Only one transition body runs
at a time for a given client; the next body does not start until the previous
settles. Each body runs to completion atomically with respect to other
transitions for the same client.

This single mechanism fixes both originating findings:

- **No double-create** (`ensureSession`): the second concurrent call's body
  starts only after the first has committed, so it observes the first's active
  session via the existing post-clear re-check (`session-state.ts:96`) and
  reuses it instead of creating again.
- **No switch reorder** (`switchSession`): two switches cannot resume
  concurrently. They commit in enqueue order, and enqueue order equals the
  user's action order, so the latest switch is the last to commit and wins.
  Because nothing runs concurrently, there is no "slower older resume
  overwrites newer" hazard.

### Why no generation/supersession token

An earlier draft added a monotonic generation token so a queued-but-stale
transition would skip its commit. Review showed this is both unnecessary and
harmful here:

- Unnecessary: with the mutex, the last-enqueued (latest-intent) transition is
  already the last to commit, so final state is correct without it.
- Harmful: enqueue-time supersession that skips a stale `ensureSession` commit
  reintroduces double-create (the next call sees no active session and creates
  again) and can return an orphan created session id that diverges from
  `SessionState`. Partial-body mutations (e.g. clearing `_clientPendingResume`
  before resume) would also escape a commit-only guard.

The only cost of mutex-only is latency: rapidly switching A then B makes B wait
behind A's resume. The reported defect is wrong final state, not latency, so
this is an acceptable tradeoff. True supersession (abandoning A's in-flight
resume) requires SDK resume cancellation and is deferred.

### API addition (private, on `SessionState`)

- `_clientTransition: Map<string, Promise<unknown>>` — per-client serialization tail.
- `runTransition<T>(clientId, body: () => Promise<T>): Promise<T>` — chain
  `body` after the current tail and return its result. The stored tail is
  `result.catch(() => {})` so a rejected transition does not wedge the chain;
  the original (possibly rejecting) promise is returned to the caller.

### Method changes

Wrap the existing bodies of `ensureSession`, `switchSession`, `prepareNewChat`,
and `deleteSession` in `runTransition(clientId, ...)`. Bodies are otherwise
unchanged — no commit becomes conditional, no mutation is skipped. Each runs
exactly as today, but never interleaved with another same-client transition.

- `deleteSession`: re-evaluate `wasActive` against the current active id at
  body start (inside the lock) rather than before enqueue, so a transition that
  committed while this delete was queued is accounted for.

### Behavioral invariants

- Single client, sequential requests: unchanged (chain depth 1).
- Return values: unchanged shape and meaning.
- SDK side effects (client load on resume/create) unchanged.
- No nested transitions (none of the four methods call another), so the chain
  cannot deadlock.

## Scope

This fix guarantees **same-client** transition correctness only. Cross-client
deletion of the same SDK session (one client deletes while another switches to
it) is out of scope — `deleteSession` locks on its caller's client. The current
delete caller (`routes/sessions.ts:898`) uses the default client.

## Test seam

Export the `SessionState` class with an `@internal` JSDoc tag (currently only
the singleton is exported); routes keep using the `sessionState` singleton.
Add `tests/unit/session-state-transition.test.ts` with `sessionManager` and
`preferences` module-mocked (vitest `vi.mock`). Mocks instrument call order and
allow a controllable (deferred) resume/create so overlap is observable. Each
case asserts the resulting `getActiveSessionId()` / `preferences` state
directly, not only `savePreferences` call counts.

1. **Concurrent ensure reuses, creates once** (`newChat=false`, no active
   session, slow create): two overlapping `ensureSession` calls →
   `sessionManager.create` called exactly once; both resolve to the same id;
   `getActiveSessionId()` === `preferences.lastSessionId` === that id.
2. **Concurrent switch, latest wins**: `switchSession(A)` (slow resume) then
   `switchSession(B)` (fast) → resume(B) does not start until resume(A)
   settles (no overlap); final `getActiveSessionId()` === B and
   `preferences.lastSessionId` === B regardless of resolve timing.
3. **Serialization ordering**: instrument resume/create start+settle on the
   mock; assert no second body starts before the first settles.
4. **Rejection isolation**: a transition whose resume rejects propagates the
   rejection to its caller but does not wedge the chain; a following
   transition still runs and commits correct state.

## Out of scope

- Dispatch lifecycle cleanup (`withDispatch`, `restartSharedClient`) → P2.
- Front-end activation tokens → P3.
- Websocket subscribe generation → P7.

## Verification

`npx tsc --noEmit`, `npx eslint . --max-warnings 0`, `npx vitest run` (existing
1130 + new cases). No behavior change for the single-request path.
