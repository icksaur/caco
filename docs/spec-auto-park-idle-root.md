# spec-auto-park-idle-root

## Goals

Keep the root session list from accumulating forever. Three paths currently
put a session into `auto-archive`: manual `/caco.session-archive`
(spec-archive-staging), `caco_herd disown` of a herd-created child
(spec-soft-archive-folder), and an explicit folder PATCH. None fire on their
own for a session the user simply stopped touching. A heavily-used user's
list grows without bound: old chats stay at the root indefinitely until the
user notices and archives them by hand.

Add a fourth, **volume-triggered** entry path. When the root list is large
enough to feel like clutter, park root sessions that have sat untouched past
a long idle window. Parking is soft — into the same `auto-archive` folder —
so the existing reaper's grace period and reversibility still apply. The
user sees a folder full of pending archives and can rescue any of them, and
the actual removal is still ≥3 days away.

This is a rewire, not a new subsystem. All the destructive machinery already
exists (reserved folder, entry stamp, maintenance-claim serialization,
per-session reap eligibility, reaper, reversibility); this spec adds one
predicate, one maintenance-aware write helper, one new meta field to make
"user put this at the root" observable, and one loop that ties them
together.

Non-goals: parking sessions the user has organised into their own folders (a
folder is a positive statement about that session's place); parking by count
alone irrespective of age; a rolling age-based cull that fires every sweep
regardless of pressure.

## Design

**Trigger is a conjunction: volume AND age.** The auto-park pass does
nothing until both hold:

- The number of root sessions — sessions whose `meta.folder` is undefined,
  empty, or absent, the same population the session list renders under no
  folder heading — is ≥ `AUTO_PARK_ROOT_THRESHOLD` (default 30).
- Among those root sessions, at least one has a resolvable auto-park anchor
  older than `AUTO_PARK_IDLE_MS` (default 21 days).

Both are required. Thirty fresh root sessions is a busy week, not clutter.
Three ancient root sessions is what a folder is for, and if the user did not
put them there they don't want an auto-parker to make that call for them.
The gate exists so that most of the time — for a user whose root does not
grow, or grows only from active work — this feature does nothing.

**The auto-park anchor is deliberately different from the reaper's.**
Reaper anchor: `max(autoArchiveTaggedAt, lastUsedAt, lastIdleAt, creation)`.
Auto-park anchor: `max(movedToRootAt, lastUsedAt, lastIdleAt, creation)`.
The park stamp is dropped (root sessions cannot carry it), and a new
**move-to-root** stamp is added (see below). Unknown ⇒ NOT eligible,
matching the reaper's fail-safe direction.

**`movedToRootAt` is a new meta field**, stamped in exactly one place:
whenever a folder mutation transitions `meta.folder` from any non-empty
value to root (undefined/empty). This includes:

- the folder PATCH route (sessions.ts:874-880) clearing `folder`;
- `caco_herd acquire` of a parked session (herd-tools.ts:170), which
  clears the auto-archive folder;
- any future path that clears the folder.

The field's semantics: *"the last time the user explicitly said this
session belongs at the root."* It is not "moved out of auto-archive" —
that would leave a symmetric hole where a session sitting in a user folder
for 100 days, dragged to root, is auto-parked on the very next tick,
silently undoing the drag. The generalisation to "any folder → root"
covers both cases with one rule, and matches how a user would describe the
intent.

The field is re-stamped every time the transition occurs (not
write-once — that would model this poorly; the user's most recent decision
is the load-bearing one). It is never cleared. A folder PATCH that changes
a session between two user folders, or from root to any folder, or that
does not touch `folder` at all, does not stamp it. Because it is scoped to
one specific transition, it cannot mis-signal any other quiescence question
— the reaper does not consult it, and neither does anything else.

Without this stamp, "rescue" from auto-park is a silent no-op: the folder
PATCH clears `autoArchiveTaggedAt` but does not touch `lastUsedAt`, so a
session with a 100-day-old `lastUsedAt` moved out of auto-archive would be
re-parked on the next hourly tick, forever. The user would have no way to
say "keep this at the root" short of sending a message. The stamp closes
that trap: any deliberate move to root gives the session a fresh 21-day
window there, and if the user still doesn't touch it in that time,
auto-park is free to draw the same conclusion the second time.

**When both gates pass, park up to a per-tick cap.** The set is "root
sessions with auto-park anchor > `AUTO_PARK_IDLE_MS` old, passing every
guard". `pickAutoParkCandidates` returns **every** qualifying id, sorted by
ascending anchor with id as tie-break (deterministic ordering matters when
the set is larger than the cap). The sweep loop takes the first
`AUTO_PARK_MAX_PER_TICK` (default 100) and processes them; the rest wait
for the next tick. Since aging cannot make a session drop out of the set,
one hour's delay per surplus cap-worth of backlog is the worst case.

Sorting is inside the predicate so a mutation that reverses it (or drops
it) shows up in tests. The cap is defence against a rollout burst — one
tick writing hundreds of meta files synchronously — not a rate limit;
users with big backlogs pay an extra tick per hundred sessions, spreading
a first-boot burst over hours instead of seconds.

**Guards mirror the reaper's, plus scheduled kind and minus the folder
check.** A root session older than the window is a **candidate** unless it
is one of:

- busy (`isBusy` — a dispatch in flight);
- active (`isActive` — loaded in `activeSessions`);
- resume-in-flight (`isResuming`);
- a herd parent (`isHerdParent(id)`);
- a herd child (`meta.orchestratedBy` set);
- a **scheduled** session (`meta.kind === 'scheduled'`).

The scheduled-kind exclusion is new to this feature. A scheduled session is
by design idle for long stretches — the whole point is that it wakes at
its scheduled time — so its `lastUsedAt` being months old is a normal
state and does not signal user disinterest. Parking one would move it into
`auto-archive`, the reaper would take it three days later, and the next
scheduled run would silently instantiate a fresh session instead of
resuming the persistent one the user configured. Excluding
`kind === 'scheduled'` outright is simpler than trying to consult the
schedule manager for "is this session currently referenced" — the kind is
the durable statement of intent.

An active session with a 21-day-old anchor should not exist in practice —
activity updates `lastUsedAt` — but if hydration or backfill ever leaves
one, skipping is safe: it drops out of `activeSessions` under normal LRU
pressure and the next sweep parks it. Herd members are load-bearing
(spec-soft-archive-folder invariants) and are never parked. Busy is
defensive against parking during a dispatch that just started.

**Guard evaluation happens twice: once at scan, once inside the write.**
Between candidate selection and the meta write, a session's state can
change (a dispatch starts, a resume begins, a herd acquires it, the user
drags it into a folder). Runtime facts (`isBusy`, `isActive`,
`isResuming`, `isParent`) are inspected only at scan time and NOT rechecked
in the write — a transient wrong-park of a session that just went live is
acceptable because the reaper's own under-claim recheck refuses to
archive a session that has become ineligible, and the user can move it
back out (which stamps `movedToRootAt`, preserving the choice).

**Durable meta conditions are rechecked inside the write**, however,
because losing them is a silent invariant violation, not a transient
folder move. Inside the `updateSessionMeta` callback, before writing
`folder = AUTO_ARCHIVE_FOLDER`:

- if the current meta's `folder` is not root (empty/undefined), the write
  is a no-op and the sweep records the id under skip reason `stale`;
- if the current meta's `orchestratedBy` is set (the session became a herd
  child between scan and write), same treatment;
