# spec-rotation-windows

Give an over-pressure session a *designed* rotation window instead of relying on incidental
LRU eviction. Amends the trigger policy of `docs/spec-history-rotation.md` and builds on
`docs/spec-rotation-pressure.md` (which removed the viewed gate at ≥256 MiB). The
copy-verify-swap mechanism is unchanged.

## Goals

`spec-rotation-pressure` removed the gate that *blocked* rotation of a large, permanently-open
session. It did not create a moment when that rotation can actually *run*. Measured after it
shipped (2026-07-26): the SSG session is **443.8 MiB** (still the only session over the
256 MiB ceiling), has **no `events-archive.jsonl`** and **no rotation stamps** in meta — still
never rotated.

The three remaining blockers are all properties of *when* the sweep runs, not *whether* the
session qualifies:

1. **`bootExcludeId`** — `server.ts:334` passes `lastSessionId` to skip the session the UI
   auto-opens. Verified: `~/.copilot/web-preferences.json` `lastSessionId` **is** the
   443.8 MiB session. The boot sweep skips precisely the one session that needs it.
2. **`minIdleAgeMs = 4h`** (sweep default) — a session used right before a restart fails it.
3. **`isActive`/`isBusy`** — true whenever the session is loaded, which for a daily driver is
   most of the time.

The result is structural, not bad luck: **the session that most needs rotation is the one
least likely to be caught**, because "most used" and "auto-opened" are the same property that
disqualifies it. The goal is two deliberate windows — one at boot, one during genuine quiet —
that reach an over-pressure session without weakening any correctness invariant.

Non-goal: changing the cut point, verify-before-swap, archive, or crash recovery.
Non-goal: rotating any session below the pressure ceiling differently than today.
Non-goal: touching the shutdown path (`sessionManager.shutdown()` only stops the shared
client, `session-manager.ts:2699`; adding per-session stops there would risk hanging shutdown
behind a multi-second verify).

## Design

### Correction: `onAllIdle` is NOT usable (measured)

An earlier verbal suggestion proposed hanging maintenance off `onAllIdle`. **That is wrong on
two counts**, both verified in `src/restart-manager.ts`:

- **It is restart-only.** `checkAndRestart()` begins `if (!restartRequested) return;`
  (`:104`), so the callback fires *only* while a restart is pending — it is not a general
  "server is quiet" signal.
- **It is single-slot.** `onAllIdleCallback` is a bare `let … = null` (`:34`) assigned by
  `onAllIdle` (`:100`), and `server.ts:232` **already registers one** (the socket teardown).
  A second registration would silently **clobber restart cleanup**.

The correct signal is the existing `dispatchState` EventEmitter, which already emits a
suppression-aware `'idle'` (`src/dispatch-state.ts:83`, gated by `idleSuppressor` so a
pending auto-continuation does not read as idle).

### Window 1 — boot pressure pass (airtight; the primary fix)

At boot, an over-pressure session is provably safe to rotate, and this is **structural rather
than probabilistic**:

| Gate | At boot | Why it holds |
|---|---|---|
| `isActive` | false | Resume is **lazy** — "Will resume session X on first message" (`session-state.ts:346`); `activeSessions` is empty |
| `isBusy` | false | No dispatch has occurred |
| `isViewed` | false | WS clients have not reconnected |

Add a second, **narrow** boot pass that runs **early** (default 3 s after listen, *before* the
existing 60 s viewer-registration delay) and considers **only sessions at/above
`pressureBytes`** (today: exactly 1 of 53). For those sessions only:

- **ignore `bootExcludeId`** — it exists to avoid disturbing the auto-opened session, but that
  is the session that needs rotating, and `resume()` **already waits on the rotation lock**
  (`session-manager.ts:876`), so a click landing mid-rotation is *delayed*, never corrupted;
- **ignore `minIdleAgeMs`** — it is a *proxy* for "provably cold"; at boot coldness is
  guaranteed by an empty `activeSessions`, so the proxy is redundant;
- **keep every correctness gate** (`isBusy`/`isRotating`/`isResuming`) exactly as-is.

The existing 60 s general sweep is unchanged and still runs after it.

**Why the cost is acceptable**: the verify is one cold load of that session — and the user is
about to pay a cold load anyway, because it is the session the UI auto-opens. It is
approximately free *once*, and removes ~400 MB from every subsequent open and every boot.

### Window 2 — quiet-period maintenance pass

A server that runs for weeks may never see a boot. Second window: after the server has been
**completely idle** (no dispatches at all) for `CACO_ROTATE_QUIET_MS` (default 15 min),
run a pressure-only pass. This window may legitimately find the session **loaded but idle** —
the case the boot pass cannot reach.

