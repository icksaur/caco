# spec-observation-authority

**Status:** draft, reviewed once (findings folded — the review corrected the root
cause). Amends `spec-idle-authority`.

## Goals

One rule decides whether a session is unobserved, and it holds across a restart.
A session whose work an agent requested — a delegate target, a herd child, a swarm
session — is observed by whoever asked for it and never raises the badge. The rule
is written down when the decision is made, not re-derived later from weaker data.

Today delegate targets raise the badge in a batch after a restart.

## Design

**Two sources of truth for one question, and they disagree the moment any
agent-sourced idle lands.**

- **Live**: `session-manager.ts:1634` reads `unobservedTracker.isUnobserved(id)` —
  set membership. Correct: `handleSessionIdle` calls `deps.markIdle` only inside
  its `needsObservation` branch, and `buildDelegateSendBody` sends
  `source: 'agent'`, so `needsObservation: !source` is false and a delegate reply
  never enters the set.
- **After restart**: `unobservedTracker.hydrate()` rebuilds that set from
  `lastIdleAt > lastObservedAt`, a comparison that knows nothing about who asked.

**The write that arms the badge is NOT in `markIdle`.** `markIdle` is fully gated
and does not run for sourced traffic. The arming write is
`deps.herdOnSessionIdle(sessionId)` in `src/idle-authority.ts`, called
**unconditionally, outside the `needsObservation` gate**, which reaches
`onSessionIdle` (`herd-runtime.ts:93`) and calls `markSessionIdle` — whose comment
says the quiet part out loud: *"Stamps `lastIdleAt` unconditionally (so
agent-sourced children report a fresh idle time)."*

So every agent-sourced idle advances `lastIdleAt` while `lastObservedAt` stays
put. The session is armed: the set says observed, the timestamps say not. The next
hydrate flips all of them together — the reported "all at once".

Live evidence, both from the running instance:

- `⌨️ SSG reviewer` — `lastIdleAt` 00:35:20 vs `lastObservedAt` 00:16:17 (a
  delegate reply after the user last opened it).
- `user-prefs-learning` (scheduled) — idle 2026-08-06T19:26 vs observed
  2026-08-04T03:18, armed by the same path.

**The fix must therefore sit on the unconditional path**, not on `markIdle`. That
is the whole correction: an earlier draft of this spec hooked the dead branch and
would have shipped no behaviour change at all.