- if the current meta's `kind === 'scheduled'` (the session was
  reclassified), same treatment.

These are checks against durable state, cheap to re-read from the same
callback, and each of them protects an invariant that "auto-park never
touches folder-placed / herd / scheduled sessions". The scan-time race is
tolerated for the transient runtime facts (busy/active/resuming/parent)
because those flip rapidly and the reaper's downstream recheck is what
provides correctness; it is not tolerated for the durable ones because
they represent a deliberate user or system statement about where this
session belongs.

**Parking goes through a maintenance-aware helper** that captures those
in-callback rechecks alongside the maintenance guard:

```
parkForAutoPark(id, now): 'ok' | 'maintenance' | 'metadata' | 'stale'
```

Semantics:

1. If `sessionManager.isUnderMaintenance(id)` returns true, refuse; skip
   reason `maintenance`. The claim can be granted between check and
   write, so this is best-effort — matches the reaper's own busy check
   philosophy.
2. Call `updateSessionMeta(id, cb, { createIfMissing: false })`. Auto-park
   must NOT create a meta file for a session that has none; the default
   creates a blank one, which would revive a partially-deleted session.
3. Inside the callback, evaluate the three durable rechecks above. If any
   fires, the callback leaves meta unchanged (returns without mutation)
   and sets an outer captured `staleObserved = true`. Otherwise it
   writes `meta.folder = AUTO_ARCHIVE_FOLDER; meta.autoArchiveTaggedAt =
   now;`.
