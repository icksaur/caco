# spec-rotation-pressure

Make history rotation reach the sessions that actually need it: the large, heavily-used,
permanently-open ones. Amends the trigger policy of `docs/spec-history-rotation.md`; the
transactional copy-verify-swap mechanism itself is unchanged.

## Goals

Rotation exists to keep `events.jsonl` small so cold resume is sub-second. It currently
never fires on the one session that most needs it. Measured on this machine (2026-07-26):

- `~/.copilot/session-state` holds **738.6 MiB** of `events.jsonl` across 53 sessions; a
  single session (`25a33d84`, a daily-driver reviewer) is **438 MiB — 59% of the total**.
- The background sweep runs and reports `[ROTATE-SWEEP] scanned=55 rotated=0` every time.
- That session's `meta.json` has **no `lastRotateAttemptAt`**. Because that field is written
  *immediately before* the expensive work (`session-history-rotation.ts:426`), its absence
  proves rotation has **never once passed the eligibility gates** for this session.
- Consequences beyond slow resume: startup discovery reads all 738.6 MiB synchronously
  (~2.4 s warm, far worse cold), which cost a **failed boot** on 2026-06-16 and 2026-07-26,
  and a **2.6 GB** RSS peak.

The goal is that a session cannot grow without bound merely because the user keeps using it.
Rotation must have a reachable window for a hot, open session — **without** weakening any
correctness invariant of the swap.

**Scope honesty.** This shrinks rotation's *input*; it does **not** fix the startup read
path. Discovery is slow because `readSessionEventsResult` reads whole files to extract
`events[0]` — it would still read every byte of a rotated file. Rotating the 438 MiB session
cuts ~400 MB from that read (≈59% here) and directly fixes cold **resume** for that session,
but the unbounded-read defect is a **separate fix**, tracked separately. Do not read the boot
failures above as "fixed by this spec"; they are the motivation for capping growth, not a
deliverable of it.

Non-goal: changing the cut point, the verify-before-swap, the archive, or crash recovery.
Non-goal: rotating a session that is mid-turn.
Non-goal: stopping/evicting sessions to manufacture a rotation window (see rejected
alternative below).

## Design

### Why it never fires (root cause)

`autoRotateIfEligible` applies six gates. They are not equivalent in kind, and the current
code treats them as if they were:

| Gate | Kind | Justification |
|---|---|---|
| `isBusy`, `isRotating`, `isResuming` | **Correctness** | A mid-turn or mid-swap rewrite can corrupt or race. Non-negotiable. |
| `isActive` (loaded in memory) | **Mechanical** | The SDK holds the session; rewriting under it would desync. But this is *removable* — the session can be stopped first. |
| `isViewed` (a live WS subscriber) | **Courtesy** | Avoid changing scrollback under someone's open tab. |
| `isUnobserved` (result unread) | **Courtesy** | The user is about to read it. |
| size, cooldown, `minIdleAge` | **Policy** | Cheap pre-filters. |

The designed trigger is `stop()` (`session-manager.ts:1287`), which fires *after*
`activeSessions.delete`, so `isActive` is false there — the design did anticipate this. But
for a session that is **open in a tab all day and used constantly**, `isViewed` is true
whenever the tab is up, and `isActive`/`isBusy` are true whenever it is loaded. The
conjunction of courtesy gates with heavy use yields **no window at all**, forever. The
sessions that grow largest are precisely the ones you keep open — so the gate that protects
comfort silently guarantees unbounded growth.

### Fix 1 — pressure escalation, applied at BOTH viewed checks (the core change)

Courtesy gates hold at normal sizes. Past a **pressure ceiling** they no longer do, because
the cost of *not* rotating (multi-second boots for the whole server, GBs of RSS, slow first
click) is borne by the user too, and exceeds the cost of a truncated scrollback.

- `CACO_ROTATE_PRESSURE_BYTES`, default **268435456 (256 MiB)** = 4× the rotate threshold.
- **Below** the ceiling: today's behavior exactly — `isUnobserved` and `isViewed` block.
- **At or above** the ceiling: `isUnobserved` and `isViewed` are **overridden** (logged as
  such). `isBusy`/`isRotating`/`isResuming` are **never** overridden, at any size.

**There are TWO `isViewed` checks and both must honor the same decision.** This is the
subtlety that makes a naive fix useless:

1. eligibility — `autoRotateIfEligible` (`session-history-rotation.ts:401`);
2. **swap-time** — `performRotation` re-checks immediately before the archive+rename
   (`:268`, returning `became-viewed`), because a client may subscribe *during* the
   multi-second isolated verify.

Overriding only (1) would spin up the isolated verify client, spend seconds, and then abort
at (2) for an always-viewed session — burning cost and still never rotating. So the override
is computed **once** as an explicit `allowViewed` decision (derived from size ≥ ceiling) and
**threaded into `performRotation`'s deps**, so both checks agree by construction. The
swap-time check is not deleted: below the ceiling it still protects an on-screen session
exactly as today.

