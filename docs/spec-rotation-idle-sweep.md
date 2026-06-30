# Rotation Idle-Sweep Spec

Add a reliable background trigger for history rotation (`docs/spec-history-rotation.md`) so big sessions get rotated when they're genuinely cold — not only on the incidental `stop()` edges (eviction/delete/changeCwd). Trigger: **once on boot + every 4 hours**.

## Why

Phase 2 auto-rotation today fires only at the end of `SessionManager.stop()`. Those edges are unreliable — a session you finish and close the tab on may never be evicted, so it's never rotated. A periodic sweep discovers eligible sessions directly, independent of any edge.

## The "currently viewed" signal (new gate)

A session is *viewed* iff some connected client has it subscribed. The runtime already tracks this in `sessionSubscribers: Map<sessionId, Set<WebSocket>>` (`routes/websocket.ts`): a client is added on `subscribe`, removed on switching away or WS close. Viewed = the set exists and is non-empty.

We must NOT rotate a session a client is actively looking at (idle but on-screen). This is distinct from SDK-active (`activeSessions`) and from observed/unobserved.

### Ownership / no-cycle refactor

`sessionSubscribers` lives in `websocket.ts`, which imports `session-manager`; rotation importing `websocket.ts` would cycle. **Extract subscriber tracking into a new leaf module `src/session-viewers.ts`**:
- Owns the `sessionSubscribers` map (moved out of websocket.ts).
- Exports `addViewer(sessionId, ws)`, `removeViewer(sessionId, ws)`, `getViewers(sessionId): Set<WebSocket> | undefined`, and `isSessionViewed(sessionId): boolean`.
- `websocket.ts` imports these instead of owning the map (its `broadcastEvent` subscriber lookup uses `getViewers`).
- No imports of session-manager/rotation ⇒ leaf module, importable by both. (Verified: `sessionSubscribers` has no other consumers.)

`isSessionViewed` becomes the default for a new injectable `isViewed` gate on `autoRotateIfEligible` (mirrors the existing `isUnobserved` seam), so BOTH triggers (the `stop()` hook and the sweep) respect "don't rotate a viewed session".

## Eligibility (unchanged chokepoint + sweep-only coldness gate)

The sweep does NOT re-implement gates. It calls the existing `autoRotateIfEligible(sessionId, opts)`, which enforces (cheapest-first): `CACO_ROTATE_AUTO` enabled (default on; `=0` disables) → observed → **viewed (new)** → **cheap not-blocked pre-check (new)** → size ≥ threshold → cooldown → then `rotateSessionHistory`'s exclusivity lock (not active/busy/resuming/rotating) + saving threshold + real-SDK verify-before-swap.

Two gate refinements forced by review:

1. **Cheap not-blocked pre-check BEFORE writing `lastRotateAttemptAt`.** `autoRotateIfEligible` currently records the attempt timestamp before calling `rotateSessionHistory`; if the lock then refuses an active/busy/rotating session, that session is wrongly cooled down for 1 h. Fix: before writing the attempt stamp, skip (return null without stamping) if `sessionManager.isActive(id) || isBusy(id) || isRotating(id) || isResuming(id)`. The lock remains the authoritative guard; this just avoids a spurious cooldown. Requires a public `SessionManager.isResuming(id)` (reads `resumeInProgress`) alongside existing `isActive`/`isBusy`/`isRotating`.

2. **Sweep-only minimum-idle-age gate.** "Not unobserved and not viewed" is too broad to mean "genuinely cold" — it admits sessions with no idle metadata or merely-not-currently-subscribed sessions. For the **sweep path only**, require `meta.lastIdleAt` present, `lastObservedAt >= lastIdleAt` (already seen), and `now - lastIdleAt >= CACO_ROTATE_MIN_IDLE_AGE_MS` (default 4 h). Passed as `opts.minIdleAgeMs` (default 0 for the `stop()` path, which keeps its existing behavior). This is the primary defense against the boot/opening race — a session a user is about to open is almost never one idle 4 h+.

## "viewed" must be liveness-aware

`isSessionViewed` = the subscriber set has at least one socket **whose `readyState === OPEN`**. A leaked/half-dead socket must not pin a session as viewed forever (which would permanently block rotation). `getViewers`/`isSessionViewed` purge non-OPEN sockets (and delete the set when it empties); `broadcastEvent` likewise iterates only OPEN sockets. `removeViewer` centralizes set-empty cleanup. Multiple live viewers of one session are preserved; removing one viewer never removes the others.

## Operation: `sweepRotateEligible(deps)` (in `session-history-rotation.ts`)