4. If `updateSessionMeta` returned false (missing or corrupt meta), or
   threw (filesystem error — `setSessionMeta` is not exception-safe),
   the helper returns `'metadata'` and logs. Wrapping in try/catch is
   part of the helper's contract: an exception thrown at candidate id `k`
   must not abort the sweep and must not prevent the reaper's own scan
   from running at the end of the tick.
5. If `staleObserved`, return `'stale'`.
6. Otherwise return `'ok'`.

The `metadata` bucket therefore covers three underlying causes: missing
meta, corrupt meta, and filesystem exception. They are collapsed
deliberately — the corrective action is the same (the session is
inaccessible; nothing else can act on it either) and distinguishing them
in the summary line would provide no operational value the crash log
doesn't already carry.

**Creation timestamp source.** The auto-park anchor needs a creation
fallback for a session that has never been used and never gone idle
(fresh sessions with no `lastUsedAt`/`lastIdleAt` and no
`movedToRootAt`). `SessionMeta` has no `createdAt` field today, so the
source is `readSessionEvents(id)`'s first event's timestamp when
available, and `null` (⇒ skip, fail-safe) when not. A session with no
readable events cannot have its age determined and is excluded, matching
the reaper's philosophy: unknown ⇒ never archive.

The lookup is performed once per root candidate during the scan, so cost
scales with root population, not total sessions. Root sessions with
resolvable `lastUsedAt` never touch the events read; the cost applies
only to the rare no-activity-stamps case.

**Same timer, same tick.** The pass extends the existing auto-archive
sweep (`sweepAutoArchive` in `session-archive-reaper.ts`, ~1 hour cadence
per `AUTO_ARCHIVE_SWEEP_INTERVAL_MS`). Auto-park runs **first** within a
tick and the reaper's own scan runs after it. This ordering is safe (a
newly parked session's `autoArchiveTaggedAt` is `now`, so the reaper's
3-day window has not remotely expired) and avoids a second timer with
the same cadence and lifecycle.

**Emit one summary line only when there was work.** Format:

```
[AUTO-PARK] root=N stale=M parked=K skipped={busy:B, active:A, resuming:R, herd:H, scheduled:S, maintenance:C, metadata:D, stale:E}
```

Skip buckets have first-match precedence in the order listed (busy first,
`stale` last). `stale` here means the write-time recheck fired; the field
name is unrelated to `stale=M` in the header (which counts scan-time
qualifying candidates before the cap). A pass emits the line iff both
gates passed. That is: `N ≥ threshold AND M ≥ 1`. A gate-tripping no-op
(below-threshold OR zero-stale) emits nothing. A gate-passing pass emits
the line even if `K == 0` because everything was skipped — those skip
counts are the signal that would explain "why didn't my root count
drop".

**Config is read once at module load** like the existing `AUTO_ARCHIVE_*`
knobs. `CACO_AUTO_PARK=1` enables the feature (default on when
`AUTO_ARCHIVE_ENABLED` is on; parking without a reaper is pointless).
`CACO_AUTO_PARK_ROOT_THRESHOLD`, `CACO_AUTO_PARK_IDLE_MS`, and
`CACO_AUTO_PARK_MAX_PER_TICK` override the defaults. There is no
per-tick re-read; changing an env variable requires a server restart.
This matches existing config semantics and avoids a divergent knob layer.

**Interaction with `spec-archive-staging` is untouched.** That spec's
`stageForArchive` releases the loaded session from the active map because
it stages the user's *current* session, which is loaded by definition.
Auto-park's candidates are the exact opposite — long-idle sessions the
scan-time guard already excludes if active. The two paths write the same
meta but for opposite populations; neither imposes obligations on the
other.

Ownership:

- `src/config.ts` owns the knobs.
- `src/session-meta-store.ts` owns the new `movedToRootAt` field.
- `src/routes/sessions.ts` and `src/herd-tools.ts` stamp `movedToRootAt`
  on any → root folder transition.
- `src/session-archive-reaper.ts` owns `rootAnchorMs`,
  `pickAutoParkCandidates`, `parkForAutoPark`, and the extension to
  `sweepAutoArchive`. No changes to `session-manager.ts`.

## Invariants

- Auto-park never runs when the root population is below
  `AUTO_PARK_ROOT_THRESHOLD`.
- Auto-park never runs when no root session has crossed the idle window,
  even if the threshold is met. Volume alone does not qualify.
