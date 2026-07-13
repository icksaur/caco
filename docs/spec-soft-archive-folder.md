# spec-soft-archive-folder

## Goals

Stop disowned herd children (and any session the user parks) from polluting the
root session list forever. A session tagged into a reserved **`auto-archive`**
folder that then sits idle past a threshold (default **24h**) is automatically
archived (the existing reversible export-and-remove), clearing it from the active
list. `caco_herd` **disown** auto-tags the child into `auto-archive`, so a large
herd's leftovers drain themselves after a day-long observation window — with the
user free to rescue any of them (move out of the folder) or clean up early.

## Design

**Two stages: soft (tag) then hard (reap).**

**Stage 1 — soft tag (instant, reversible by moving out).** `auto-archive` is an
ordinary single-level session folder (`SessionMeta.folder`, `folder.ts` validation
— `auto-archive` is valid: letters + dash). Nothing special about the folder except
that the reaper watches it. `caco_herd disown` now sets the child's
`folder = 'auto-archive'` in the same `updateSessionMeta` that clears
`orchestratedBy` — **a deliberate contract change** (see Invariants). Entering the
folder (via disown OR a manual move-in through the PATCH route) also stamps
`SessionMeta.autoArchiveTaggedAt = Date.now()` — the **schedule anchor** that starts
the grace window fresh, independent of any stale pre-existing `lastIdleAt` (a child
already idle >24h before disown must still get the full post-disown window). The
user (or the agent) can drop any session there manually to schedule it, and moving
it out before the reaper fires cancels archival. **`caco_herd acquire` clears the
tag**: re-parenting a parked session sets `orchestratedBy` AND, if it was in
`auto-archive`, moves it out (clears `folder` + `autoArchiveTaggedAt`) so a
reacquired child is never left scheduled for archival.

**Stage 2 — hard reap (periodic, reversible via import).** A low-frequency sweep
(`SessionManager`, a dedicated timer alongside the existing health-check lifecycle)
archives every session that `isAutoArchiveEligible`:

- `folder === 'auto-archive'`, AND
- **quiescence age** `now - anchor(meta) > AUTO_ARCHIVE_IDLE_MS` (default 24h), where
  `anchor = max(autoArchiveTaggedAt, lastUsedAt, lastIdleAt, <creation>)` — the most
  recent of "when it was parked" and "any activity since". The tag time guarantees
  the ≥24h post-disown window; later activity (a resume of the parked session)
  pushes the clock forward so an in-use parked session is never archived. Unknown on
  all anchors ⇒ NOT eligible (fail safe), AND
- NOT busy (`isBusy`), AND
- NOT the foreground/active session (`activeSessions.has` / a resume in flight —
  `resumeInProgress`), AND
- NOT a herd member — neither a **parent** (some session has `orchestratedBy === id`)
  NOR a **child** (`meta.orchestratedBy` is set). A re-acquired child is load-bearing
  and must never be archived out from under its parent.

For each eligible id the sweep calls a **reaper-safe archive** (below), reusing the
existing export+delete core (writes `~/.caco/sessions/archive/<id>.caco-session.tar.gz`,
deletes SDK data, removes the caco meta dir; reversible via import). Best-effort: a
failure or a refusal on one id is logged and skipped, never aborts the sweep.

**Reaper-safe archive (exclusive maintenance, not a dispatch claim).** The manual
`archive()` stops an active session and archives it (user-initiated, correct). The
AUTOMATIC reaper must not archive a session that went live between the eligibility
scan and the destructive work, including a **resume in flight** — which is invisible
to `activeSessions` until its multi-second SDK load completes, but is tracked
synchronously by `resumeInProgress` (`session-manager.ts:896-900`). So the reaper
routes through the **existing exclusive-maintenance mutex** that history-rotation
uses (`runExclusiveRotation`), generalized to cover archive: it (1) acquires the
claim (rejected only if the session is already under another maintenance op; a
*future* `resume()` then waits on it, so a resume racing an archive either lost the
race — its `resumeInProgress` is seen by the liveness guard below — or waits and then
finds the session archived, never overlapping the delete); (2) under the claim,
synchronously applies the reaper liveness guard — REFUSE if the session is active,
busy, resume-in-flight, a herd parent, a herd child, no longer folder-`auto-archive`,
or no longer past threshold; (3) runs the export+delete core, releasing the claim at
the end.