`markSessionIdle(sessionId, attended: boolean)` still stamps `lastIdleAt` always —
that timestamp has four other consumers (archive reaper, rotation, herd progress
keying, the pager's `offerAtOf` fallback) and must keep meaning *when this session
last finished work*. When the idle was attended it additionally stamps
`lastAttendedAt`. `onSessionIdle` gains the same parameter and passes it through
from the authority, which is the only place that knows.

Hydrate then asks the question the live path asked:

    unobserved  ⟺  lastIdleAt > max(lastObservedAt, lastAttendedAt)

**Why not gate the `lastIdleAt` write.** Simpler and wrong: the archive reaper
(`session-archive-reaper.ts:48`) and rotation (`session-history-rotation.ts:441`)
read `lastIdleAt` as a *coldness* signal, and rotation treats a missing one as
"not provably cold". Skipping the write for agent work would make an actively-used
delegate look idle for hours and expose it to auto-archive. The timestamp stays
honest; the observation decision gets its own field.

**Scheduled sessions currently do NOT badge, and this spec does not change that.**
An earlier draft claimed they send `needsObservation: true`; that was a misreading
of `sessions.ts:481`, which is the **skill** route. `schedule-manager.ts` sends
`source: 'scheduler'` ⇒ `needsObservation: false`. Whether an unattended scheduled
run *should* badge is a real product question — nobody is waiting on it, but
nobody has seen it either — and it is deliberately **out of scope**: this spec
makes the persisted state match the live decision, and changing what that decision
*is* for schedules is a separate change with its own argument. Recorded so it is
not mistaken for an oversight.

**Kinds are the wrong axis.** `markIdle`'s `kind === 'swarm'` branch hard-codes one
kind because that kind was noticed; a delegate target is `kind: 'interactive'`, so
no kind test can classify it. Attendance follows the request source, which every
agent path already sets. The branch is deleted — but only once row 2's oracle
proves swarm dispatches are always sourced, since deleting it is safe only under
that assumption.

**Hydrate must drop its own swarm skip at the same time.** `hydrate()` skips
`kind === 'swarm'` independently. If live marking stops keying on kind while
hydrate still does, the two paths diverge for exactly the sessions this spec is
meant to reconcile — and the convergence oracle would catch it, which is the point
of having one.

**A third derived reader exists**: `isSessionUnobserved` in `session-meta-store.ts`
computes `lastIdleAt > lastObservedAt` with no attendance notion. It is not in the
live badge path today, but it is the same latent seam. It is updated to use the
same `max(...)` so a future caller cannot reintroduce the bug.

## Invariants

- **One rule, both paths.** The live badge and the post-restart badge derive from
  the same decision; an agent-sourced idle cannot make them disagree.
- **`lastIdleAt` means "last finished work", always stamped** — the archive reaper
  and rotation depend on it as a coldness signal.
- **Attendance is decided by request source, never by kind.** No `kind === 'x'`
  test may decide observation, in marking or in hydrate.
- **Observation is monotonic** — neither stamp moves backwards, so a badge cannot
  reappear without a new idle.

## Considerations

- **`hasPendingAutoContinue` still short-circuits `onSessionIdle` first**, so a
  reveal-idle stamps nothing at all. Unchanged.
- **The pager's `offerAtOf`** falls back to `lastIdleAt`; unchanged, because
  `lastIdleAt` keeps its meaning. A "gate the write" fix would have silently
  changed pager ordering too.
- **`hydrate()` is once-per-process** (`initialized` flag), so the divergence is
  only *observable* at restart even though it is *created* on every sourced idle.
- **A delegate the user also chats with directly** gets an unattended idle on that
  turn and correctly badges — reviewer sessions behave normally when used normally.
- **Existing metas have no `lastAttendedAt`**; `max` degrades to `lastObservedAt`,
  i.e. today's behaviour. Already-armed sessions stay armed until observed once,
  which is correct — the user genuinely has not looked at them.

## Risks and Mitigations

- **The fix lands on a dead path again** → row 1 is a failing end-to-end oracle
  written FIRST, driving the real authority seam rather than `markIdle` directly.
- **Swarm suppression regresses** when its branch is deleted → row 2 pins that
  swarm dispatches are sourced; existing swarm-suppression tests are updated
  deliberately, not deleted.
- **The two representations drift again** → the convergence oracle asserts the
  re-hydrated set equals the live set over a mixed sequence.

## Acceptance

- Observable: delegate to a reviewer, restart, and it shows no badge; chat with it
  directly, leave, restart, and it does.
- Gates: `npm run build` green.
- Oracles: below. Row 1 must fail against today's code — a spec that hooks the
  wrong path passes everything, which is exactly how the first draft went wrong.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | **Reproduce first**: an end-to-end oracle driving `handleSessionIdle` with `needsObservation: false`, then re-hydrating a fresh tracker from the resulting metas; assert the session is NOT unobserved | `tests/unit/observation-authority.test.ts` | fails today (hydrate reports unobserved) | one-rule-both-paths |
| 2 | Pin that every swarm/herd/delegate dispatch is sourced, so deleting the kind branch is safe | `tests/unit/observation-authority.test.ts` | each agent path's send body carries a `source` ⇒ `needsObservation: false` | attendance-by-source |
| 3 | Add `lastAttendedAt` to `SessionMeta`; `markSessionIdle(id, attended)` stamps it when attended; `onSessionIdle(id, attended)` threads it; the authority passes `!ctx.needsObservation` | `src/session-meta-store.ts`, `src/herd-runtime.ts`, `src/idle-authority.ts`, `src/routes/session-messages.ts` | row 1 passes; `lastIdleAt` still stamped on both branches | lastIdleAt-always |
| 4 | `hydrate()` compares against `max(lastObservedAt, lastAttendedAt)` and drops its `kind === 'swarm'` skip; `markIdle` drops its swarm branch; `isSessionUnobserved` uses the same max | `src/unobserved-tracker.ts`, `src/session-meta-store.ts`, existing swarm tests | fixture metas ⇒ expected set; missing `lastAttendedAt` behaves as today; a swarm meta is classified by stamps, not kind | attendance-by-source, one-rule-both-paths |
| 5 | Convergence oracle: drive a mixed sequence (user idle, delegate reply, observation, herd child idle) through the authority, snapshot the live set, re-hydrate from the same metas, assert equality | `tests/unit/observation-authority.test.ts` | sets equal | one-rule-both-paths |
| 6 | Record the rule in the authority spec | `docs/spec-idle-authority.md`, this file | `npm run check:specs` | - |

## Rationale

`spec-idle-authority` centralized the *classification* of an idle and got it
right — every consumer of the live decision has been correct since. What was never
centralized is the *persistence* of that decision: the classification was used and
discarded, and a restart reconstructed it from two timestamps that predate the
concept, one of which is written on a path deliberately outside the gate. The fix
is not a new authority but making the existing one write down what it decided.