- `pickAutoParkCandidates` returns every qualifying id in ascending
  anchor order with id as tie-break. The cap is applied at the sweep
  loop, not the predicate; the predicate stays testable independent of
  the cap.
- The sweep loop parks at most `AUTO_PARK_MAX_PER_TICK` candidates per
  pass, oldest first. The rest wait for the next tick.
- A parked session's `autoArchiveTaggedAt` is stamped to the parking
  instant, and `folder` is set to `AUTO_ARCHIVE_FOLDER`. No other meta
  field is written by auto-park.
- Only root sessions are ever parked, both at scan and at the write-time
  recheck inside `parkForAutoPark`.
- Herd parents, herd children, busy, active, resume-in-flight, and
  `kind === 'scheduled'` sessions are never parked by auto-park.
- The write-time recheck inside `parkForAutoPark` verifies the durable
  meta conditions (root folder, no `orchestratedBy`, `kind !==
  'scheduled'`). If any changed between scan and write, the write is a
  no-op and the id is counted under `stale`.
- The scan-time-only runtime facts (`isBusy`, `isActive`, `isResuming`,
  `isHerdParent`) are NOT rechecked at write time. A transient wrong-park
  of a session that just went live is tolerated; the reaper's downstream
  under-claim recheck is what prevents destructive follow-on.
- The park write is invoked with `updateSessionMeta({ createIfMissing:
  false })`. Auto-park never revives a session with no meta.
- The park write is wrapped in try/catch. An exception at candidate id
  `k` is logged and treated as `metadata`; the sweep continues to
  subsequent candidates and the reaper's scan still runs.
- `movedToRootAt` is stamped iff a folder mutation transitions
  `meta.folder` from any non-empty value to root. It is never cleared.
  It is not consulted by anything other than `pickAutoParkCandidates`.
- Auto-park is a no-op when `AUTO_ARCHIVE_ENABLED` is false or
  `CACO_AUTO_PARK` is false. Neither logs nor consults live state
  beyond that check.
- A gate-tripping no-op auto-park pass produces no log line. A
  gate-passing pass emits the summary line even if every candidate was
  skipped.
- Auto-park never releases a session from the active map, exports data,
  or deletes data. The reaper is what actually removes anything, ≥3
  days after the park stamp.

## Considerations

- **Rescue path.** A user rescues a parked session by moving it out of
  `auto-archive` (via the session list drag, a folder PATCH, or
  `caco_herd acquire`). Moving to root stamps `movedToRootAt`, giving
  the session a fresh 21 days at the root before auto-park would
  consider it again. Moving to a user folder skips auto-park forever
  (user folders are excluded outright). Sending a message updates
  `lastUsedAt`, which auto-park's anchor also uses.
- **Sessions the user cares about should be in a folder.** The 21-day
  window is deliberately long — three weeks of not touching a session
  is a strong signal the user has moved on. If a user wants to keep
  something at the root indefinitely, dropping it into a user folder is
  one action and excludes it forever. Moving it *to* the root by hand
  is the "not permanent, just visible" case, and gets the fresh window.
- **A large one-off burst is expected on rollout.** A user with
  hundreds of root sessions untouched for months will see them parked
  over the first few sweeps after upgrade — up to
  `AUTO_PARK_MAX_PER_TICK` per hour. The folder becomes the transient
  home for the backlog, the 3-day reaper window runs from each
  session's own park moment, and the user gets a folder full of "about
  to be archived" for the entire grace period before anything is
  destroyed.
- **Auto-park cannot overshoot.** Parking is a folder move; the reaper
  is what actually removes anything. Even a mis-triggered sweep leaves
  everything visible and recoverable; the worst outcome is a folder
  full of sessions the user did not personally place there, and each
  can be moved back out (with the rescue stamp preserving that choice
  for 21 days).
- **The volume threshold is un-observable when un-tripped.** `N <
  threshold` emits no log, so a user asking "why didn't my old
  sessions park?" has to check the current root count. A future
  one-liner in the session list header (or on
  `/caco.session-archive`) reporting "root count / threshold" would
  fix this without changing behaviour; out of scope here.
- **Scheduled sessions.** Excluding `kind === 'scheduled'` means the
  root list can accumulate scheduled sessions indefinitely and
  auto-park will not clean them up. That is intentional — a scheduled
  session's root presence is the user's declaration that it should
  remain addressable — and it is the failure mode the exclusion exists
  to create. If accumulation ever becomes a problem, deleting the
  schedule is the affordance, not folder tidiness.