This is safe for a viewer because rotation is a *front*-truncation: `session.start`, every
`user.message`, and everything from the last `session.compaction_complete` are retained. An
open tab's already-rendered transcript is untouched in the DOM; only future scrollback of
pre-cut filler is lost — which is the accepted tradeoff of rotation itself.

### Why evict-then-rotate is NOT needed (rejected alternative)

An earlier draft proposed stopping a loaded-but-idle session so `isActive` would stop
blocking. That is unnecessary complexity and real risk, and is **rejected**:

- `SessionManager.stop()` **already** ends by calling `autoRotateIfEligible`
  (`session-manager.ts:1287`), *after* `activeSessions.delete`, so `isActive` is false at
  that moment. LRU eviction (`MAX_ACTIVE_SESSIONS = 5`, against 53 sessions here) means a
  hot session is stopped routinely. **The window already exists** — the only thing that was
  closing it is the viewed gate, which Fix 1 handles.
- `stop()` has **no busy guard** (`session-manager.ts:1255`), so calling it from the rotation
  path could tear down a session that became busy between the eligibility snapshot and the
  call — directly contradicting this spec's "correctness gates are absolute" invariant.
- It would also trigger a nested `autoRotateIfEligible` from within `autoRotateIfEligible`.

So the sweep continues to skip active sessions (reason `active`) and the `stop()` trigger
does the work. Smaller change, no new race, and it uses the mechanism the original spec
already designed for exactly this.



### Fix 2 — observability (why `rotated=0` was invisible for months)

The sweep's `scanned=55 rotated=0` is a textbook silent no-data sentinel: indistinguishable
from "nothing needed rotating". A maintenance task that can no-op forever must say why.

- `autoRotateIfEligible` returns a **typed skip reason** instead of bare `null`:
  `{ rotated: false, reason: 'disabled'|'unobserved'|'viewed'|'not-idle'|'under-threshold'|'busy'|'active'|'cooldown'|'failed' }`.
  (`null` is retained at the call sites that ignore it; the sweep consumes the reason.)
  When rotation ran but `performRotation` aborted, the reason carries the **rotation result's
  own** abort reason (`became-viewed`, `concurrent-write`, `archive-failed`, verify failure)
  namespaced as `failed:<reason>`, so eligibility skips and swap-time aborts stay
  distinguishable in the log.
- `sweepRotateEligible` aggregates reasons and logs them:
  `[ROTATE-SWEEP] scanned=55 rotated=1 freed=406.0 MB skipped={active:1, under-threshold:52}`.
- Any session **over the pressure ceiling that still did not rotate** is logged at
  `console.warn` with its size and reason — so this class of failure can never again be
  silent for months.

The skip reason is the highest-leverage part of this change: it is what turns the next
occurrence from an archaeology exercise into a log line.

## Invariants

- **Correctness gates are absolute** (invariant): `isBusy`, `isRotating`, and `isResuming`
  block rotation at every size. Pressure escalation can never override them, and rotation
  never stops/evicts a session to create its own window.
- **Verify-before-swap is untouched** (invariant): every guarantee of
  `spec-history-rotation` still holds — the live file is replaced only by a candidate that
  passed a real isolated SDK load, a failure leaves it byte-identical, `session.start` is
  retained, archive-append precedes the swap, and the pre-swap `statSync` re-check still
  aborts on `concurrent-write`. Overriding the *viewed* gate changes **only** which sessions
  are attempted, never how the swap is performed.
- **One viewed decision, both checks** (invariant): the `allowViewed` decision is computed
  once from size and threaded into `performRotation`; the eligibility check and the
  swap-time re-check can never disagree.
- **Escalation is size-triggered only** (invariant): courtesy gates (`isViewed`,
  `isUnobserved`) are overridden if and only if the file is ≥ the pressure ceiling; below it
  behavior is byte-identical to today.
- **Silence is impossible** (invariant): every sweep logs a reason breakdown, and any
  over-pressure session that did not rotate is warned about with its size and reason.

## Considerations

- **Why not simply drop `isViewed`?** At normal sizes it is a good gate — rotating a session
  someone is reading has real cost and little benefit when the file is 70 MiB. The problem is
  only that it has no upper bound. Size-triggered escalation keeps the good behavior and
  removes the unbounded tail.
- **Why 256 MiB?** 4× the 64 MiB rotate threshold: high enough that normal sessions never
  escalate (only 1 of 53 here would), low enough to prevent the 438 MiB pathology. Env-tunable.
- **The `stop()` trigger already exists** and is correct; this spec does not replace it. Fix 1
  makes that trigger effective for a hot session by removing the viewed gate at high sizes —
  the sweep continues to skip loaded sessions (reason `active`), and `stop()` catches them.
- **Sessions between 64 and 256 MiB that are always viewed stay blocked.** That is accepted:
  they are bounded by the ceiling (they will escalate once they cross it), and below it the
  courtesy gate is doing its job. The failure this spec targets is *unbounded* growth, not
  *deferred* rotation.
- **Boot-delay interaction**: the sweeper deliberately waits 60 s at boot "so reconnecting
  clients register as viewers first" — i.e. the current design *intends* viewers to block.
  That intent is preserved below the ceiling and deliberately inverted above it.