This dissolves two subtleties: the reaper liveness guard is evaluated under the
claim (one implementation order — acquire, then guard, then core), and the
maintenance claim is a separate registry that does NOT set dispatch-busy — so
`isBusy` is evaluated at its true value (a competing dispatch), never made true by
the claim itself. **The claim and the liveness policy are separate concerns:**

- The **claim/registry** provides only mutual exclusion — it rejects a session that
  is *already under another maintenance op* (rotation, manual archive, or reaper
  archive), makes a future `resume()` wait on it, and makes eligibility mutations
  refuse while held. It does NOT itself refuse active/busy sessions.
- The **per-path entry policy** (run under the claim) decides liveness tolerance:
  the **reaper** REFUSES an active / busy / resume-in-flight / herd-member session
  (and rechecks folder/age); the **manual** `archive()` ACQUIRES the claim then
  STOPS an active/busy session per its existing semantics and proceeds.

Refactor: extract the export+delete body of `archive()` into a private core; both
paths acquire the shared claim (so the core runs at most once per session) and then
apply their own entry policy; the claim is held across the whole core.

**Eligibility inputs are frozen under the claim.** The maintenance claim is held for
the WHOLE reaper archive (acquire → liveness guard → export → delete → release), and the
eligibility-changing meta mutations — `caco_herd acquire` (sets `orchestratedBy`),
`caco_herd disown` (sets `folder`), and the folder PATCH route (move-out / move-in)
— consult the same maintenance registry and **refuse** while a session is claimed
(clear "session is being archived, retry" error). So no acquire can re-parent a
child, and no rescue move-out can be silently ignored, once the archive core is
under way; the entry-time snapshot of `folder`/`orchestratedBy` therefore stays
valid for the claim's lifetime. A mutation that lands just before the claim is seen
by the entry guard; one that lands during is refused; one that lands after archival
hits a gone session — no window overlaps the async delete.

**Mechanism choices.**
- *Reaper as its own timer*, not folded into `proactiveHealthCheck` (which is a
  connection-health probe): keeps a destructive maintenance action out of a probe
  path, and lets its interval be tuned independently. Started/stopped in the same
  lifecycle as the health timer; runs only while the SDK client is up (archive
  deletes SDK data via the client).
- *Eligibility is a pure function* `isAutoArchiveEligible(meta, ctx, now)` with all
  runtime facts (`isBusy`, `isActive`, `isParent`) injected — the whole decision is
  unit-testable without the SDK, and the sweep is a thin loop over it.
- *Reserved name is a constant* (`AUTO_ARCHIVE_FOLDER = 'auto-archive'`), not a new
  meta field — reuses the folder tag the list already groups by, so it shows up as
  an ordinary (visible, rescuable) folder with no new UI.

## Invariants

- **disown parks the child in `auto-archive`** (contract change, replaces "becomes
  an ordinary session again"): disown clears the herd bond, sets
  `folder = 'auto-archive'`, AND stamps `autoArchiveTaggedAt`. The child is still a
  normal, fully-usable session (can be re-parented, resumed, or moved out); the
  folder is only a soft archival schedule with a ≥24h grace window, so an accidental
  disown is always recoverable. The `caco_herd` disown tool description is updated to
  say so.
- **The grace window is anchored on tag time, not stale idle.** Eligibility uses
  `max(autoArchiveTaggedAt, lastUsedAt, lastIdleAt, creation)`, so a session already
  idle >24h before it enters `auto-archive` still gets a full window from the moment
  it was parked, and any activity after parking pushes the clock forward.
- **Archival is always reversible.** Pre-reap: move the session out of
  `auto-archive`. Post-reap: import the `.tar.gz`. The reaper only ever runs the
  existing export+remove core, never a hard delete.
- **Eligibility inputs are frozen under the maintenance claim.** While the reaper
  holds a session's claim, no eligibility-changing meta mutation (acquire, disown,
  folder PATCH) can run — they refuse — so the entry-time eligibility snapshot cannot
  be invalidated mid-archive (no archived newly-acquired child, no ignored rescue).
