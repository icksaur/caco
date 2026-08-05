# spec-defer-default-inversion

**Status:** draft, reviewed once (findings folded). Amends `spec-tool-reveal`
phase C1, which introduced `DEFER_ELIGIBLE_CACO_TOOLS`. Supersedes that constant.

## Goals

A **built-in Caco** tool is deferrable by default. Only four are protected, named
in one blocklist with a stated reason each. Adding a new built-in no longer
silently adds permanent per-turn cost, and the operator cannot poison defer state
with a pseudo-server name.

Measured on the live instance (`GET /api/mcp/servers`, Caco pseudo-server): 26
tools = 13 defer-eligible, 11 enabled-and-always-sent at **4,235 tokens/turn**, 2
hard-disabled at zero cost (`register_mcp_server`, `caco_session_store_sql`).
Eight of the always-sent are rare-to-idle and total **2,292 tokens**:

`restart_server` 116 · `get_session_state` 100 · `create_caco_session` 437 ·
`caco_session_delegate` 411 · `caco_herd_state` 136 · `caco_herd` 549 ·
`caco_memory` 225 · `index` 318

They are always-sent by omission, not decision.

## Design

**Invert the default.** `DEFER_ELIGIBLE_CACO_TOOLS` (an allowlist of what MAY
defer) becomes `NEVER_DEFER_CACO_TOOLS` (a blocklist of what MAY NOT).
`isDeferEligibleCacoTool(name, { hardDisabled })` returns
`!hardDisabled && !NEVER_DEFER_CACO_TOOLS.includes(name)`.

That is the whole change: the current default is "always sent", so a new tool is
born permanently expensive and stays so until someone updates a hand-maintained
list in a different file. All eight stale tools arrived that way. Inverting makes
the forgetful path the cheap path — forgetting now costs a recoverable enable
round-trip instead of silent per-turn rent.

**The protected four**, each for a reason that outlives a usage argument:

- `caco_enable_tools` — the only path back. Deferring it is unrecoverable.
- `caco_run_workflow` — the shell; used continuously (<1m idle).
- `retrieve_output` — shaped output leaves an `out_…` handle in the transcript
  that only this tool redeems. Deferring it strands a promise already made.
- `caco_docs` — a **discovery** tool. See the hazard below.

**The discovery hazard.** Usage-driven deferral is self-reinforcing for any tool
whose job is to reveal something: deferred ⇒ invisible ⇒ unused ⇒ stale forever.
`caco_docs` shows 141h idle, the highest in the set, while being the only
currently-eligible Caco tool — that idleness is substantially an artifact of the
deferral, not independent evidence of disuse. The counter-argument is real and
recorded here: `caco_enable_tools` with no arguments lists deferred tools *with
descriptions*, so docs stay nominally discoverable. The protection is therefore a
**judgment call, not a proof** — it trades 478 tokens/turn against a feedback loop
no usage signal can detect. Every other tool relies on the live staleness
recompute instead (see Invariants).

**Extension tools are OUT OF SCOPE.** `getCacoToolCatalog()` is populated from
`allTools`, which includes `extensionTools` (`server.ts` ~line 266). Under the old
allowlist no extension could ever auto-defer; a naive inversion would silently
make every third-party plugin tool deferrable. That is a behavior expansion the
user did not ask for, and one a fixed four-name blocklist **cannot** express a
protection for, since extension tools are dynamic and unknown at author time.

Therefore `CacoToolCatalogEntry` gains `origin: 'builtin' | 'extension'`, stamped
at the single registration site in `server.ts` where the arrays are already
separate, and only `origin === 'builtin'` tools are candidates. This preserves the
old scope boundary exactly. Extension deferral, if wanted, needs its own opt-in
mechanism and its own spec.

**Candidate enumeration moves to the catalog.** The old constant doubled as the
candidate universe (`computeStaleDeferCandidates`:
`DEFER_ELIGIBLE_CACO_TOOLS.map(cacoKey)`). Inverted, it can no longer enumerate,
so candidates become
`getCacoToolCatalog().filter(origin === 'builtin' && !hardDisabled && !neverDefer)`.

Excluding `hardDisabled` is required, not cosmetic: the two hard-disabled tools
already cost zero, so deferring them would add entries to every session's
exclusion set for no saving.

**One eligibility predicate.** `wouldDefer` in the `/servers` payload
(`workspace-api.ts` ~line 370) currently calls `isDeferEligibleCacoTool(name)`
while candidate selection would additionally filter `hardDisabled` — two rules for
one question, drift today masked only by render order. Both must call the same
predicate with the same arguments.

**Guard the pseudo-servers — as hygiene, not as a lockout fix.**
`POST /api/mcp/servers/:server/defer` accepts any server name.
`setServerDeferred('Caco')` resolves keys via `keysForServer`, which iterates the
**learned MCP key registry**; Caco tools are never registered there, so it returns
`[]` and the call is **inert today**. An earlier draft of this spec claimed it
would strip `caco_enable_tools` — that was wrong, and the correction matters: the
guard is defense-in-depth and state hygiene, stopping a meaningless name from
entering persisted state and rendering a confusing deferred badge. Inertness here
is incidental rather than designed, which is reason enough to make it explicit.
The read path additionally filters pseudo-server names out of
`manual-defer.json`, since a write-path guard cannot clean entries already
persisted.

**`restart_server` loses its exemption.** C1 kept it always-on to avoid an enable
round-trip before a restart. Only one session ever needs it, and it is 12h idle.

