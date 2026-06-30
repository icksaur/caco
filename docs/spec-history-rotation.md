# History Rotation Spec

Make cold-resume of "mega-sessions" sub-second by front-truncating the append-only `events.jsonl`, with SDK-load-verified auto-revert. Telemetry + experiment in `cold-open-latency-findings.md`.

## Goals

Cold-resume of a mega-session (505 MB, 187K lines) takes ~4 s today; 73% is reading `events.jsonl`. After rotation, cold resume targets <1 s. The operation must never corrupt a session: if the truncated file fails an SDK load, it reverts to the original automatically. User messages are retained across the cut so the resumed session's recall is equivalent to the full history.

## Design

**Cut point:** retain `session.start` (line 1) + every `user.message` event + everything from the last `session.compaction_complete` onward. The compaction tail preserves the freshest summary; user messages (~0.1% of bytes) retain cross-turn recall. No compaction event → retain from `MIN_TAIL_EVENTS` back. Skip if file < `ROTATE_THRESHOLD_BYTES` or saving < `MIN_SAVING`.

**Transactional copy-verify-swap** (`rotateSessionHistory` in `src/session-history-rotation.ts`):

1. **Guard + lock:** acquire per-session rotation lock (new `rotatingSession` state in `SessionManager`, honored by `resume`/`send`/`stop`/auto-repair). Session must be inactive. `statSync` size; bail if under threshold/savings. Bail if rotation marker/backup already exists (crash recovery).
2. **Resolve & persist model FIRST** via `readModelFromEvents` semantics (prefer existing `meta.model`; fall back to parsed events). Abort rotation if meta write fails.
3. **Build candidate OUTSIDE the live file:** `events.jsonl.candidate` = `[line0, ...lines.slice(cut)]`. Capture `srcStat` (size+mtime) of the live file.
4. **Verify on a STAGED COPY with an ISOLATED client:** stage throwaway dir (`exp-<id>`); `new CopilotClient(...) → start → resumeSession(stagedId, {suppressResumeEvent:true}) → disconnect → stop` in `finally`. Do NOT use `SessionManager.resume()` or the shared client. On any throw → discard candidate, release lock, return `{ ok:false }`. Live file is byte-untouched.
5. **Swap (atomic, re-checked):** still under lock, re-`statSync` live file; if changed since `srcStat` → abort. Else: append pruned head to `events-archive.jsonl` and fsync; only then `rename(events.jsonl → .prerotate)`, `rename(candidate → events.jsonl)`, delete `.prerotate`. Write cooldown marker to meta. Release lock. Return `{ ok:true, before, after, savedBytes }`.

**Locking:** `SessionManager.rotatingSession: Set<sessionId>`. A resume requested while rotating **waits** for the rotation promise, then proceeds against the swapped file.

**Trigger policy (phased):**
- Phase 1 (manual): `POST /api/sessions/:id/rotate` route. User invokes on a chosen inactive session and validates coherence manually.
- Phase 2 (automatic): `autoRotateIfEligible` (fire-and-forget) at end of `SessionManager.stop()`. `CACO_ROTATE_AUTO` defaults ON after coherence validation.

**Config:** `CACO_ROTATE_THRESHOLD_BYTES=67108864` (64 MB), `CACO_ROTATE_MIN_TAIL_EVENTS=4000`, `CACO_ROTATE_MIN_SAVING_BYTES=33554432` (32 MB), `CACO_ROTATE_AUTO` ON by default.

**Caco-side readers after rotation:**

| Reader | Effect of rotation | Handling |
|---|---|---|
| `parseSessionModel` (reverse-scans for last model_change) | Pre-cut model_change with none after ⇒ wrong model | Step 2 persists model to meta first; `readModelFromEvents` reads meta before parse |
| `readLastTurnsResult` (last 5 turns) | Tail retained | ✓ no change |
| `lastTurnsCache` (size+mtime key) | Both change | ✓ auto-invalidates |
| `searchSessionEvents` | Loses pre-cut history | Extend to also scan `events-archive.jsonl` |
| `readSessionEvents` / `getHistoryFromDisk` (full event read) | Tail-only after rotation | Explicit decision; callers needing full history merge archive+live. Never on the hot resume path. |
| SDK `/rewind` | Pre-cut rewind points lost | Accepted limitation |

**Crash recovery:** write `events.jsonl.rotation` marker (phase + candidate stats) on boot:
- Absent → nothing to do.
- Marker present + `.prerotate` exists → verify current `events.jsonl` via isolated SDK load; if OK: archive/clear `.prerotate`; if bad or absent: restore from `.prerotate`.

**Auto-rotate eligibility gates** (cheapest-first, before spinning the isolated verify client):
1. `CACO_ROTATE_AUTO=1`.
2. Unobserved check (skip if session result is unread — `unobservedTracker.isUnobserved`).
3. Size ≥ threshold.
4. Cooldown — `lastRotatedAt` older than 1 h.
Then `rotateSessionHistory` enforces the exclusivity lock + saving threshold + real-SDK verify-before-swap.

## Invariants

- The live `events.jsonl` is replaced only by a candidate that already passed a real SDK load.
- A rotation that fails at any step leaves the live file byte-identical to the original.
- `session.start` (line 1) is always retained — the SDK requires it.
- Archive append (fsync) precedes the rename swap; archive-append failure aborts the swap.
- Rotation only starts when the session is inactive and not already rotating.
- Meta model is persisted before truncation; if meta write fails, the rotation aborts.

## Considerations

