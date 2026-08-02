# spec-herd-observe-clear

## Goals

When a herd parent acts on a child via `caco_herd resume` or `caco_herd disown`,
the child's **unobserved** status clears — the front-end "unobserved" badge (and
the global unobserved count) disappears immediately and stays cleared across a
server restart. Rationale: the parent handling a child IS the observation; a human
never opens agent-managed children, so their completion should not sit badged as
"needs a human look" once the supervising parent has resumed or retired them.

## Design

**Current behavior.** A session becomes unobserved when it goes idle from a
human/user dispatch (`markIdle`, gated by `needsObservation`), and — durably — any
session with `lastIdleAt` but no later `lastObservedAt` is re-marked unobserved on
boot (`UnobservedTracker.hydrate`). Herd children accumulate `lastIdleAt` (the herd
idle hook stamps it) but are never observed by a human, so after a big herd run —
and especially after a restart — dozens of (often disowned) children show the badge
with no way for the parent's actions to clear it. `markObserved` (durable
`lastObservedAt` + `session.listChanged` broadcast) is only reachable via
`POST /sessions/:id/observe`, which the UI calls only when a human opens a session.

**Mechanism chosen — the herd action IS an observe.** `caco_herd resume` and
`caco_herd disown`, on a successful action against a valid herd member, call
`unobservedTracker.markObserved(childId)` in-process (herd-tools already runs in the
server process and imports `sessionManager`). `markObserved` already does exactly
what is needed and is the single owner of the clear:
- sets `meta.lastObservedAt = now` (durable — survives the boot `hydrate` re-mark), and
- removes the child from the in-memory unobserved set, and
- broadcasts `session.listChanged { reason:'observed', unobservedCount }`.

The front-end needs NO change: it already reloads the session list on
`session.listChanged` and reads `isUnobserved` per session, so the badge and the
aggregate count clear on the existing path.

**Why the tool layer, not the dispatch layer.** The clear is a property of the
*parent's supervisory action*, not of the child's dispatch (an agent-sourced
dispatch is `needsObservation:false`, so it already never RE-marks; the problem is
purely the pre-existing/rehydrated state, which only an explicit observe clears).
Placing the call in the two `caco_herd` branches keeps the behavior scoped exactly
to the two actions named, next to the existing `updateSessionMeta` writes.

**Ordering.** For `resume`, clear only after ALL of `resume`'s own validation passes
— the member guard AND the `prompt`-required check — so a malformed `resume` (no
prompt) does not clear the badge without a real supervisory action. Clear
independent of whether the subsequent *dispatch* to the child then succeeds (the
parent has observed the child's prior result regardless of the new send's outcome).
For `disown` (no prompt requirement), clear after the member guard; disown already
mutates meta (park into `auto-archive`), and the `markObserved` write is an
additional meta write on the same child applied after the parking write.

## Invariants

- **`markObserved` is the sole unobserved-clear path** (unchanged): resume/disown
  route through it, not a bespoke set mutation or broadcast — so persistence (the
  durable `lastObservedAt` that defeats boot re-hydration) and the badge broadcast
  can't drift from the human-observe path.
- **Herd dispatch stays `needsObservation:false`** (unchanged): the child's own
  post-resume idle does not re-mark it unobserved live; combined with the durable
  `lastObservedAt` stamp, the clear holds.
- **No front-end change to the badge contract**: clearing remains driven by
  `isUnobserved` in the `/api/sessions` payload + the `session.listChanged` reload.

## Considerations

- **Resume → the child idles again.** After a resume the child runs and idles; the
  herd idle hook stamps a new `lastIdleAt` later than the `lastObservedAt` we just
  wrote, so on a *subsequent* boot `hydrate` could re-mark it. This is acceptable and
  arguably correct: a freshly-idled child that the parent has not yet re-handled is
  legitimately a new "awaiting attention" item (the parent is woken for it). The spec
  clears the badge for the state that existed AT the moment of the action; it does
  not promise to suppress a genuinely new later idle. (Disown avoids this entirely:
  the child is parked in `auto-archive` and reaped, not re-run.)