## Invariants

- **The escape hatch is always reachable** — `caco_enable_tools` is never
  deferrable by any path (staleness, manual defer, or server defer).
- **Latched ⇒ operator-clearable** (C1, unchanged): Caco tools never enter the MCP
  auto-defer latch, because the latch's only clear path is per-MCP-server operator
  un-defer and a Caco pseudo-server has no such control. They ride the **live
  staleness recompute**, re-evaluated at cold seams, so a tool used in any session
  is sent again at the next cold seam. This is what makes deferral reversible for
  the other twenty tools, and it must survive the eligible set growing.
- **Deferral only ever hides a tool that is otherwise sent** — hard-disabled tools
  are never candidates.
- **One predicate**: the applet's `wouldDefer` badge and the resume-time decision
  call the same function with the same arguments, so the view cannot disagree.
- **Catalog-before-decision ordering**: `create`/`resume` invoke the tool factory
  (which registers the catalog) before defer computation runs. The catalog is not
  "populated at startup" in any absolute sense; this ordering is the guarantee.

## Considerations

- **Reactive tools.** `caco_herd_state`, `caco_session_delegate`,
  `get_session_state` are needed when an external event wakes the agent. Deferring
  costs an enable round-trip precisely then. Autocontinue usually makes this
  automatic, but it is **conditional** on the user preference and the retry cap —
  with autocontinue off, recovery costs one extra human turn. Accepted: the
  alternative is 647 tokens every turn for a rare event.
- **Protecting `caco_docs` costs tokens not paid today** — it is currently
  deferred, so this adds 478 tokens/turn back. Stated plainly: best case moves
  4,235 → 2,421 (−1,814), not → 1,943.
- **`index` is fresh** (3m idle) and will not defer under the staleness rule. No
  special case — this is the rule working.
- **Empty/partial catalog** ⇒ no Caco candidates ⇒ nothing defers. Safe direction
  (over-send, never over-hide).

## Risks and Mitigations

- **A tool the operator needs goes quiet.** Mitigated by the deferred-tool
  discovery listing and by the live staleness recompute returning it once used.
- **Extension tools deferring unexpectedly.** Eliminated by the `origin` filter,
  not merely documented.
- **Cache churn.** Changing eligibility defers nothing by itself; the next cold
  seam does. No warm session is mutated (C2).
- **Losing the escape hatch.** Two independent protections — the name blocklist
  and the pseudo-server guard — each separately tested.

## Acceptance

- Observable: the mcp-servers applet shows the eight named tools carrying a
  "would defer" marker, and a cold resume drops them from the turn. The ~2,292
  token drop is **observational**, not a gate — no reproducible fixture pins a
  live token count.
- Gates: `npm run build` green.
- Oracles: the candidate set for a fixture catalog equals an expected name list
  (row 2) — the checkable form of the token claim — plus the per-row oracles
  below. Each must fail before its change exists.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Replace the allowlist with `NEVER_DEFER_CACO_TOOLS` (the four); `isDeferEligibleCacoTool(name, {hardDisabled})`; rewrite the comment that wrongly names `caco_docs` as never-deferring while listing it deferrable | `src/tool-registry.ts`, `tests/unit/tool-registry.test.ts` | hand table: the four ⇒ not eligible; a hard-disabled name ⇒ not eligible; every other catalog name ⇒ eligible | escape-hatch, only-hides-sent |
| 2 | Add `origin: 'builtin'\|'extension'` to `CacoToolCatalogEntry`, stamped at the `server.ts` registration site; enumerate candidates from the catalog filtered by `origin==='builtin' && !hardDisabled && !neverDefer` | `server.ts`, `src/session-manager.ts` (`computeStaleDeferCandidates`, `CacoToolCatalogEntry`) | ref-impl: fixture catalog (builtin + extension + hard-disabled + protected) ⇒ candidate set equals expected list; extension tool never a candidate; empty catalog ⇒ [] | only-hides-sent, latched⇒clearable, catalog-before-decision |
| 3 | Update the existing tests that import or mock the removed constant | `tests/unit/session-manager-cold-resume-defer.test.ts`, `tests/unit/session-manager-deferred-defs.test.ts` | those suites green (they fail on removal otherwise) | - |
| 4 | Align `wouldDefer` to the single predicate (pass `hardDisabled`) | `src/routes/workspace-api.ts`, payload test | payload test: a hard-disabled tool never reports `wouldDefer` | one-predicate |
| 5 | Refuse `POST /servers/:server/defer` for pseudo-servers via exported `isPseudoServer`; filter pseudo names on the `manual-defer.json` read path | `src/tool-registry.ts`, `src/routes/workspace-api.ts`, `src/manual-defer-store.ts`, `tests/unit/pseudo-server-defer-guard.test.ts` | route test: `Caco` ⇒ 400, real MCP server ⇒ 200; store test: a persisted `Caco` entry is ignored on load | escape-hatch |
| 6 | Amend `spec-tool-reveal` C1 to point here; update `API.md` if the defer route documents server scope | `docs/spec-tool-reveal.md`, `API.md` | `npm run check:specs`; API route-coverage test | - |

## Rationale

The bug was never the contents of the list — it was that a list existed on that
side of the default. An allowlist of what MAY defer means forgetting costs
*permanent silent rent*, on every turn of every session. A blocklist of what may
NOT defer means forgetting costs a recoverable round-trip. The second is the
direction a careless change should fall.