**Trigger mechanism (idle-armed, gated at fire time).** `DispatchState.start()` emits
**nothing** (`dispatch-state.ts:66-75`); only `'idle'` and `'activity'` are observable. So
"any start cancels the timer" is **not implementable** and is explicitly not the design.
Instead:

- on `dispatchState.on('idle')` — already suppression-aware (`:83`, gated by `idleSuppressor`
  so a pending auto-continuation does not read as idle) — **(re)arm** a single debounce timer
  for `CACO_ROTATE_QUIET_MS`;
- when the timer **fires**, re-check `dispatchState.getActiveCount() === 0` and abort the pass
  if anything is dispatching. This fire-time gate is what actually enforces quiet, since work
  that started mid-window produced no cancellable event;
- the timer is `unref()`'d and single (re-arming replaces it), so it can never keep the
  process alive or stack up.

A `stopIfIdle` inside the pass calls `dispatchState.end()`, which itself may emit `'idle'` and
re-arm the timer. Harmless (the next fire re-checks and finds nothing eligible, since the
cooldown is now stamped), but noted so it is not mistaken for a loop.

**The busy race, and where safety actually comes from.** `spec-rotation-pressure` explicitly
rejected evict-then-rotate because `SessionManager.stop()` has no busy guard: a turn beginning
between the eligibility check and the `stop()` would be torn down.

**The rotation itself is already race-free, and not because of anything in this spec.**
`runExclusiveRotation` (`session-manager.ts:932-941`) performs a **synchronous** liveness
triple-check *before* acquiring the maintenance claim:

```
if (activeSessions.has(id))     throw 'Cannot rotate active session'
if (isBusy(id))                 throw 'Cannot rotate busy session'
if (resumeInProgress.has(id))   throw 'Cannot rotate while a resume is in flight'
```

The third is the subtle one and it is already correct: a resume is invisible to
`activeSessions` until *after* the multi-second SDK read of `events.jsonl` (`_doResume` sets
it last), but `resumeInProgress` is set **synchronously at `resume()` entry, before any
await** — so a resume that begins at any point before the claim is taken is seen. **This is
the mechanism that prevents rotating out from under a live or loading session, and neither
window may bypass it.** Both windows MUST route through `rotateSessionHistory` /
`runExclusiveRotation`; calling `performRotation` directly would defeat it.

**What `stopIfIdle` is for** is narrower: it makes *stopping* a loaded session safe so that
`runExclusiveRotation`'s `activeSessions.has` check can then pass. `stop()` is unsuitable
because it deletes from `activeSessions` **after** `await session.disconnect()`
(`session-manager.ts:~1276`), so a dispatch can begin during that await and be aborted:

```
stopIfIdle(sessionId): Promise<boolean>   // new, SessionManager
  // -- synchronous prefix: atomic under Node's single-threaded model --
  if (dispatchState.isBusy(sessionId)) return false;   // busy => never torn down
  const active = activeSessions.get(sessionId); if (!active) return true;
  activeSessions.delete(sessionId);        // remove BEFORE any await
  // -- awaits may follow safely --
  await active.session.disconnect(); dispatchState.end(...); disposeSessionRuntime(...)
```

The busy check and the delete are in one synchronous block, so no other JS — including
`dispatchState.start()` — can interleave. A busy session returns `false` and is skipped
(reason `busy`), never torn down. After the delete, a dispatch that arrives finds the session
inactive and goes through `resume()`, which both waits on the rotation claim
(`session-manager.ts:876`) **and** sets `resumeInProgress` synchronously — so if it wins the
race, `runExclusiveRotation` refuses the rotation rather than rewriting under it. Safety is
therefore layered: `stopIfIdle` protects the *turn*, `runExclusiveRotation` protects the
*file*.

`stopIfIdle` is used **only** by this pass; `stop()` is untouched for all existing callers.

### Shared: `sweepPressureOnly`

Both windows call one function that reuses `autoRotateIfEligible` and its gates, passing
`minIdleAgeMs: 0` and pre-filtering to sessions ≥ `pressureBytes`. Difference: the boot pass
never stops anything (nothing is loaded); the quiet pass may call `stopIfIdle` first when a
candidate is loaded-but-idle. Both log through the existing reason-breakdown machinery, and
an over-pressure session that still does not rotate still triggers the `console.warn` from
`spec-rotation-pressure`.

## Invariants

- **Correctness gates remain absolute** (invariant): `isBusy`/`isRotating`/`isResuming` block
  rotation in both windows. Neither window can rotate or stop a session that is mid-turn.
- **Rotation safety comes from `runExclusiveRotation`** (invariant): both windows rotate
  **only** via `rotateSessionHistory`/`runExclusiveRotation`, whose synchronous
  `activeSessions` + `isBusy` + **`resumeInProgress`** triple-check runs before the claim is
  taken. Neither window may call `performRotation` directly or otherwise bypass that check.