- **Two-conjunction is what makes the feature legible.** The
  alternative ("park anything >21d idle at every sweep") drips a
  session or two out of root every day for a heavy user, and the
  resulting folder is never full and never empty. Volume-gating means
  the folder is empty most of the time and full when something is
  happening, which matches how the reaper's grace period is meant to
  be experienced.

## Risks and Mitigations

- **A busy user with many active projects sees personal sessions
  parked.** Mitigated by the 21-day window (they are not touching
  them) and by the folder-based rescue path with the new
  `movedToRootAt` stamp giving 21 additional days if rescued to root.
  The alternative is the current state, which is what this feature
  exists to change.
- **A scheduled session is silently archived because a future kind is
  added and the exclusion is not updated.** Mitigated by an oracle
  that asserts the scheduled-kind exclusion by name; a mutation
  removing it must turn the oracle red. New kinds that need long idle
  lives will fail this oracle's spirit at review time.
- **A move-to-root PATCH lands without stamping `movedToRootAt`.**
  Auto-park would re-park on the next tick, making the drag silently
  ineffective. Mitigated by locating the stamp inside the
  `updateSessionMeta` callback that already runs on the folder
  mutation (sessions.ts:874-880 and herd-tools.ts:170), so every code
  path that clears the folder passes through it. Oracles verify the
  stamp both when transitioning from `auto-archive` to root and when
  transitioning from a user folder to root, so the "any → root" rule
  is enforced end to end.
- **`parkForAutoPark` skips a session forever because it is
  permanently under a maintenance claim.** In practice claims are
  short (individual archive or rotation), so a permanent claim is a
  bug elsewhere. If it happens, auto-park logs `maintenance` skips
  every hour — visible in the summary line — and the reaper would log
  the same for its own attempts. Mitigation is diagnosis via those
  logs, not a workaround here.
- **A candidate's meta is deleted between scan and write.** Handled
  by `createIfMissing: false` + try/catch. The id is counted under
  `metadata` and the sweep continues. Without the flag, auto-park
  would silently create a blank meta and park a phantom session.
- **`setSessionMeta` throws a filesystem exception.** The helper's
  try/catch converts it to `'metadata'` and logs. Without the catch,
  the exception would abort the auto-park loop AND the reaper scan
  for that whole tick.
- **Burst safety.** Bounded by `AUTO_PARK_MAX_PER_TICK`. A big first
  tick is at most ~100 synchronous JSON writes, an order of magnitude
  below what the file-edits and session-creation paths already do at
  peak. A session's meta write is small (single-digit KB) and each
  candidate is processed sequentially, so an event-loop stall is
  bounded.
- **Config re-read.** Env is read once at module load. Changing a
  knob requires a restart. Explicitly documented; no oracle promises
  otherwise.
- **The 21-day and 30-session numbers are magic.** Recorded so the
  next reader knows they were picked to be "long enough that touching
  once a fortnight keeps a session alive" and "large enough that a
  productive week does not trip the feature". Both are env-tunable.

## Acceptance

Every oracle must be written such that removing its corresponding
behaviour turns it red. A green test that survives the removal of the
behaviour it purports to check is vacuous and must be rewritten.

Integration oracles that need a non-default threshold or cap use
dependency-injected variants of `pickAutoParkCandidates` /
`sweepAutoArchive` (accepting explicit `thresholdRoot`, `idleMs`,
`maxPerTick`) OR run against a config module loaded with overriding
env vars. Either is acceptable; the acceptance test must document its
choice.

1. `pickAutoParkCandidates(sessionEntries, thresholdRoot, idleMs, now)`
   returns the ordered list of ids that are root, idle > `idleMs`, and
   pass every guard, sorted by ascending anchor with id as tie-break.
   Table of hand cases:
   - root fresh (skip: young)
   - root stale (park)
   - `folder='work'` stale (skip: not root)
   - `folder='auto-archive'` stale (skip: not root; already parked)
   - herd parent stale (skip: parent)
   - herd child stale (skip: `orchestratedBy` set)
   - active stale (skip: active)
   - busy stale (skip: busy)
   - resuming stale (skip: resuming)
   - **`kind='scheduled'` stale (skip: scheduled)**
   - anchor unknown (no `movedToRootAt`, no `lastUsedAt`, no
     `lastIdleAt`, no `creationMs`) — skip: unresolvable age
   - anchor via `movedToRootAt` fresh (skip: young by rescue)
   - anchor via `movedToRootAt` stale (park).
