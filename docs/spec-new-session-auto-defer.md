# spec-new-session-auto-defer

Extends spec-tool-reveal Phase C. Call this **C3**.

## Goals

A freshly-created session starts lean: system-wide **stale** tools (the same
verdict C2 applies on a cold resume) are seeded into the new session's
`excludedTools` at `create()`, not just on cold resume. Short-lived usage
patterns — process up a few hours, several sessions, never idle long enough to
trigger a cold resume — now benefit from auto-defer instead of always paying the
full tool catalog. Recoverable as ever: the agent reveals any needed tool in one
`caco_enable_tools` call.

## Design

**Problem.** C2 auto-defer fires only on a *cold resume* (`isColdResume` =
`now − lastUsedAt > COLD_RESUME_STALE_MS`). A brand-new session has no
`lastUsedAt`, so `create()` never auto-defers (parent spec, Plan row C2:
"create never auto-mutated"). A session that lives and dies inside the cold
window gains nothing.

**Change.** At `create()`, seed the same system-wide staleness verdict.
`create()`'s seed becomes: `base (builtins) ∪ manualDeferredKeys() ∪
newSessionAutoDefer()`.

**No coldness gate at create (mechanism → this is structural, state as fact).**
A cold resume needs the `COLD_RESUME_STALE_MS` gate because a *warm* resume would
bust an existing provider prompt-cache prefix. A brand-new session has no prefix
cache to bust, so applying exclusions at creation is unconditionally free —
exactly like manual defer, which already always applies at `create()`. There is
therefore no coldness gate on the create path.

**Shared verdict (refactor).** Extract the candidate-universe + staleness math
shared by C2 and C3 into one private helper on `SessionManager`:

- `computeStaleDeferCandidates(usedHere: ReadonlySet<ToolKey>): ToolKey[]`
  candidates = `allLearnedKeys()` ∪ `DEFER_ELIGIBLE_CACO_TOOLS.map(cacoKey)`;
  `computeColdResumeExclusions({ isCold: true, tools: dedupe(candidates),
  lastUsed: getLastUsedActiveSeconds(), nowActiveSeconds: getNowActiveSeconds(),
  threshold: DEFER_STALE_THRESHOLD_ACTIVE_SECONDS })` minus `usedHere`.

Then:
- `computeColdResumeAutoDefer(sessionId, config)` = `if (!isColdResume) return [];
  return computeStaleDeferCandidates(getToolsUsed(sessionId))` (unchanged
  behavior; now delegates the universe/staleness math).
- `computeNewSessionAutoDefer()` = `computeStaleDeferCandidates(EMPTY_SET)`. A
  new session has no per-session used-here history (its id does not yet exist in
  the throughput map), so the protecting set is empty. Cross-session freshness is
  still honored: the shared active-seconds clock keeps a tool used *anywhere* in
  the last 2 active-hours non-stale, so it will not be deferred.

`create()` (src/session-manager.ts ~717) unions `computeNewSessionAutoDefer()`
into `seededExclusions` before `createSession`. Logs `[DEFER] new-session
auto-defer <id8>: deferred=N candidates=M ...` mirroring the C2 diagnostic.

**Single staleness definition preserved.** Both create and cold-resume, plus the
applet's `wouldDefer` badge and `/servers` payload, route through
`computeColdResumeExclusions` fed the one shared threshold. No second copy of the
staleness rule. (The *final* defer set is that staleness further filtered by
coldness and used-here, so the applet `wouldDefer` view pins staleness, not a
session's exact live exclusions.)

## Invariants

- **Single staleness verdict.** There is exactly one *staleness* verdict function
  (`computeColdResumeExclusions` + `DEFER_STALE_THRESHOLD_ACTIVE_SECONDS`), which the
  applet `wouldDefer` badge, cold-resume, and create all consume. C3 must not fork it.
  Note this pins staleness, NOT the final defer decision: the actual set deferred is
  staleness filtered further by coldness (resume only) and used-here protection, so
  the applet's `wouldDefer` view may legitimately differ from a given session's live
  exclusions.
- **Defer never breaks capability.** Every deferred tool remains re-enableable via
  `caco_enable_tools`. C3 only defers defer-eligible keys (learned MCP ∪ the Caco
  allowlist); builtins/policy-disabled are untouched (already in the base seed).
- **Warm sessions are never auto-shrunk.** C3 mutates only the create seed of a
  brand-new session (no prefix cache). Warm recreates (model switch, context-budget)
  and warm resumes remain untouched — unchanged from C2.

## Considerations

- **First session after a fresh/empty usage store.** Every learned candidate is
  "never used" ⇒ maximally stale ⇒ deferred. Bounded: the candidate universe is
  `allLearnedKeys()` (only MCP tools observed at least once) ∪ the fixed Caco
  allowlist — on a truly cold process where nothing has been learned yet, this is
  small/empty. This matches existing C2 behavior on a fresh cold resume and is
  fully recoverable via reveal.
- **Cross-session freshness.** A tool used in another still-open session minutes
  ago is fresh via the shared clock, so a new session will not defer it — correct
  and desirable.
- **Compute cost at create.** `computeNewSessionAutoDefer` reads two in-memory
  maps + one array scan; negligible on the create path.
- **Create is an intentional active-clock tick source.** `computeStaleDeferCandidates`
  calls `getNowActiveSeconds()`, which advances the shared active-seconds clock by the
  capped wall gap since the last tick. Making create a tick source is intentional and
  correct: session creation is genuine active work. It cannot *over*-age tools — the
  clock advances by real elapsed wall-time regardless of call frequency (a burst of
  creates adds ~0 each), and every gap is capped at `MAX_ACTIVE_GAP_SECONDS`. So
  repeated/rapid session creation does not accelerate staleness.
- **Placement in create().** The seed is computed while `sessionRef.id` is
  `'PENDING'`; used-here is necessarily empty there, so pass the empty set
  explicitly rather than `getToolsUsed('PENDING')`.

## Risks and Mitigations

- **Over-aggressive lean on the very first session of a process** (learned keys
  exist from a prior run's persisted registry but the active clock is fresh).
  Mitigation: recoverable via `caco_enable_tools`; identical to C2's fresh-cold
  behavior; the applet shows the same verdict so it is not surprising.
- **Behavior drift between create and resume paths.** Mitigation: both call the
  same `computeStaleDeferCandidates`; the only difference (coldness gate,
  used-here set) is explicit and each is unit-pinned.

## Acceptance

Status: implemented (C3). Gate green (1656 tests); pending operator applet signoff.

- Observable: create a new session in a process where some learned MCP tool is
  stale/never-used and another was used within the window; the mcp-servers applet
  shows the stale one as `deferred` (green) and the fresh one `active` on the new
  session, with no cold resume involved. Operator signoff on the applet view.
- Budgets: no measurable added latency on `create()` (in-memory reads only).
- Gates: `npm run build` / `tsc`, `npm run lint:strict`, `npm run knip`,
  `npm test` (vitest), `npm run build:client`, `check-spec-conformance` — all green.
- Oracles:
  - `computeNewSessionAutoDefer` unit (new): never-used eligible tool ⇒ deferred;
    a stamped (fresh) tool ⇒ kept; applies regardless of `config` (no coldness
    gate — no `lastUsedAt` still defers); unlearned MCP key ⇒ never a candidate.
  - C2 regression: existing `session-manager-cold-resume-defer.test.ts` stays
    green after the extract (behavior-preserving delegation).
  - create seam: seeded `excludedTools` on a new session = `base ∪ manual ∪
    computeNewSessionAutoDefer()` (assert the stale key is present, the fresh key
    absent).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Extract `computeStaleDeferCandidates(usedHere)`; re-express `computeColdResumeAutoDefer` as `isColdResume`-gate + delegate | `src/session-manager.ts` | C2 regression suite stays green | single-verdict |
| 2 | Add `computeNewSessionAutoDefer()` = `computeStaleDeferCandidates(new Set())`; log `[DEFER] new-session` | `src/session-manager.ts` | new unit: stale⇒deferred, fresh⇒kept, no-gate, unlearned⇒skip | single-verdict; defer-never-breaks |
| 3 | Union `computeNewSessionAutoDefer()` into `create()` `seededExclusions` | `src/session-manager.ts` (~717) | create seam: seed = base∪manual∪autodefer | warm-never-shrunk (create only) |
| 4 | Amend the parent spec: retitle/reword Phase C so "cold-resume-only" becomes "cold-resume + create (the two cache-free seams)", update the Design statement that "create never auto-mutates", and add C3 to the Plan; keep the C2 row accurate | `docs/spec-tool-reveal.md` (Phase C title ~153, Design/invariant language, Plan rows) | grep parent for "cold-resume-only"/"create never" ⇒ no stale contradiction | single-staleness-verdict |
| 5 | Set this spec status done; note in `docs/spec-deferred-savings.md` if the footer figure now also reflects create-time defers | `docs/spec-new-session-auto-defer.md` | — | — |

## Rationale (optional)

C2 restricted auto-defer to cold resume because that is the only *resume* path
where deferral is provably free of a cache-bust. Creation was lumped in with the
"don't auto-mutate" cases, but creation is categorically different: there is no
session yet, hence no cache and no cost. C3 corrects that oversight — the same
staleness verdict, applied at the one other free seam — so the lean-by-default
benefit no longer requires a session to first go cold. Manual defer already sets
the precedent of always seeding a new session; C3 makes usage-driven defer follow
the same rule.