- **Idempotence.** `markObserved` returns `false` and no-ops the count/broadcast when
  the child was not unobserved, so resuming/disowning an already-observed child is
  harmless and emits no spurious broadcast.
- **Non-member / invalid target.** The existing `herdMemberError` guard runs first;
  `markObserved` is only called on a valid member, so an unrelated session's status
  is never touched.
- **Maintenance-claim interplay.** disown/resume already refuse while the child is
  under an archive maintenance claim (spec-soft-archive-folder); the `markObserved`
  call sits after those guards, so it never races the reaper.

## Risks and Mitigations

- **Clearing on resume hides a result a human wanted to see.** Mitigation: this is
  the intended semantic (agent-managed children are parent-observed); a human who
  wants the transcript still opens the session normally. Scope is limited to the two
  explicit `caco_herd` actions.
- **Broadcast storm on a bulk disown.** Mitigation: the badge broadcast comes from
  `markObserved`, which emits `session.listChanged` once per actually-unobserved
  child and no-ops otherwise — so a bulk disown of already-observed children emits
  nothing extra, and one of genuinely-unobserved children emits one lightweight
  list-reload event each (the same event the human-observe path already produces).

## Acceptance

- Observable: with a herd child showing the unobserved badge, `caco_herd resume`
  (or `disown`) on it clears the badge and decrements the header unobserved count
  immediately (no manual open); the child stays un-badged after a server restart
  (durable `lastObservedAt`).
- Budgets: n/a (one extra in-process meta write + at most one broadcast per action).
- Gates: `tsc` ×2, `lint:strict`, `knip`, `npm test` (coverage thresholds),
  `build:client`, `check:specs` — all green.
- Oracles:
  - **resume clears** — `caco_herd resume` on an unobserved valid member WITH a
    prompt calls `unobservedTracker.markObserved(childId)`; NOT called for a
    non-member (guard rejects first) NOR for a `resume` missing its `prompt` (that
    validation rejects before the clear).
  - **disown clears** — `caco_herd disown` on an unobserved valid member calls
    `unobservedTracker.markObserved(childId)`, alongside the existing park-into-
    `auto-archive` meta write and bond clear.
  - **idempotent / no-member-leak** — disown/resume of a target that is not
    unobserved does not throw and (via `markObserved`'s own return) emits no badge
    broadcast; an invalid target never reaches `markObserved`.
  - **durable-clear (tracker unit, existing)** — `markObserved` writes
    `lastObservedAt`, so a subsequent `hydrate` over that meta does NOT re-add it
    (already covered by `unobserved-tracker` tests; reference it, don't duplicate).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Import `unobservedTracker`; in the `caco_herd` resume branch, after BOTH the member guard AND the `prompt`-required check, call `unobservedTracker.markObserved(targetId)` | `src/herd-tools.ts`, `tests/unit/herd-tools.test.ts` | resume-clears handler unit (incl. no-prompt ⇒ no call) | markObserved-sole-clear |
| 2 | In the `caco_herd` disown branch, call `unobservedTracker.markObserved(targetId)` alongside the existing park (for a herd-created child) + bond-clear | `src/herd-tools.ts`, `tests/unit/herd-tools.test.ts` | disown-clears handler unit; idempotent/no-member-leak | markObserved-sole-clear |
| 3 | Extend the herd-tools test's `sessionManager`/tracker mocks with `markObserved`; assert call + no-call-for-non-member | `tests/unit/herd-tools.test.ts` | the two handler oracles green | - |

## Rationale (optional)

The user's concrete pain was dozens of disowned herd children left showing the
unobserved badge after a large herd run, with no action that clears them. The clear
already exists (`markObserved`) and is correct-by-design (durable + broadcast); the
only gap is that the two parent actions that logically constitute "observation" —
resume and disown — never invoke it. Routing them through the existing single
clear-path is the minimal, drift-free fix and needs no front-end work.
