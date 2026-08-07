# spec-observation-authority

**Status:** draft. Amends `spec-idle-authority` and `spec-idle-suppression-central`,
which centralized *which idles are real*. This centralizes *which idles a human
owes attention to* — a separate question that turned out to have two answers.

## Goals

One rule decides whether a session is unobserved, and it holds across a restart.
A session whose work was requested by an agent — a delegate target, a herd child,
a swarm session — is observed by whoever asked for it and never raises the badge
for the user. A scheduled session, which nobody is waiting on, still does.

Today the badge appears on delegate targets in a batch, typically after a restart
or anything that re-derives the list.

## Design

**The bug is two sources of truth for one question, and they disagree the moment a
delegate replies.**

- **Live**: `unobservedTracker.isUnobserved(sessionId)` — set membership.
  `session-manager.ts:1634` reads this for the session list. It is correct:
  `handleSessionIdle` only calls `markIdle` inside its `needsObservation` branch,
  and the delegate route derives `needsObservation: !source` → `false`, so a
  delegate reply never adds the session to the set.
- **After restart**: `hydrate()` recomputes the set from
  `lastIdleAt > lastObservedAt`. That comparison knows nothing about who asked.

`markIdle` writes `lastIdleAt` **unconditionally** — before the `swarm` check and
outside the caller's `needsObservation` gate — so every delegate reply advances the
timestamp while `lastObservedAt` stays put. Each such session becomes armed: the
set says observed, the timestamps say not. On the next hydrate they all flip at
once, which is exactly the reported symptom ("all reviewers, suddenly, together").

Live data confirms it: `⌨️ SSG reviewer` has `lastIdleAt` 00:35:20 against
`lastObservedAt` 00:16:17 — a delegate reply after the last time the user opened
it. Reviewers opened more recently than their last delegation are clean.

**The fix is to make the persisted state carry the same decision the live path
makes, rather than re-deriving it from a weaker signal.**