2. Ordering: with three qualifying candidates of anchor ages 25d, 30d,
   40d, `pickAutoParkCandidates` returns them in the order 40d, 30d,
   25d. Tie-break on identical anchor is deterministic by id
   (lexicographic). A mutation that removes the sort or reverses it
   must turn this red.
3. Below-threshold gate: with fewer than `AUTO_PARK_ROOT_THRESHOLD`
   root sessions but many crossing the idle window, the returned set
   is empty. The gate is evaluated against **root count**, not total.
4. Zero-stale gate: with ≥ threshold root sessions but none crossing
   the idle window, the returned set is empty.
5. Both gates pass, batch-all: with ≥ threshold root and multiple
   crossing the window, the predicate returns **every** qualifying
   id. Adding one more qualifying id to the fixture must add it to
   the output. (The per-tick cap is applied by the sweep loop, not
   the predicate.)
6. Cap applied by the sweep loop: with `AUTO_PARK_MAX_PER_TICK=2` and
   three qualifying candidates of anchor ages 25d, 30d, 40d, exactly
   two writes are attempted (40d and 30d), the 25d candidate is
   unwritten. A subsequent sweep at the same clock, with gates still
   passing, parks the third candidate.
7. `movedToRootAt` stamp — capture the updater passed to
   `updateSessionMeta` by the folder PATCH route and apply it to
   fixtures for each transition:
   - `folder = AUTO_ARCHIVE_FOLDER` → cleared (root): produced meta
     has `movedToRootAt = <PATCH clock>`.
   - `folder = 'work'` → cleared (root): produced meta has
     `movedToRootAt = <PATCH clock>`.
   - `folder = 'work'` → `folder = 'reading'`: produced meta has
     `movedToRootAt === undefined` (untouched — not a root
     transition).
   - `folder = undefined` → `folder = 'work'`: produced meta has
     `movedToRootAt === undefined` (untouched — root to folder is
     the other direction).
   The equivalent oracle for `caco_herd acquire` covers the
   auto-archive → root case triggered from the acquire branch at
   herd-tools.ts:170.
8. `parkForAutoPark` return-value discrimination — three unit oracles
   against a captured `updateSessionMeta` seam:
   - `isUnderMaintenance` returns true → helper returns
     `'maintenance'`; no `updateSessionMeta` call was made.
   - `updateSessionMeta` (with `createIfMissing: false`) returns
     false → helper returns `'metadata'`.
   - `updateSessionMeta` throws a filesystem exception → helper
     returns `'metadata'` and logs; no re-throw.
9. Write-time durable recheck: for each of the three durable
   conditions (folder became non-root, `orchestratedBy` was set,
   `kind` became `'scheduled'`), a captured-updater test asserts the
   callback leaves meta unchanged and the helper returns `'stale'`.
   The scan-time facts (`isBusy`, `isActive`, `isResuming`) do NOT
   trigger a `'stale'` recheck at write time — asserted by a fourth
   test where the scan-time facts flip after selection but the meta
   is unchanged; the helper still returns `'ok'` and writes the
   folder + tag.
10. Kill switch: two oracles, one each for
    `AUTO_ARCHIVE_ENABLED=false` and `CACO_AUTO_PARK=false`. With
    either off, the sweep is a no-op — `pickAutoParkCandidates` is
    not called, no writes occur, no log lines emit.
11. Summary log:
    - a gate-passing pass that parks ≥ 1 session emits the
      `[AUTO-PARK]` line with all eight skip buckets in the order
      specified;
    - a gate-passing pass that parks 0 but skips ≥ 1 also emits the
      line;
    - a gate-tripping no-op pass (below-threshold OR zero-stale)
      emits nothing.
    Asserted against captured stdout.
