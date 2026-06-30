# Rotation Idle-Sweep Spec

Add a reliable background trigger for history rotation (`spec-history-rotation.md`) so big sessions get rotated when genuinely cold — not only on incidental `stop()` edges. Trigger: once on boot (delayed 60 s) + every 4 hours.

## Goals

Phase 2 auto-rotation today fires only at `SessionManager.stop()` edges — unreliable because a session closed via tab-close may never be evicted. A periodic sweep discovers eligible sessions directly, independent of any edge, so mega-sessions are rotated automatically once they are confirmed cold, idle, and unobserved.

## Design

**`session-viewers` module** (`src/session-viewers.ts`): extract `sessionSubscribers: Map<sessionId, Set<WebSocket>>` from `websocket.ts` into a new leaf module. Exports `addViewer`, `removeViewer`, `getViewers`, `isSessionViewed(sessionId): boolean`. `isSessionViewed` = subscriber set has ≥ 1 socket with `readyState === OPEN` (non-OPEN sockets are purged on access). `websocket.ts` imports `session-viewers` instead of owning the map. No import cycle: `session-viewers` has no imports of `session-manager` or `session-history-rotation`.

**`sweepRotateEligible(deps)** (in `src/session-history-rotation.ts`):
1. If `CACO_ROTATE_AUTO=0`, return immediately.
2. Snapshot candidate ids via `SessionManager.knownSessionIds()` (new public accessor: `Array.from(this.sessionCache.keys())`).
3. Optionally exclude `bootExcludeId`.
4. **Sequentially** `await autoRotateIfEligible(id, { minIdleAgeMs })` per id; try/catch per id; tally `{ scanned, rotated, savedBytes }`.
5. Log summary: `[ROTATE-SWEEP] scanned=N rotated=M freed=X MB`.

Sequential is required — one isolated verify client at a time; bounds memory/CPU.

**Eligibility gates in `autoRotateIfEligible` (cheapest-first):** `CACO_ROTATE_AUTO` → `isUnobserved` → **`isViewed` (new)** → **cheap not-blocked pre-check** (skip and do NOT write `lastRotateAttemptAt` if `isActive || isBusy || isRotating || isResuming`) → size ≥ threshold → cooldown → `rotateSessionHistory`'s exclusivity lock.

**Sweep-only `minIdleAgeMs` gate:** for the sweep path only, require `meta.lastIdleAt` present, `lastObservedAt >= lastIdleAt` (already seen), and `now - lastIdleAt >= CACO_ROTATE_MIN_IDLE_AGE_MS` (default 4 h). Passed as `opts.minIdleAgeMs` (default 0 on the `stop()` path). Primary defense against the boot/opening race.

**Pre-swap re-check:** right before the rename swap in `performRotation`, re-evaluate `isViewed(sessionId)` and the not-blocked pre-check; abort with reason `became-viewed` if either fires. `isViewed` is injected into `performRotation` deps (default `isSessionViewed`).

**Lifecycle controller** (started from `server.ts` after `sessionManager.init()` and WS setup):
- **Boot sweep:** delayed `CACO_ROTATE_BOOT_DELAY_MS` (default 60 s); passes `bootExcludeId = preferences.lastSessionId`.
- **Periodic sweep:** `setInterval(CACO_ROTATE_SWEEP_INTERVAL_MS)` (default 4 h); `timer.unref()`.
- Module-level `sweeping` boolean guards against overlap.

Config: `CACO_ROTATE_SWEEP_INTERVAL_MS` (default 4 h), `CACO_ROTATE_BOOT_DELAY_MS` (default 60 s), `CACO_ROTATE_MIN_IDLE_AGE_MS` (default 4 h). Whole feature is ON by default; set `CACO_ROTATE_AUTO=0` to disable.

## Invariants

- Every existing rotation safety property holds unchanged (verify-before-swap, auto-revert, lock, crash recovery).
- A viewed session (subscriber with `readyState === OPEN`) is never rotated.
- A non-OPEN (leaked/half-dead) socket never permanently pins a session as viewed.
- `autoRotateIfEligible` does not write `lastRotateAttemptAt` for sessions blocked by the not-blocked pre-check — no spurious cooldown.
- The sweep is always sequential; isolated verify clients never run in parallel.

## Considerations

- **Boot/opening-session race:** UI activation does `/resume` then subscribes; a briefly-neither-resuming-nor-viewed session could be caught. Defenses in depth: (1) min-idle-age gate (4 h); (2) 60 s boot delay + `bootExcludeId`; (3) pre-swap re-check of viewed/blocked; (4) lock + `resumeInProgress` handoff. Worst case: user opens a 4 h-idle session in the exact ms window around the swap — outcome is a slightly-delayed open against a faster (never broken) file.
- **Viewed-vs-rotate race:** narrowed to the pre-swap re-check window (a few ms); a subscribe just after that resumes the post-swap file safely under the lock.
- **Stale-socket stickiness:** prevented by OPEN-only `isSessionViewed`; non-OPEN sockets are purged on `getViewers`/`isSessionViewed`/`removeViewer`.
- Multiple live viewers of one session are preserved; removing one never removes the others.
- Swarm/agent sessions: excluded by size/lock gates; transient agent sessions won't meet threshold/age.
- No UI for sweep; the manual `POST /rotate` route already exists.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Session rotated while user is about to open it | min-idle-age gate (4 h) + 60 s boot delay + `bootExcludeId` + pre-swap re-check aborts on viewed/resuming |
| Leaked WS socket pins session as viewed forever | OPEN-only `isSessionViewed`; non-OPEN sockets purged on access |
| Spurious cooldown on blocked sessions | Cheap not-blocked pre-check returns before writing `lastRotateAttemptAt` |
| Import cycle: rotation → websocket → session-manager → rotation | `session-viewers` is a leaf module with no reverse imports; both `websocket.ts` and `session-history-rotation.ts` import it |
| Boot sweep runs before clients re-subscribe | 60 s boot delay + `bootExcludeId` + pre-swap re-check |

## Acceptance

- Observable: after boot (60 s delay), eligible sessions (idle ≥ 4 h, not viewed, size ≥ threshold) are rotated automatically; log line `[ROTATE-SWEEP] scanned=N rotated=M freed=X MB` appears; viewed sessions are not rotated; `CACO_ROTATE_AUTO=0` disables all sweeps.
- Budgets: sweep is sequential; no burst of parallel SDK clients.
- Gates: `npm run build` green; `tests/unit/session-viewers.test.ts` green; `tests/unit/session-history-rotation.test.ts` (sweep tests) green.
- Oracles:
  - `sweepRotateEligible` returns early when `CACO_ROTATE_AUTO=0` (`session-history-rotation.test.ts`).
  - Injected `autoRotateIfEligible` called per id; one throw doesn't abort the sweep (`session-history-rotation.test.ts`).
  - Injected `isViewed: () => true` short-circuits before size/stat (`session-history-rotation.test.ts`).
  - Session idle < `minIdleAgeMs` is skipped; no `lastIdleAt` is skipped (`session-history-rotation.test.ts`).
  - Active/busy/rotating/resuming session does NOT get `lastRotateAttemptAt` written (`session-history-rotation.test.ts`).
  - `performRotation` with injected `isViewed` flipping to `true` during verify → `became-viewed` abort, original byte-identical (`session-history-rotation.test.ts`).
  - `isSessionViewed`: add/remove/multiple viewers/empty=not-viewed/non-OPEN purged (`session-viewers.test.ts`).
  - Boot exclude: `bootExcludeId` skipped even when otherwise eligible (`session-history-rotation.test.ts`).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Extract `session-viewers` leaf module | `src/session-viewers.ts`, `src/routes/websocket.ts` | add/remove/OPEN-only semantics — `session-viewers.test.ts` | No import cycle |
| 2 | Add `isViewed` gate + cheap not-blocked pre-check to `autoRotateIfEligible` | `src/session-history-rotation.ts` | viewed session skips; blocked doesn't get cooldown stamp — unit | No spurious cooldown |
| 3 | Add `minIdleAgeMs` gate (sweep-only) | `src/session-history-rotation.ts` | idle < age skipped; no `lastIdleAt` skipped; `minIdleAgeMs=0` passes — unit | Defends boot race |
| 4 | Pre-swap re-check of viewed/blocked in `performRotation` | `src/session-history-rotation.ts` | injected `isViewed` flips → `became-viewed` abort, original intact — unit | Viewed never rotated |
| 5 | `SessionManager.knownSessionIds()` + `isResuming(id)` accessors | `src/session-manager.ts` | returns `sessionCache` keys / reads `resumeInProgress` — by-construction | - |
| 6 | `sweepRotateEligible` function | `src/session-history-rotation.ts` | disabled early; iterates + tallies; one throw doesn't abort — unit | Sequential only |
| 7 | Lifecycle controller (boot + periodic sweeps) in `server.ts` | `src/server.ts` | by-construction (integration) | Boot delay; `timer.unref()` |