`markIdle(sessionId, needsObservation)` takes the caller's verdict. It always
stamps `lastIdleAt` — that timestamp has four other consumers (archive reaper,
rotation, herd progress keying, the pager's `offerAtOf` fallback) and must keep
meaning "when this session last finished work". What it gains is a second stamp,
`lastAttendedAt`, written whenever the idle did NOT need observation. `hydrate`
then asks the same question the live path does:

    unobserved  ⟺  lastIdleAt > max(lastObservedAt, lastAttendedAt)

An agent-requested idle advances both `lastIdleAt` and `lastAttendedAt`, so it
cannot arm the badge; a user-facing idle advances only `lastIdleAt`, so it does.
The comparison is now over the same information the live decision used, and
survives a restart because it is persisted at the moment the decision is made.

**Why not gate the `lastIdleAt` write instead.** It looks simpler — stamp only on
real idles — but `lastIdleAt` is the *when did this session last finish* signal
that the archive reaper and rotation use to decide coldness. Skipping the write
for agent work would make a busy delegate look idle for hours and expose it to
auto-archive. The timestamp must stay honest; the observation decision needs its
own field.

**Kinds are the wrong axis; the request source is the right one.** The existing
`kind === 'swarm'` check inside `markIdle` is a symptom of this: it hard-codes one
kind because that kind was noticed. A delegate target is `kind: 'interactive'`
(it is a normal session someone delegated to) and a herd child may be interactive
too, so no kind test can classify them. `needsObservation` already carries the
answer — it is `!source`, and every agent path sets a source — so the `swarm`
special case is deleted, subsumed by the general rule.

That also fixes the three cases together, as required:

- **Delegates** — `source: 'agent'` ⇒ attended by the delegating session.
- **Herd children** — `source: 'system'` ⇒ attended by the parent.
- **Swarm** — same, and no longer needs its own branch.
- **Scheduled** — `sessions.ts:481` explicitly sends `needsObservation: true`.
  Nobody is waiting on a scheduled run, so it SHOULD raise the badge. This is the
  one case where "an agent started it" and "a human should look" both hold, and
  the current code already gets it right; the spec records it so a later
  simplification does not sweep it in with the others.

**Observation still clears both.** `markObserved` continues to write
`lastObservedAt`; `lastAttendedAt` is never cleared, only advanced. Since the test
is `>` against the max, a human observation and an agent attendance are
interchangeable for suppression, which is the intent — both mean "this idle is
accounted for".

**Migration is implicit.** Existing sessions have no `lastAttendedAt`; the max
degrades to `lastObservedAt`, i.e. today's behaviour. Already-armed sessions stay
armed until observed once, which is correct — the user genuinely has not looked at
them. No backfill, and no way for the new field to un-observe something.

## Invariants

- **One rule, both paths.** The live badge and the post-restart badge derive from
  the same decision; a delegate reply cannot make them disagree.
- **`lastIdleAt` means "last finished work", for every session.** It is never
  skipped, because the archive reaper and rotation read it as a coldness signal.
- **Attendance is by request source, never by kind.** No `kind === 'x'` test may
  decide observation.
- **A scheduled session still raises the badge** — agent-started but human-owed.
- **Observation is monotonic**: neither stamp moves backwards, so a badge cannot
  reappear without a new idle.

## Considerations

- **The pager reads `lastIdleAt` too** (`offerAtOf` falls back to it when
  `responseOptionsAt` is absent). Unchanged by this spec, since `lastIdleAt` keeps
  its meaning — worth noting because a "just gate the write" fix would have
  silently changed pager ordering as well.
- **`hydrate()` runs once and is idempotent** (`initialized` flag). The new field
  changes only its predicate.
- **The set remains the live authority** — this spec does not move the live read to
  timestamps. Two representations still exist, but they now encode the same rule,
  and hydrate is the only place the persisted one is consulted.
- **A delegate the user also chats with directly** advances `lastIdleAt` without
  `lastAttendedAt` on that turn, so it correctly raises the badge — the reviewer
  sessions behave normally when used normally.

## Risks and Mitigations

- **A path marks idle without threading `needsObservation`** → the parameter is
  required, not optional, so a caller cannot silently default to "human owes
  attention"; the type system catches every call site.
- **The two representations drift again** → the hydrate oracle asserts the
  reconstructed set equals the live set for a fixture covering all four sources,
  which is the property that actually failed here.
- **Suppressing too much** — a real idle wrongly attended → the scheduled case is
  pinned by its own oracle, since it is the one that must NOT be suppressed.

## Acceptance

- Observable: delegate to a reviewer session, restart the server, and the reviewer
  does not show the badge; chat with it directly, leave it, restart, and it does.
- Gates: `npm run build` green.
- Oracles: below; each must fail before its change exists.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `lastAttendedAt` to `SessionMeta` | `src/session-meta-store.ts` | type-level; read back after write | - |
| 2 | `markIdle(sessionId, needsObservation)` — required param; always stamp `lastIdleAt`; stamp `lastAttendedAt` when `!needsObservation`; delete the `kind === 'swarm'` branch; only add to the set when `needsObservation` | `src/unobserved-tracker.ts`, `src/routes/session-messages.ts` (pass it through) | hand table over the four sources: agent/system ⇒ both stamps, not in set; user/scheduled ⇒ only `lastIdleAt`, in set; a swarm session with `needsObservation: true` IS marked (proving kind no longer decides) | attendance-by-source, lastIdleAt-always |
| 3 | `hydrate()` compares against `max(lastObservedAt, lastAttendedAt)` | `src/unobserved-tracker.ts` | fixture metas ⇒ reconstructed set; a session with `lastAttendedAt > lastIdleAt` is absent; missing `lastAttendedAt` behaves exactly as today | one-rule-both-paths |
| 4 | The convergence oracle: drive a sequence of idles through `markIdle`, snapshot the live set, re-hydrate a fresh tracker from the same metas, assert the two sets are EQUAL | `tests/unit/unobserved-tracker.test.ts` | equality across a mixed sequence incl. a delegate reply after an observation — fails today | one-rule-both-paths |
| 5 | Update the specs to name the authority and its rule | `docs/spec-idle-authority.md`, this file | `npm run check:specs` | - |

## Rationale

`spec-idle-authority` centralized the *classification* of an idle and got it
right; every consumer of the live decision has been correct since. What was never
centralized is the *persistence* of that decision — the classification was used
and discarded, and a restart reconstructed it from two timestamps that predate the
concept. The fix is not a new authority but making the existing one write down
what it decided.