- **Model-loss bug:** a pre-cut `model_change` with none after ⇒ wrong model on the rotated file. Fixed by Step 2 (meta-first persist via `readModelFromEvents` semantics — prefer existing `meta.model`, BYOK provider-namespace preserved).
- **Verify isolation:** verification uses a separate short-lived `CopilotClient` against a staged copy, fully stopped in `finally` — never the server's `sharedClient` (which would register the session in `activeSessions`/client map).
- **Archive over-count after crash-then-retry (accepted):** pruned head is fsync-appended before swap; a crash+retry re-appends the same head — `searchSessionEvents` may over-count. Duplication in non-authoritative search is safer than data loss.
- **Archive growth:** cold data moved off the hot path. Optional later: compress archives.
- **SDK `/rewind`:** pre-cut event IDs are lost; accepted, like old search results.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Soft context loss (model forgets pre-cut context) | Retain from last `compaction_complete` + all user messages; Phase 2 gate: probe-message coherence vs full-history baseline before enabling automation. |
| Corrupt `events.jsonl` after crash mid-swap | `.prerotate` kept until archive fsynced + swapped file passes real load; crash recovery restores from `.prerotate`. |
| Concurrent write between srcStat capture and swap | Re-`statSync` live file before rename; abort if changed. |
| BYOK compaction summarization routes through user's provider (unverified) | Note in spec; failure surfaces as normal resume error + rollback. |
| `searchSessionEvents` loses pre-cut history | Extend to scan `events-archive.jsonl`; non-critical data retained in archive. |

## Acceptance

- Observable: `POST /api/sessions/:id/rotate` on a mega-session returns `{ ok:true, before, after, savedBytes }`; subsequent cold resume completes in <1 s; a memory probe on the resumed session recalls pre-rotation goals and context.
- Budgets: cold-resume < 1 s after rotation (vs ~4 s before).
- Gates: `npm run build` green; `tests/unit/session-history-rotation.test.ts` green; `tests/unit/session-manager-rotation-lock.test.ts` green.
- Oracles:
  - Cut-point selection (compaction present/absent/too-near-head/below-threshold) — table-driven, no SDK (`session-history-rotation.test.ts`).
  - Stub "loader" throws → live `events.jsonl` byte-identical, no `.prerotate` left (`session-history-rotation.test.ts`).
  - Concurrent-write guard: stat changes → rotation aborts, original intact (`session-history-rotation.test.ts`).
  - Rotation lock: resume waits for rotation promise then sees swapped file; rotation refused on active/dispatching session (`session-manager-rotation-lock.test.ts`).
  - BYOK provider-prefixed `meta.model` preserved after rotation; abort if meta write fails (`session-history-rotation.test.ts`).
  - Archive-append failure → swap aborted, original intact (`session-history-rotation.test.ts`).
  - Crash recovery: `.prerotate` + bad `events.jsonl` → restored; + good `events.jsonl` → archived/cleared (`session-history-rotation.test.ts`).
  - `searchSessionEvents` finds a pruned-head match via archive (`session-history-rotation.test.ts`).
  - Real-SDK integration (manual/opt-in, not CI): rotate a copy of a mega-session, assert resume <1 s and probe reply requiring pre-cut knowledge is coherent.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Cut-point selection + candidate build | `src/session-history-rotation.ts` | table-driven cut-point tests — `session-history-rotation.test.ts` | `session.start` always retained |
| 2 | Persist model to meta before truncation (Step 2) | `src/session-history-rotation.ts`, `src/session-meta-store.ts` | BYOK model preserved; abort if meta write fails — unit | Meta write must succeed |
| 3 | Isolated-client verify-before-swap | `src/session-history-rotation.ts` | stub-throws → live file byte-identical — unit | Replace only verified candidate |
| 4 | Atomic swap with re-stat + archive-append-fsync | `src/session-history-rotation.ts` | concurrent-write guard aborts; archive-append failure aborts — unit | Archive fsync precedes rename |
| 5 | Rotation lock in `SessionManager` | `src/session-manager.ts` | resume waits; rotation refused on active session — `session-manager-rotation-lock.test.ts` | Active/rotating exclusion |
| 6 | Crash recovery (phase marker + `.prerotate`) | `src/session-history-rotation.ts` | pre-seeded marker scenarios — unit | `.prerotate` not deleted until verified |
| 7 | Phase 1 manual route `POST /rotate` | `src/routes/sessions.ts` | by-construction (manual validation) | - |
| 8 | Phase 2 `autoRotateIfEligible` at `stop()` | `src/session-manager.ts`, `src/session-history-rotation.ts` | eligibility gates fire before SDK spin-up; `CACO_ROTATE_AUTO=0` disables — unit | `CACO_ROTATE_AUTO` gate |
| 9 | `searchSessionEvents` archive fallback | `src/session-history-rotation.ts` | pruned-head match found via archive — unit | - |

## Empirical Basis

| Retained | Size | Resume | OK |
|---|---|---|---|
| full | 505 MB | 4381ms | ✓ |
| start + last compaction_complete→end | 3.2 MB | **40ms** | ✓ |
| start + last 5 turns | 1.4 MB | 29ms | ✓ |
| tail only, NO session.start | 5 MB | — | ✗ "corrupted or incompatible" |

`session.start` is mandatory. SDK throws cleanly on a bad file ⇒ auto-revert is reliable. Phase 2 gate: user-message-retaining cut matched full 428 MB history on a memory probe; bare last-compaction cut recalled none of the early goals.