1. If auto-rotate is disabled (`CACO_ROTATE_AUTO=0`) return immediately (no logging churn).
2. Snapshot candidate ids via a **public** accessor — `sessionCache` is private, so add `SessionManager.knownSessionIds(): string[]` (returns `Array.from(this.sessionCache.keys())`) and use it. (Do NOT reach into the private field; it won't compile.)
3. Optionally exclude `bootExcludeId` (see Boot timing).
4. **Sequentially** (never parallel — one isolated verify client at a time) `await autoRotateIfEligible(id, { minIdleAgeMs })` for each. Defensively try/catch per id and continue; tally `{ scanned, rotated, savedBytes }`.
5. Log one summary line: `[ROTATE-SWEEP] scanned=N rotated=M freed=X MB`.

Sequential is fine at a 4 h cadence; it bounds memory/CPU to a single rotation at a time and avoids competing isolated SDK clients.

## Re-check viewed/blocked immediately before the swap

`performRotation` already re-stats the live file before the swap to catch a concurrent **write** (a resume that wrote new events). That does NOT catch a resume that is mid-flight read-only, or a client that just subscribed during the multi-second verify. Add a final guard right before the rename swap: re-evaluate `isViewed(sessionId)` (and the not-blocked pre-check) and **abort with reason `became-viewed`** (discard candidate, original untouched) if the session became viewed/active/resuming during verify. `isViewed` is injected into `performRotation` deps (default `isSessionViewed`), mirroring the existing `verify`/`preserveModel` seams. This shrinks the viewed-vs-rotate window from "the whole verify" to "a few ms around the atomic swap".

## Triggers / lifecycle

Owned by a small controller started from `server.ts` after `sessionManager.init()` (so the cache + models exist) and after WebSocket setup (so `session-viewers` is wired):

- **Boot sweep:** schedule once, **delayed ~60 s** after boot. The delay lets reconnecting clients re-`subscribe` so their on-screen sessions register as viewed before the sweep reads `isSessionViewed` (otherwise everything looks unviewed at t=0). Additionally pass `bootExcludeId = sessionState.preferences.lastSessionId` so the session the UI auto-opens on load is never rotated out from under the imminent resume.
- **Periodic sweep:** `setInterval(4 h)`. `timer.unref()` so it never keeps the process alive; clear on shutdown.
- Both call the same `sweepRotateEligible`. Guard against overlap with a module-level `sweeping` boolean (a 4 h period can't realistically overlap, but the boot+interval pair could if a sweep ran long).

`CACO_ROTATE_SWEEP_INTERVAL_MS` (default 4 h), `CACO_ROTATE_BOOT_DELAY_MS` (default 60 s), and `CACO_ROTATE_MIN_IDLE_AGE_MS` (default 4 h, sweep-only coldness gate) for tuning/tests. The whole feature is ON by default; set `CACO_ROTATE_AUTO=0` to disable.

## Correctness / safety

- Every existing rotation safety property holds unchanged (verify-before-swap, auto-revert, lock, crash recovery). The sweep is pure discovery + the viewed and min-idle-age gates.
- **Boot / opening-session race (primary concern).** UI activation does `/resume` *then* subscribes (via `historyLoader.load()`), so a session being opened is briefly neither `resumeInProgress` nor viewed. Defenses, in depth: (1) the **min-idle-age gate** — the sweep only considers sessions idle ≥ 4 h, and a session a user is opening is almost never that stale; (2) the **60 s boot delay** + `bootExcludeId = preferences.lastSessionId`; (3) the **pre-swap re-check** of viewed/blocked, which aborts if `/resume` or a subscribe lands during verify; (4) the lock + `resumeInProgress` handoff (synchronous, no gap) means a resume that does win is correctly serialized against the rotation. Worst residual case: a user opens a 4 h-idle session in the exact ms window around the swap — outcome is a slightly delayed open against a *faster* (never broken) file. Acceptable.
- **Viewed-vs-rotate race:** narrowed to the pre-swap re-check window (a few ms); a subscribe just after that still resumes the post-swap file safely under the lock.
- **Stale-socket stickiness:** prevented by liveness-aware `isSessionViewed` (OPEN-only).
- **Quadrants (observed × viewed)** — only `observed && !viewed && idle≥4h` rotates; `unobserved` (unread result) and `viewed` (on-screen) are both skipped. The min-idle-age gate removes the previously-too-broad "no idle metadata / merely-unsubscribed" cases.
- Swarm/agent sessions: excluded from unobserved semantics and size/lock-guarded; a transient agent session won't meet threshold/age. No special case.

## Tests

- `sweepRotateEligible`: returns early when disabled (`CACO_ROTATE_AUTO=0`); iterates `knownSessionIds()` and calls the (injected) `autoRotateIfEligible` per id; tallies; never throws if one id throws.
- `isViewed` gate on `autoRotateIfEligible`: a viewed session short-circuits to null before size/stat (injected `isViewed: () => true`).
- **min-idle-age gate:** a session idle < age is skipped; a session with no `lastIdleAt` is skipped; idle ≥ age + observed passes (sweep path); `minIdleAgeMs=0` (stop path) ignores age.
- **no spurious cooldown:** an active/busy/rotating/resuming session does NOT get `lastRotateAttemptAt` written (cheap pre-check returns before the stamp).
- **pre-swap re-check:** `performRotation` with an injected `isViewed` that flips to true during verify aborts with `became-viewed`, original byte-identical, candidate discarded.
- `session-viewers`: add/remove/isSessionViewed semantics; multiple viewers; removing one keeps others; empty set ⇒ not viewed; **non-OPEN socket purged** ⇒ not viewed; WS-close removal.
- Sequential guarantee: a sweep over multiple eligible ids awaits each (no overlap) — the injected rotate fn is never re-entered.
- Boot exclude: `bootExcludeId` is skipped even when otherwise eligible.

## Out of scope

- No UI. (Manual `POST /rotate` already exists; a session-list affordance is a separate follow-up.)
- No change to the cut point, archive, or verify mechanism.
- Default is `CACO_ROTATE_AUTO` ON; set `=0` to disable. Enabled after coherence + dogfood validation.
