# spec-observation-verdict-completeness

**Status:** draft, reviewed once (the review removed the fix I proposed and left a
one-line deletion). Amends `spec-observation-authority` (commit `ea200ca`), which fixed
half of this.

## Goals

The badge is decided by exactly one rule, with no second derivation surviving anywhere as
a fallback. A session an agent delegated to never raises the badge, no matter how many
times the server restarts or whether a human has ever opened it. A badge a human is owed
is never cleared by agent traffic.

## Design

### What actually happens

`spec-observation-authority` replaced the timestamp derivation with a persisted verdict,
`meta.unobserved`, and kept the timestamp comparison in `isUnobservedFromMeta` as a
migration path for metadata written before the field existed.

**Nothing migrates that metadata.** The verdict has exactly three writers:

* `unobservedTracker.markIdle` → `unobserved: true`. Gated by the authority; runs only for
  idles that need observation.
* `markObserved` / `markSessionObserved` → `unobserved: false`. Runs when a **human** opens
  the session.
* `ensureSessionMeta` → seeds `unobserved: false`, for **new** sessions only.

A pre-existing session that is only ever a delegate target, and that a human never clicks,
passes through none of them. Its `unobserved` field stays absent permanently, so
`isUnobservedFromMeta` falls through to `lastIdleAt > lastObservedAt` — the exact broken
derivation the previous fix was written to remove.

Meanwhile `markSessionIdle` stamps `lastIdleAt` on **every** idle including delegate
replies, deliberately: the archive reaper and history rotation read it as a coldness
signal. So each delegation advances `lastIdleAt` while `lastObservedAt` stands still, and
the next hydrate re-arms the badge. The population that most needs a verdict is precisely
the population that never receives one.

Measured on the running instance after the reported reboot:

| session | `unobserved` | `lastIdleAt` vs `lastObservedAt` | badge |
|---|---|---|---|
| hull reviewer | ABSENT | idle newer | **badged** |
| vui reviewer | ABSENT | observed newer | not badged |
| caco reviewer | `false` (human clicked) | idle newer | not badged |
| ssg reviewer | `false` (human clicked) | idle newer | not badged |

The two holding a verdict are correct despite `lastIdleAt` being newer — the verdict wins.
The two without one are decided purely by timestamp ordering, and the one whose ordering is
unfavourable is badged. `caco` and `ssg` only hold a verdict because a human opened them
minutes before the measurement; before that they were in hull's state.

### The fix: delete the fallback

Remove the timestamp comparison from `isUnobservedFromMeta`. An absent field means "no
verdict recorded", which reads as **not unobserved**.

That is the entire behavioural change. A fallback that some population can never escape is
not a migration path — it is the original bug with a branch in front of it. Leaving it in
place preserves two derivations of one question, which is what `spec-observation-authority`
set out to eliminate and did not.

Cost: a session that went idle unattended before this ships, and was never observed since,
loses its badge once. A single self-healing miss, against a false positive that currently
returns on every restart forever. Take the one-time miss.

Safety of the absent-means-observed direction rests on the write path being intact for
everything that matters: any genuinely unattended idle reaching `handleSessionIdle` writes
`unobserved: true` through `markIdle`, and new sessions are born with an explicit `false`.
The only sessions left with an absent field are those whose last idle predates `ea200ca` —
exactly the one-time population above.

### Rejected: writing a verdict on attended idles

The obvious symmetric change — give `handleSessionIdle` an `else` branch that persists
`unobserved: false` for attended idles — was specified, reviewed, and **removed**. Two
independent reasons, either one fatal:

**It would erase badges a human is owed.** A human sends a message, the turn ends
unattended, `unobserved: true` is written and the badge is correct. An agent then delegates
to that same session. Under the symmetric change that attended idle writes `false` and the
badge the human was owed disappears, unseen. Only human observation may clear a `true`.

**`needsObservation: false` does not mean "an agent owns this".** Auto-continue dispatches
send `needsObservation: false` (`session-messages.ts:74`), so a *human-initiated* turn that
happened to involve a `caco_enable_tools` reveal continues under that flag, and its real
idle would be classified as attended. The flag distinguishes "this dispatch was not typed
by a human" from "no human is waiting on the result", and those are different questions.

And it buys nothing: once absence reads as observed, materialising absent → `false` changes
no observable behaviour. It is pure risk surface. Dropping it also removes any new injected
dependency, and with it the silent-drop wiring hazard that made the previous fix ship inert.

### Found, not fixed: continuations lose their badge

The second reason above is a live defect in its own right, in the opposite direction. A
human-initiated turn that triggers a tool reveal auto-continues with
`needsObservation: false`; the original idle returns early (`willFire && started`) and the
continuation's real idle is never marked. The human is owed attention and gets no badge.

That is a false *negative*, distinct from the false positive this spec fixes, and correcting
it means propagating the originating dispatch's observation need through the continuation
rather than defaulting it. Out of scope here; tracked separately so it is not lost.

### Note, not in scope

`markObserved` (`unobserved-tracker.ts`) and `markSessionObserved` (`session-meta-store.ts`)
both write `lastObservedAt` + `unobserved: false`. They agree today, so this is duplication
rather than divergence. Worth collapsing; not part of this fix.

## Acceptance

* `isUnobservedFromMeta` contains no timestamp comparison. A meta with no verdict is not
  unobserved, whatever its timestamps say.
* A meta with `unobserved: true` stays unobserved regardless of timestamps; one with
  `unobserved: false` stays observed regardless of timestamps.
* After a delegate exchange, a restart-and-hydrate leaves the target unbadged with no human
  having opened it.
* An unattended idle still persists `unobserved: true`, and a human observation still
  clears it.
* `lastIdleAt` is still stamped on every idle, attended or not — the reaper's coldness
  signal is unchanged.

## Plan

| # | Change | Oracle |
|---|--------|--------|
| 0 | Characterisation test pinning today's false positive: a meta with no verdict and `lastIdleAt > lastObservedAt` hydrates as badged | Green now. It exists to prove the repro was real and is DELETED in row 1, not carried forward |
| 1 | Delete the timestamp comparison from `isUnobservedFromMeta`; absent ⇒ not unobserved | A meta with no verdict and `lastIdleAt > lastObservedAt` is NOT unobserved. Red before the deletion |
| 2 | Pin that an explicit verdict still governs in both directions | `unobserved: true` with observed-newer timestamps is unobserved; `false` with idle-newer timestamps is not. Red if the deletion also drops the verdict read |
| 3 | End-to-end hydrate with NO verdict field and idle-newer timestamps | `unobservedTracker.hydrate([id])` leaves it out of the set. The fixture must OMIT the field and assert its absence before hydrating — a seeded `unobserved: false` would pass without the fix |
| 4 | Pin that an unattended idle still badges and human observation still clears | `markIdle` writes `true` and adds to the set; `markObserved` writes `false` and removes. Guards against over-deletion |
| 5 | Full gate | `npm run build`, 10 phases |

Mutation-check: restore the timestamp comparison and rows 1/3 must go red; make
`isUnobservedFromMeta` return a constant and rows 2/4 must go red.

No production-wiring oracle is required, and that is a deliberate consequence of the design:
the change is a deletion inside a pure function with no new dependency to wire, so the
inert-wiring failure mode that hit `ea200ca` has no surface to recur on.

## Testability

Fully unit-testable. `isUnobservedFromMeta` is pure, and `hydrate` reads it through
`getSessionMeta`, which the existing observation tests already redirect at a temp session
directory.