- **No stop-vs-dispatch race** (invariant): `stopIfIdle` performs its busy check and its
  `activeSessions.delete` in one synchronous block, so a dispatch can never begin between
  them; a busy session is skipped, never torn down. This protects the in-flight *turn*; the
  *file* is protected by the invariant above.
- **Quiet trigger is idle-armed and fire-gated** (invariant): the quiet window arms on
  `dispatchState`'s `'idle'` event and re-checks `getActiveCount() === 0` when the timer
  fires; it never assumes a cancel-on-start signal, which does not exist.
- **Pressure-only reach** (invariant): both windows consider **only** sessions at/above
  `pressureBytes`. Sessions below the ceiling see byte-identical behavior to today, including
  the unchanged 60 s boot sweep and 4 h interval sweep.
- **Verify-before-swap untouched** (invariant): every guarantee of `spec-history-rotation`
  holds — the live file is replaced only by a candidate that passed a real isolated SDK load,
  a failure leaves it byte-identical, `session.start` is retained, archive-append precedes the
  swap, and the pre-swap re-`statSync` aborts on `concurrent-write`.
- **`onAllIdle` is not repurposed** (invariant): the quiet window uses `dispatchState`'s
  `'idle'` event; `restart-manager`'s single-slot restart-only callback is never registered a
  second time.
- **Silence is impossible** (invariant, inherited): both windows log a reason breakdown and
  warn on an over-pressure non-rotation.

## Considerations

- **Boot-pass delay (3 s)** is not a correctness device — the properties that make boot safe
  (empty `activeSessions`, correctness gates) hold immediately. It exists only so the pass
  never competes with the listen path for I/O on a cold cache. **It is also a real
  precondition**: if the user sends a message within those 3 s, the session begins resuming,
  `resumeInProgress` is set, and the pass correctly declines. Rotation then waits for the next
  window. The boot pass is therefore best-effort-but-frequent, not guaranteed-on-every-boot.
- **Verify latency is not "seconds" at this size.** The isolated verify performs a full SDK
  load of a ~444 MiB history — the measurement that motivated rotation in the first place put
  a 505 MB cold load at ~4 s, and rotation additionally reads and rewrites the file, so a
  realistic expectation is **~5–15 s**. The block is on the **first message** to that session
  (resume awaits the claim), not on merely viewing the list. Users should see the existing
  `[RESUME] Waiting for in-progress rotation of …` log; surfacing a client-side "maintenance"
  indicator is desirable but out of scope here.
- **Quiet window and laptop sleep**: a suspended machine looks idle. Harmless — the pass is
  bounded work on ≤1 session and every correctness gate still applies on wake.
- **The cooldown still applies.** A failed rotation stamps `lastRotateAttemptAt`, so a
  repeatedly-failing session backs off for an hour rather than re-verifying on every window.
- **This does not fix startup discovery.** Discovery reads whole files to extract `events[0]`
  (`readSessionEventsResult`), so it would still read every byte of a *rotated* file. Rotating
  the 443.8 MiB session removes ~400 MB from that read (≈59% of 749 MiB today) and fixes cold
  resume for it, but the unbounded-read defect is a **separate fix**, tracked separately.
- **Why not just lower `minIdleAgeMs` globally?** It is a real coldness proxy for the general
  sweep. Overriding it only for pressure candidates, where coldness is established by a
  stronger signal (empty `activeSessions` at boot, or a measured quiet period), keeps the
  general policy intact.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Boot pass rotates the session the user is opening right now | `resume()` already awaits the rotation claim — the click is delayed, never corrupted; bounded by the verify (seconds) |
| Quiet pass tears down a turn that just started | `stopIfIdle`'s synchronous check-and-delete makes the interleave impossible; busy → skipped, not stopped |
| Boot pass slows startup | Runs after listen, off the critical path, on ≤1 session; unref'd timer |
| A wedged session re-verifies every window | Existing 1 h cooldown stamped before the expensive work |
| Quiet timer keeps the process alive | Timer is `unref()`'d like the existing sweeper timers |
| Scope creep into general rotation policy | Both windows hard-filter to ≥ `pressureBytes` before any other work |

## Acceptance

- Observable: after a restart in which the user does **not** send a message within the boot
  delay, the 443.8 MiB session rotates without any manual action, freeing ~400 MB;
  `events-archive.jsonl` appears; `lastRotatedAt` is stamped; the session still opens and its
  recent history is intact. If a message *is* sent first, the pass correctly declines
  (`resumeInProgress`/`active`) and the `console.warn` from `spec-rotation-pressure` reports
  the over-pressure non-rotation — the next window retries.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client, check:specs.