- **The export+delete core runs at most once per session.** Both manual and reaper
  archive acquire the same exclusive-maintenance claim, whose sole job is mutual
  exclusion (it rejects a session already under another maintenance op). Liveness is
  a per-path entry policy under the claim, not the claim's job: manual stops an
  active/busy session; the reaper refuses one.
- **The reaper never stops or archives a live/load-bearing session.** Eligibility
  excludes busy / active / resume-in-flight / herd-parent / herd-child, AND the
  reaper-safe path re-checks those at entry under the exclusive-maintenance mutex
  (the same one `runExclusiveRotation` uses, which refuses on `resumeInProgress` and
  makes a future `resume()` wait) — so a session that becomes live after the scan is
  refused, never stopped, and a resume can never overlap the delete. A herd member
  (parent or child) is never archived; a re-acquired child is additionally un-tagged
  on acquire. (Manual `archive()` still stops-then-archives by design.)
- **`auto-archive` is a normal folder.** No special rendering, no reserved-name
  rejection in `folder.ts`; the only special behavior is the reaper's watch.

## Considerations

- **Foreground / liveness detection.** "In use" excludes the loaded set
  (`activeSessions.has`), a resume in flight (`resumeInProgress`, set synchronously
  before the SDK load so the window is closed), and both herd roles. An idle-but-
  loaded session is skipped, which only *delays* archival, never wrongly archives a
  session in use.
- **Idle clock fallback + anchor.** The eligibility anchor is
  `max(autoArchiveTaggedAt, lastUsedAt, lastIdleAt, creation)`. `autoArchiveTaggedAt`
  is set on folder entry; `lastIdleAt`/`lastUsedAt` cover ongoing quiescence; the
  meta creation time is the final fallback. If none is resolvable ⇒ NOT eligible
  (fail safe: never archive on unknown age).
- **Herd-parent guard cost.** "Is this id still a parent?" is answered from the herd
  membership index (`isHerdParent`) or by scanning `orchestratedBy` — O(sessions)
  once per sweep, negligible at this cadence.
- **Manual archive already exists.** The DELETE→`archive()` route is unchanged; this
  feature adds an *automatic* trigger, not a new archive path.
- **Config.** `AUTO_ARCHIVE_IDLE_MS` (default 24h), sweep interval (default ~1h),
  and an on/off flag are configurable (env / preferences); default **on**.

## Risks and Mitigations

- **Archives a session the user was about to return to.** Mitigation: 24h grace +
  visible folder + foreground/active exclusion; and it is import-reversible.
- **disown auto-tag surprises a user who disowned to re-parent.** Mitigation:
  documented in the tool description; the session is unchanged and re-parenting or
  moving it out is immediate; the 24h window means no data is touched meanwhile.
- **Reaper runs without an SDK client (archive would fail).** Mitigation: the sweep
  runs only while the client is up; per-id failures are caught and skipped.
- **A long-idle child archives immediately on disown (no grace).** Mitigation:
  `autoArchiveTaggedAt` re-anchors the clock at parking time, so the ≥24h window is
  measured from disown, not from a stale `lastIdleAt`. Old-child disown oracle.
- **A session goes live between the eligibility scan and the archive.** Mitigation:
  the reaper-safe path routes through the exclusive-maintenance mutex — entry guards
  refuse a session that is active, busy, or resume-in-flight (the last tracked
  synchronously by `resumeInProgress`), and a future `resume()` waits on the claim,
  so a resume can never overlap the delete. It never stops a live session (only
  manual archive does). Race + resume-in-flight oracles.