- **This does not fix startup discovery.** Discovery reads all 738 MiB because
  `readSessionEventsResult` reads whole files to extract `events[0]`; rotation shrinks the
  input but the read is still unbounded-by-design. That is a separate fix (tracked
  separately) and this spec must not be mistaken for it.
- **`lastIdleAt` vs `lastUsedAt` skew**: the observed session had `lastIdleAt` 9.3 h old but
  `lastUsedAt` 14 min old. The sweep's 4 h `minIdleAge` reads `lastIdleAt`, so a session in
  constant use can still look "idle" by that measure. Not changed here (the correctness gates
  catch the live cases), but noted because it makes `minIdleAge` weaker than it appears.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Truncating history under an open tab | Only ≥256 MiB; front-truncation retains `session.start`, all user messages, and the post-compaction tail; rendered DOM is unaffected; logged loudly |
| Evicting a session the user is about to use | Eviction only after all cheap+correctness gates pass; the session is idle; resume reloads it (routine LRU behavior) |
| Racing a turn that starts during rotation | Unchanged from `spec-history-rotation`: the per-session rotation lock plus the re-`statSync` before swap abort on any change |
| Escalation misfiring on normal sessions | Ceiling is 4× threshold and env-tunable; oracle asserts sub-ceiling behavior is byte-identical to today |
| Skip-reason plumbing changes call sites | Existing callers ignore the return value; the sweep is the only consumer; typed union keeps it a compile error to add a reason and not handle it |

## Acceptance

- Observable: the 438 MiB session rotates the next time it is stopped (LRU eviction or
  explicit stop), freeing ~400 MB, and the sweep logs a reason breakdown instead of a bare
  `rotated=0`.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client, check:specs.
- Oracles:
  - **correctness gates absolute** — a busy/rotating/resuming session does **not** rotate
    even at 10× the pressure ceiling; reason is `busy`. No code path stops or evicts a
    session in order to rotate it.
  - **both viewed checks honor the override** — with a viewed session at/above the ceiling,
    `performRotation` receives `allowViewed: true` and **does not** return `became-viewed`;
    the swap completes. With the same session below the ceiling, eligibility returns
    `viewed` and `performRotation` is **never invoked** (no wasted verify).
  - **swap safety preserved under the pressure path** (MUST) — with `allowViewed: true`:
    a verify failure still leaves the live file **byte-identical**; a `concurrent-write`
    (size/mtime changed during verify) still **aborts** the swap; archive-append failure
    still aborts before any rename; `session.start` is still line 1 of the result. I.e.
    overriding the courtesy gate changes attempt selection only, not swap integrity.
  - **escalation** — a viewed + unobserved session **under** the ceiling does not rotate
    (reasons `viewed`/`unobserved`); the **same** session at or above the ceiling **does**,
    and the override is logged.
  - **sub-ceiling parity** — for every gate combination below the ceiling, the decision is
    identical to the pre-change implementation (table-driven).
  - **observability** — the sweep aggregates skip reasons; an over-pressure non-rotating
    session emits a `console.warn` carrying its size and reason; a swap-time abort is
    reported as `failed:<reason>` (e.g. `failed:concurrent-write`), distinct from an
    eligibility skip.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Typed `RotationSkip` reason union; `autoRotateIfEligible` returns it (callers ignoring the value unchanged); swap-time aborts surface as `failed:<reason>` | `src/session-history-rotation.ts` | reason returned for each gate — unit table | silence-impossible |
| 2 | Pressure ceiling `CACO_ROTATE_PRESSURE_BYTES` (default 256 MiB); compute `allowViewed` once and **thread it into `performRotation` deps** so both the eligibility check (`:401`) and the swap-time re-check (`:268`) honor it; never override correctness gates | `src/session-history-rotation.ts` | both-viewed-checks + escalation + correctness-absolute + sub-ceiling parity oracles | one-viewed-decision, escalation-size-triggered, correctness-absolute |
| 3 | Swap-safety regression coverage on the `allowViewed` path (verify-failure byte-identity, concurrent-write abort, archive-failure abort, `session.start` retained) | `tests/unit/session-history-rotation.test.ts` | swap-safety-preserved oracle | verify-before-swap-untouched |
| 4 | Sweep aggregates + logs reason breakdown; `console.warn` for over-pressure non-rotations | `src/session-history-rotation.ts` | sweep log oracle | silence-impossible |
| 5 | Full gate | `npm run build` | green | — |

## Rationale

The gates were written as a flat list of booleans, which hid that they are three different
kinds of thing: correctness requirements, a removable mechanical constraint, and courtesies.
Treating a courtesy (`isViewed`) with the same absoluteness as a correctness requirement
(`isBusy`) is what produced a 438 MiB file on a machine whose rotation subsystem was working
as written and reporting success. Separating the three kinds — absolute, step, bounded —
keeps every safety property of the swap while removing the unbounded tail. The typed skip
reason is the durable part: it converts a subsystem that could silently do nothing for
months into one that says exactly why on every pass.