- Oracles:
  - **boot pass ignores bootExclude + idle-age for pressure candidates** — an over-pressure
    session that IS the `bootExcludeId` and has a fresh `lastIdleAt` still rotates; an
    under-pressure session with the same properties does **not** (unchanged).
  - **boot pass is pressure-only** — sessions below `pressureBytes` are never passed to
    `autoRotateIfEligible` by this pass (assert not-called), so the general sweep's policy is
    untouched.
  - **rotation never bypasses the liveness triple-check** — both windows reach
    `runExclusiveRotation`; a session that is active, busy, **or has `resumeInProgress` set**
    is refused. Explicitly assert the `resumeInProgress` case: a resume begun *after*
    `stopIfIdle`'s delete but *before* the claim is taken causes the rotation to be refused
    (the file is never rewritten under the loading session), rather than proceeding.
  - **`stopIfIdle` atomicity** — returns `false` and performs **no** `activeSessions` mutation
    and **no** `disconnect` when the session is busy; when idle it removes the session from
    `activeSessions` **before** awaiting `disconnect` (assert by observing `isActive === false`
    from inside a `disconnect` that has not yet resolved).
  - **quiet window trigger** — the pass runs only after `CACO_ROTATE_QUIET_MS` from the last
    `'idle'`; the timer is single (re-arming replaces it) and unref'd; **when the timer fires
    while a dispatch is active the pass aborts** (fire-time `getActiveCount()` gate), since no
    cancel-on-start event exists.
  - **quiet window rotates a loaded-but-idle over-pressure session** — the session is stopped
    exactly once via `stopIfIdle`, then rotated; a **busy** one is neither stopped nor rotated.
  - **swap safety preserved in both windows** — with the pressure override active, a verify
    failure still leaves the file byte-identical and a concurrent write still aborts the swap.
  - **`onAllIdle` untouched** — the restart callback registered by `server.ts` is still the one
    invoked on restart (no second registration).

## Plan

Delivered in **two slices**, A first and validated on the real 443.8 MiB session before B.
Window A is the low-risk primary fix and alone resolves the observed case; Window B adds a new
teardown + watcher surface and is only worth its risk once A is proven.

**Slice A — boot pressure pass**

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| A1 | `sweepPressureOnly(deps)`: pressure-filtered sweep reusing `autoRotateIfEligible` with `minIdleAgeMs: 0` and no `bootExcludeId`. Prefilter by `statSync` size **before** calling `autoRotateIfEligible` (so sub-pressure sessions are provably never passed); share the existing `sweeping` overlap guard so it cannot run concurrently with the general sweep | `src/session-history-rotation.ts` | pressure-only (assert not-called for sub-pressure) + reason-breakdown + overlap-guard oracles | pressure-only-reach |
| A2 | Boot pressure pass wired into `startRotationSweeper` (default 3 s, `CACO_ROTATE_BOOT_PRESSURE_MS`, unref'd), ahead of the unchanged 60 s sweep | `src/session-history-rotation.ts`, `server.ts` | boot-pass oracles; liveness-triple-check oracle | correctness-absolute, runExclusiveRotation-not-bypassed |
| A3 | Full gate + validate on the real session | `npm run build` | green; session rotates, archive written, history intact | — |

**Slice B — quiet-period window** (only after A is validated in production)

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| B1 | `SessionManager.stopIfIdle` — synchronous busy-check + `activeSessions.delete` before any await; returns false when busy | `src/session-manager.ts` | `stopIfIdle` atomicity oracle | no-stop-vs-dispatch-race |
| B2 | Quiet watcher on `dispatchState.on('idle')`: single unref'd re-armable timer (`CACO_ROTATE_QUIET_MS`, default 15 min) + **fire-time `getActiveCount()===0` gate** → `sweepPressureOnly` with `stopIfIdle` for loaded candidates | `src/session-history-rotation.ts`, `server.ts` | quiet-window trigger + loaded-but-idle oracles | quiet-trigger-idle-armed, onAllIdle-untouched |
| B3 | Full gate | `npm run build` | green | — |

## Rationale

`spec-rotation-pressure` fixed *eligibility*; this fixes *opportunity*. They are genuinely
different failures, which is why the first change alone left the file at 443.8 MiB. The
insight that makes this cheap is that **boot already satisfies every precondition rotation
needs** — lazy resume means nothing is active, no client has subscribed, and the resume path
already serializes against the rotation claim — so the only work is to stop *excluding* the
one session that needs it. The quiet window then covers long-lived servers, and the single
genuinely dangerous step there (stopping a loaded session) is made safe not by a narrower
check but by moving the `activeSessions.delete` into the same synchronous block as the busy
check, which removes the interleave entirely rather than shrinking it.