- **A re-acquired disowned child gets archived under its new parent.** Mitigation:
  eligibility rejects any herd child (`orchestratedBy` set), `caco_herd acquire`
  clears the `auto-archive` tag, AND acquire refuses while the session is under the
  reaper's maintenance claim. Reacquired-child + acquire-during-claim oracles.
- **A rescue move-out races the archive core.** Mitigation: the folder PATCH refuses
  while the session is under the maintenance claim, so a rescue either wins (before
  the claim, seen by the entry guard) or is cleanly refused (during the claim) —
  never silently lost. Move-out-during-claim oracle.
- **Mass-archive thundering herd** (dozens eligible at once after a big run).
  Mitigation: sequential archive with per-id error isolation; optional per-sweep cap
  so one tick can't monopolize the event loop.

## Acceptance

- Observable: after disowning a child it appears in the `auto-archive` folder in the
  session list; ≥24h later (or with a lowered threshold for the demo) the reaper
  removes it from the active list and a `.tar.gz` exists in
  `~/.caco/sessions/archive/`; importing that file restores it. Moving a session out
  of `auto-archive` before the threshold prevents archival.
- Budgets: n/a (one O(sessions) scan per ~1h tick).
- Gates: `tsc` ×2, `lint:strict`, `knip`, `npm test` (coverage thresholds),
  `build:client`, `check:specs` — all green.
- Oracles:
  - **`isAutoArchiveEligible` (hand cases + reference)** — true only when folder ==
    `auto-archive`, quiescence age > threshold, and not busy / not active / not
    resume-in-flight / not herd-parent / not herd-child; false if any condition
    fails; the anchor is `max(autoArchiveTaggedAt, lastUsedAt, lastIdleAt, creation)`
    and unknown ⇒ false. Table of cases vs hand-computed expected booleans
    (independent of the production predicate).
  - **Old-child disown grace (anchor)** — a session with `lastIdleAt` 48h ago that is
    disowned now (`autoArchiveTaggedAt = now`) is NOT eligible until 24h after the
    tag, proving the window is anchored on parking, not stale idle.
  - **Herd-member exclusion** — a session with `orchestratedBy` set (a child) is NOT
    eligible even if folder==`auto-archive` and aged; a parent (someone's
    `orchestratedBy`) is NOT eligible.
  - **disown auto-tag / acquire un-tag** — `caco_herd disown` sets
    `folder='auto-archive'`, stamps `autoArchiveTaggedAt`, clears `orchestratedBy`;
    `caco_herd acquire` of a parked session sets `orchestratedBy` and clears
    `folder`+`autoArchiveTaggedAt` (herd-tools handler tests).
  - **sweep wiring** — given a stubbed session set, the sweep archives exactly the
    eligible ids, skips the rest, and continues past a thrown archive (best-effort).
  - **reaper-safe race + resume-in-flight** — a session that becomes busy/active, OR
    has a resume in flight (`resumeInProgress`), after the scan is REFUSED at the
    maintenance-entry guard (not stopped, no tar.gz written); a still-eligible
    session proceeds through the real claim path to a written archive (the
    proceeding-eligible oracle, exercising that a successful claim does NOT itself
    make the session read as busy and block the archive).
  - **mutation-under-claim** — while a session is under the reaper's maintenance
    claim, `caco_herd acquire`, `disown`, and the folder PATCH all REFUSE; a rescue
    move-out attempted mid-claim is refused (not lost) and an acquire mid-claim
    cannot re-parent the about-to-be-archived session.
  - **manual-vs-reaper serialization** — a manual `archive()` and a reaper archive
    targeting the same session do not both run the core: whichever acquires the
    claim first proceeds, the second is refused/serialized (no double export/delete).
  - **active manual archive still works** — a manual `archive()` of an ACTIVE session
    acquires the claim, stops the session, and completes (the claim serializes but
    does not refuse an active session on the manual path).
  - **reversibility** — a reaped session's `.tar.gz` re-imports to a live session
    (reuse/extend existing import test).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `AUTO_ARCHIVE_FOLDER='auto-archive'`, `AUTO_ARCHIVE_IDLE_MS` (24h), sweep interval + on/off flag to config | `src/config.ts` | constant present; `isValidFolder('auto-archive')===true` | auto-archive-normal-folder |