12. Sweep composition — a **real** integration oracle threading
    `sweepAutoArchive` end to end, with the fixture set up so both
    gates pass. Use a DI variant of the sweep (or module-load env
    overrides) so the threshold is 1 (or small enough to fit the
    fixture). Assert in order:
    - the target session's meta was written with `folder =
      AUTO_ARCHIVE_FOLDER` and `autoArchiveTaggedAt = <sweep
      clock>`;
    - within the SAME sweep call, the reaper's `reapArchive` path
      was NOT invoked for that id (the tar.gz file does not
      appear, the session dir still exists);
    - a second sweep at the same clock is a no-op for that id
      (either below-threshold or already-parked; both are fine
      — the point is no double-park).
    Removing the auto-park pass or reversing its ordering with the
    reap loop must turn this red.
13. Rescue round-trip — a **real** integration oracle threading a
    real folder PATCH:
    - fixture: one stale root session (`lastUsedAt` 60d ago). Set
      the module-loaded threshold to 1 (or use the DI variant) so
      both gates pass with one session in root.
    - first sweep parks it (assert: `folder = AUTO_ARCHIVE_FOLDER`,
      `autoArchiveTaggedAt = t0`).
    - user moves it out via a folder PATCH clearing `folder`
      (root). Assert: `autoArchiveTaggedAt === undefined`,
      `movedToRootAt === t1`.
    - second sweep at `t1 + 1h`: root count is 1 (target only),
      threshold=1 gate passes; but the rescue anchor is fresh, so
      the stale gate fails and the sweep is a no-op for that id.
      Assert the meta was not re-written.
    - third sweep at `t1 + 22d`: the rescue anchor has aged out,
      both gates pass, the id is parked again.
    Removing the `movedToRootAt` stamp from the folder PATCH must
    turn the second-sweep step red.
14. User-folder → root round trip — a variant of Acceptance 13
    starting the session with `folder='work'` (never in
    auto-archive) and `lastUsedAt` 60d ago:
    - user drags it from `work` to root (folder PATCH clears
      `folder`). Assert: `movedToRootAt = t1`.
    - subsequent sweep (with gates passing via DI threshold) does
      NOT park it, because the rescue anchor is fresh.
    Removing the "user-folder → root also stamps" behaviour from
    the folder PATCH must turn this red.
15. Every oracle above is mutation-tested. At minimum these
    mutations must each turn something red:
    - removing the below-threshold gate;
    - removing the zero-stale gate;
    - reversing the "root only" filter (parking non-root sessions);
    - dropping the herd-child guard;
    - dropping the herd-parent guard;
    - dropping the `kind === 'scheduled'` guard;
    - dropping the `isUnderMaintenance` refusal;
    - dropping any of the three write-time durable rechecks;
    - dropping the ascending-anchor sort in the predicate;
    - dropping the per-tick cap in the sweep loop;
    - parking during an active-session state at scan (should still
      park, per the tolerated-transient design; this mutation must
      NOT turn any oracle red — presence in the mutation list is a
      reminder to acceptance-test authors that this is a
      *desired-invariant* mutation, not a defect);
    - running the sweep while either kill switch is off;
    - stamping the anchor to a value other than `now`;
    - omitting the `folder` write;
    - emitting the summary line on a gate-tripping no-op pass;
    - suppressing the summary line on a gate-passing pass;
    - omitting the `movedToRootAt` stamp from the folder PATCH (any
      → root);
    - omitting the `movedToRootAt` stamp from the acquire branch;
    - removing the `movedToRootAt` term from the auto-park anchor;
    - passing `createIfMissing: true` (or omitting the option
      entirely) — auto-park must never revive a missing meta;
    - removing the try/catch around the write — an exception must
      not abort the sweep.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `AUTO_PARK_ROOT_THRESHOLD=30`, `AUTO_PARK_IDLE_MS=21d`, `AUTO_PARK_MAX_PER_TICK=100`, `AUTO_PARK_ENABLED` (`CACO_AUTO_PARK`, default `!= '0'`) to `config.ts` | `src/config.ts` | constants present; env override works | kill-switch |
| 2 | Add `SessionMeta.movedToRootAt?: number` | `src/session-meta-store.ts` | field defined; unchanged sessions do not carry it | move-to-root-scope |
| 3 | Stamp `movedToRootAt` in the folder PATCH route when transitioning `folder` from any non-empty value to root | `src/routes/sessions.ts:874-880` | Acceptance 7 (four cases), 14 | move-to-root-scope |
| 4 | Stamp `movedToRootAt` in the `caco_herd acquire` clear-parked branch | `src/herd-tools.ts:170` | acquire updater oracle | move-to-root-scope |
| 5 | Add pure `rootAnchorMs(meta, creationMs)` returning `max(movedToRootAt, lastUsedAt, lastIdleAt, creationMs)` (unknown ⇒ null) | `src/session-archive-reaper.ts` | Acceptance 1 (anchor rows) | age-anchor |
| 6 | Add pure `pickAutoParkCandidates(sessionEntries, thresholdRoot, idleMs, now)` where `sessionEntries: Array<{ id, meta, facts, creationMs }>`. Returns `{ candidates: string[], stats: { root, stale, skipped: { busy, active, resuming, herd, scheduled } } }`. Gates on `root >= threshold` AND `stale >= 1`. Candidates sorted ascending by anchor, id tie-break | `src/session-archive-reaper.ts` | Acceptance 1, 2, 3, 4, 5 | volume-and-age; ordering |
| 7 | Add impure `parkForAutoPark(id, now)`: check `isUnderMaintenance` → `'maintenance'`; else `updateSessionMeta` with `createIfMissing: false` and a callback that (a) verifies the durable rechecks and returns without mutation if any fired (captured `staleObserved = true`), (b) otherwise writes folder + tag; wrap in try/catch → `'metadata'`; return `'maintenance'|'metadata'|'stale'|'ok'` | `src/session-archive-reaper.ts` | Acceptance 8, 9 | park-uses-maintenance-aware-helper; createIfMissing:false; try/catch |
| 8 | Extend `sweepAutoArchive` to run auto-park first: kill-switch check → build `sessionEntries` (meta, facts, `creationMs` via `readSessionEvents` first-event-timestamp, null if unreadable) → call `pickAutoParkCandidates` → apply `AUTO_PARK_MAX_PER_TICK` prefix → call `parkForAutoPark` per id → accumulate skip counters (all eight buckets) → emit `[AUTO-PARK]` iff both gates passed → then run the existing reap loop unchanged | `src/session-archive-reaper.ts` | Acceptance 6, 10, 11, 12 | ordering; log-only-on-work; kill-switch |
| 9 | Rescue round-trip integration tests threading a real folder PATCH | `tests/unit/session-archive-reaper-auto-park*.test.ts` | Acceptance 13, 14 | move-to-root-scope |
| 10 | Mutation-test every oracle against the list in Acceptance 15 | tests | all | all |
| 11 | Update `spec-soft-archive-folder.md` and `spec-archive-staging.md` with a single sentence each referencing this fourth entry path | `docs/spec-soft-archive-folder.md`, `docs/spec-archive-staging.md` | n/a (documentation) | n/a |

## Rationale

The soft-archive machinery was designed for entries driven by a human
decision — disown, or an explicit archive command. In practice the root
list also fills up from things the user *did not* decide about: chats they
meant to come back to and never did. Adding a fourth entry path — the
sweep itself — closes that gap without redesigning anything: the parking
write is what already exists (extended with one field and a callback), the
retention window is what already exists, the observability and
reversibility are what already exist. The only new content is the trigger
(volume-and-age), the predicate that expresses it, the maintenance-aware
write helper, and the root-scoped stamp that makes "put this at the root"
mean something.

The instinct to make this a rolling age-based cull was resisted because
the folder-based rescue is the only visible signal the feature exists.
Volume-gating keeps the folder mostly empty most of the time, so the day
the user opens Caco to a folder full of old sessions is a legible event,
not a chronic drip.

The instinct to make it "keep root at exactly N" was resisted because that
would introduce an implicit second window whose value depends on how much
clutter you had; the two-conjunction design keeps the age contract loud —
nothing is parked that has not been untouched for at least 21 days,
regardless of load.

The instinct to make `updateSessionMeta` refuse under a maintenance claim
was noted (it would centralise the serialization) and rejected because
this feature is not the right forcing function: the current call sites
that check `isUnderMaintenance` at the handler layer do so with tailored
error messages, and making the store refuse silently would break their
error propagation. Auto-park doing the check at the helper matches the
existing pattern.

The instinct to scope the rescue stamp to "moved out of auto-archive" was
rejected in favour of "any → root" because they have the same semantics
from the user's point of view — "I want this at the root" — and the
narrower scope would leave a silent trap: a session sitting in a user
folder for 100 days, dragged to root, would be auto-parked on the very
next tick. `movedToRootAt` covers both entry paths with one rule.

The instinct to reuse `lastIdleAt` for the rescue signal was rejected
because a folder PATCH is not idleness — the user just interacted with
the session by moving it. Overloading `lastIdleAt` for this transition
would silently affect the reaper's own anchor and every other quiescence
question the codebase might ask in future. A single-purpose,
single-write-site field is easier to reason about and impossible to
mis-consult.

The instinct to recheck runtime facts (busy/active/resuming) at write
time as well was rejected because those flip too rapidly for a
scan-then-write pipeline to keep coherent, and the reaper's own
downstream recheck provides the correctness the user actually cares about
(nothing destructive happens to a session that became live). Durable meta
conditions ARE rechecked at write time because losing them silently
violates an invariant that has no downstream backstop.