| 2 | Add `SessionMeta.autoArchiveTaggedAt?: number`; stamp it whenever `folder` is set to `auto-archive` (disown branch + PATCH `/sessions` route folder update) | `src/session-meta-store.ts`, `src/routes/sessions.ts`, `src/herd-tools.ts` | tag-stamp unit (folder→auto-archive sets the timestamp; other folders don't) | grace-anchored-on-tag-time |
| 3 | Pure `isAutoArchiveEligible(meta, { isBusy, isActive, isResuming, isParent, isChild }, now)` with the `max(tagged, used, idle, creation)` anchor | `src/session-archive-reaper.ts` (new pure module), `tests/unit/session-archive-reaper.test.ts` | eligibility hand cases + reference table + old-child-grace + herd-member exclusion | reaper-never-touches-live; grace-anchored-on-tag-time |
| 4 | disown sets `folder='auto-archive'` + stamps tag + clears bond; acquire of a parked session clears `folder`+`autoArchiveTaggedAt`; disown/acquire AND the folder PATCH route refuse while the target is under the reaper's maintenance claim; update disown/acquire tool descriptions | `src/herd-tools.ts`, `src/routes/sessions.ts`, `tests/unit/herd-tools*.test.ts` | disown auto-tag + acquire un-tag + mutation-under-claim units | disown-parks-child; eligibility-frozen-under-claim |
| 5 | Generalize `runExclusiveRotation`'s claim into a shared maintenance registry whose ONLY job is mutual exclusion (reject a session already under maintenance; resume waits; eligibility-mutations refuse) and does NOT refuse active/busy; extract `archive()`'s core; both paths acquire the claim then apply their own entry policy: manual stops-active-then-core, reaper refuses live/busy/resuming/herd + rechecks folder/age; claim held across the whole core | `src/session-manager.ts`, `src/routes/sessions.ts`, `tests/unit/session-manager-*.test.ts` | reaper-safe race + resume-in-flight + proceeding-eligible + manual-vs-reaper serialization + active-manual-archive oracles | reversible; reaper-never-touches-live; eligibility-frozen-under-claim; core-runs-once |
| 6 | Sweep method: iterate `listSessionIds()`, read meta, apply the pure predicate with injected runtime facts (incl. `isResuming`, `isChild`), call the reaper-safe archive per eligible id (sequential, per-id try/catch, optional cap) | `src/session-manager.ts`, `tests/unit/session-manager-*.test.ts` | sweep wiring oracle (archives eligible, skips rest, survives a throw) | reversible; reaper-never-touches-live |
| 7 | Dedicated reaper timer in the health-check lifecycle (start/stop, client-gated, configurable interval) | `src/session-manager.ts` | timer starts/stops with lifecycle (unit) | - |
| 8 | Verify import round-trip restores a reaped session | `tests/unit/*import*.test.ts` (extend) | reversibility oracle | reversible |

## Rationale (optional)

The root cause the user hit is *root-list pollution*: a big herd run leaves dozens
of disowned children cluttering the top level, each requiring manual archive. The
fix leans entirely on machinery that already exists — the free-form `folder` tag and
the reversible `archive()` — adding only a reserved-name convention and a periodic
eligibility sweep. Making disown park children in `auto-archive` turns "clean up
after a herd" from N manual archives into a no-op with a 24h observation window;
keeping the folder a normal, visible, movable tag preserves full user control and
reversibility at every stage. Speed is deliberately not a goal (24h, hourly sweep):
the value is eventual tidiness, not prompt deletion.
