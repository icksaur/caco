# spec-herd-depth-breadth

## Goals

A herd parent (or any agent) can dispatch to **many** children in one turn without
the runaway guard falsely rejecting the 3rd+ with "Effective call depth N exceeds
limit (max 2)". A flat herd is depth-1 by design (Guardrail 1), so fan-out to N
children must not read as depth N. Genuine nesting (A delegates to B delegates to
C…) is still bounded. Fixes `caco_herd create`/`resume` fan-out and the same latent
conflation in `caco_session_delegate`.

## Design

**Root cause.** The runaway guard reconstructs "depth" from a per-correlation chain
of call **targets** and collapses only when a call returns to a session already in
the chain. Herd dispatches are **fire-and-forget** (the parent's tool call returns
HTTP 200 immediately; the child runs async), so a parent resuming children A, B, C
under its one live correlationId records `[A]`→`[A,B]`→`[A,B,C]` with no return
frame — breadth is counted as depth. `AGENT_MAX_DEPTH` (2) then rejects the 3rd
child.

**The correct model is push on call, pop on return.** A fire-and-forget dispatch
pushes the child, then immediately pops back to the caller (the caller does not
block), so siblings sit at the same level. A herd child completing and waking its
parent is likewise a **pop** back to the parent's level, not a deeper push. The
parent is a supervisor at the root of its herd sub-flow.

**Mechanism chosen — server-derived hop-count, carried on the live dispatch.**
Depth is an integer attached to each active dispatch (in `dispatch-state`, alongside
`correlationId`), and the server **derives** it — it is never taken from a
caller-supplied field:

- A **root** entry into the agent mesh — a user/applet/scheduler message, AND the
  herd **wake** (`source:'system'`, no `fromSession`) — is `depth = 1`. The wake
  being non-agent-sourced IS the pop: a parent re-woken by a child completion
  re-enters at its baseline, not one deeper.
- An **agent-to-agent** call (`source:'agent'`) MUST carry a `fromSession` with a
live dispatch; the route sets `depth = getDepth(fromSession) + 1` (the push) from
the CALLER's live dispatch depth and rejects (400) an absent/inactive caller. The
caller is busy mid-tool-call when it dispatches, so `getDepth(fromSession)` is its
current depth; nothing in the request carries depth, so it cannot be understated.
- An **auto-continue** — a same-session continuation that calls `dispatchMessage`
  directly (not via the route) after a tool reveal — **preserves** the revealing
  dispatch's depth (captured when the reveal was recorded). It is NOT a root and is
  NOT reset to 1; continuing nested work must not regain delegation budget.
- The guard rejects a dispatch whose `depth > AGENT_MAX_DEPTH`.

Fan-out: a parent at depth 1 dispatches to A, B, C, … each `getDepth(parent)+1 = 2`
— flat for any N. Nesting: `P→A` (2) `→B` (3) `→C` (4, rejected). Re-baseline
`AGENT_MAX_DEPTH` 2→3 so today's allowance (2 agent hops: `P→A→B` allowed, `B→C`
rejected) is preserved exactly — the +1 is the now-counted root.

**Why over the alternatives.** Depth is a property of the **dispatch**, derived from
the caller's live depth, not shared mutable per-session state and not caller input.
It needs no correlation chain, no `depthMap`, and no `collapseChain`. Because a
session dispatches serially, `getDepth(caller)` is stable for the caller's whole
turn, so the hard cases of a stateful design vanish: interleaving (each dispatch
carries its own depth), re-entry (a deep session's outbound call derives caller+1 →
rejected), re-parent (a fresh shallow inbound gives the session a shallow depth for
that turn), and concurrency (no shared write to race; the child's depth is fixed at
the route from the caller's live depth). The correlation guard keeps doing rate +
age unchanged; only the depth rule moves to the hop-count. `chain-stack.ts`/
`collapseChain` and the correlation **depth** logic are deleted.

**Seam.** `dispatch-state`'s `ActiveDispatch` gains `depth`, set at `startDispatch`;
`getDepth(sessionId)` exposes it. `dispatchMessage` takes an optional `depth` that
**defaults to 1** (root), so every direct caller that bypasses the message route —
skill-invoke and fork-notice (`sessions.ts`), which are genuine roots — gets depth 1
without change, while auto-continue passes its captured prior depth explicitly. The
message route computes the value for its dispatches: `source:'agent'` → reject (400)
unless `fromSession` has a live dispatch, else `getDepth(fromSession) + 1`; non-agent
roots (incl. herd wake) → `1`; then reject `depth > AGENT_MAX_DEPTH` for agent calls
and thread it into `dispatchMessage` → `startDispatch`. The route enforces a
**biconditional** `source:'agent' ⟺ fromSession` (mismatch → 400), so a request
cannot carry `fromSession` while dodging agent-depth derivation, nor claim agent
source without a caller. No POST-body `depth` field exists; agent dispatchers are
unchanged beyond already sending `fromSession`.

## Invariants

- **Depth is server-derived from a LIVE caller, never caller-supplied.** An agent
  call (`source:'agent'`) MUST carry a `fromSession` whose live dispatch depth is
  defined; the route sets `depth = getDepth(fromSession) + 1` and **rejects (400)**
  an agent call with an absent `fromSession` or an inactive caller (no live
  dispatch). There is no POST-body depth to spoof and no default-to-root fallback,
  so an idle/absent/fabricated caller cannot mint a shallow depth. (A real
  delegation always has a busy caller — the caller is mid-tool-call when it
  dispatches.)
- **Every non-agent root entry is depth 1; the herd wake is one of them.**
  User/applet/scheduler messages and the herd completion wake (`source:'system'`, no
  `fromSession`) are depth 1 — the wake's pop is by construction. A flat fan-out is
  uniformly depth 2.
- **A same-session continuation preserves its depth.** Auto-continue is NOT a root:
  it re-dispatches the same session to finish the same work and carries the revealing
  dispatch's depth, so nested work cannot regain budget by revealing a tool.
- **Serial dispatch ⇒ the caller's depth is stable.** A session processes one
  dispatch at a time (`isBusy → 409`), so `getDepth(fromSession)` read at the route is
  the depth of the message the caller is currently processing — no shared-state race.
- **`source:'agent' ⟺ fromSession` (biconditional route contract).** The route
  rejects (400) a `source:'agent'` request without `fromSession` AND a `fromSession`
  on a non-agent request, so agent-depth derivation cannot be dodged by mismatching
  the two, and `correlationId` still accompanies both (rate/age keying).
- **Direct `dispatchMessage` callers default to root depth 1.** Callers that bypass
  the message route (skill-invoke, fork-notice) are genuine roots and take the
  default; auto-continue is the sole direct caller that passes an explicit
  (preserved) depth.
- **Rate/age unchanged.** The correlation guard still bounds call rate and flow age
  per `correlationId`; only the depth rule leaves it. Existing rate/age oracles stay
  green.
- **Runaway guard preserved** (spec-session-orchestration): agent↔agent messaging
  still passes the guard; genuine deep nesting past `AGENT_MAX_DEPTH` is rejected.

## Considerations

- **Auto-continue depth capture.** The revealing dispatch's depth is captured when
  the reveal is recorded (`addPendingTools`, while the dispatch is live so
  `getDepth` is set) and consumed by the continuation's direct `dispatchMessage`
  call; cleared with the rest of the auto-continue state (`resetAutoContinue`).
- **Baseline of a nested herd parent.** A herd parent that is itself a delegate
  child (home depth > 1) is still re-woken at depth 1, so its herd sub-flow gets the
  full 2-hop budget from 1 rather than its true depth — a deliberate, bounded
  leniency: Guardrail 1 keeps herds flat (no herd-of-herds) and rate/age still bound
  volume. Documented, not a runaway risk.
- **`AGENT_MAX_DEPTH` re-baseline 2→3.** Counting the root adds one frame; 3
  preserves 2 agent hops. Any test pinning the old default value updates.

## Risks and Mitigations

- **Re-baseline lets deeper nesting through.** Mitigation: hand-case oracle — `P→A`
  (2), `A→B` (3) allowed; `B→C` (4) rejected. Identical hop count to today.
- **Continuation regains budget.** Mitigation: auto-continue preserves the captured
  revealing-dispatch depth (not reset to 1); oracle drives a deep session that
  reveals a tool and asserts its continuation stays at the same depth.
- **Rate/age accidentally changed.** Mitigation: the depth rule leaves the
  correlation guard untouched; the existing rate/age oracles pass unmodified.

## Acceptance

- Observable: the reported parent (`44ce5bcd…`) resumes ≥3 children in one wake with
  no depth rejection; creating ≥3 children with prompts in one turn succeeds for
  every child.
- Budgets: n/a (one integer per active dispatch; no per-correlation depth state).
- Gates: `tsc` ×2, `lint:strict`, `knip`, `npm test` (coverage thresholds),
  `build:client`, `check:specs` — all green.
- Oracles (expected depths hand-authored from the hop-count rule, not reusing
  production code):
  - **Fan-out** — caller live at depth 1 dispatches to A,B,C,D,E; each derived depth
    = 2; all allowed for any N. Breadth ≠ depth.
  - **Nesting** — caller at depth 2 → child depth 3 allowed; caller at depth 3 →
    child depth 4 rejected. Preserves the 2-hop allowance under the re-baseline.
  - **Wake-pop** — a `source:'system'` wake (no `fromSession`) resolves to depth 1
    regardless of the completing child's depth, so the parent's subsequent resume is
    depth 2. Proves the pop.
  - **Continuation-preserves-depth** — a session running at depth 3 reveals a tool;
    its auto-continue dispatch carries depth 3 (not 1), so its own outbound call is
    depth 4 → rejected. Proves a continuation is not a root.
  - **Server-derived (no trust)** — the child's depth equals `getDepth(fromSession)
    + 1` from the caller's live dispatch; there is no body field consulted (route-
    harness: the same agent call from a depth-2 vs depth-3 caller yields child depth
    3 vs 4).
  - **Absent/idle caller rejected** — a `source:'agent'` request with no
    `fromSession`, or a `fromSession` that has no live dispatch, → 400 (no
    default-to-root). Closes the undercount/fabricated-caller path.
  - **Biconditional contract** — `source:'agent'` without `fromSession` → 400; a
    non-agent request carrying `fromSession` → 400. No mismatch bypass.
  - **Direct-dispatch roots** — a skill-invoke / fork-notice dispatch (bypassing the
    route) resolves to the default depth 1; auto-continue passes its captured depth.
  - **Root sources** — user/applet/scheduler dispatch resolves to depth 1.
  - **Rate unaffected** — existing `correlation-metrics.test.ts` rate/window oracles
    pass unchanged; depth no longer participates in the correlation chain.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `depth` to `dispatch-state` `ActiveDispatch`; `start(sessionId, correlationId, depth)`; `getDepth(sessionId)` | `src/dispatch-state.ts`, `tests/unit/dispatch-state.test.ts` | unit: stored depth round-trips; unknown → undefined | serial-dispatch-depth |
| 2 | Thread `depth` through `startDispatch`→`dispatch-state.start`; `dispatchMessage` accepts an optional `depth` **defaulting to 1** (so direct root callers — skill-invoke, fork-notice — get depth 1 unchanged) | `src/session-manager.ts`, `src/routes/session-messages.ts`, `src/routes/sessions.ts` | unit: startDispatch stores the given depth; direct callers default to 1 | depth-server-derived |
| 3 | Route: enforce the biconditional `source:'agent' ⟺ fromSession` (mismatch → 400); derive agent depth = `getDepth(fromSession)+1` (reject 400 if caller has no live dispatch; body NOT consulted); non-agent roots → 1; reject `depth > AGENT_MAX_DEPTH`; pass depth into `dispatchMessage` | `src/routes/session-messages.ts` (+ small guard helper), `tests/unit/session-messages-route-harness.test.ts` | route-harness: fan-out (caller 1 → children 2), nesting (caller 3 → child 4 rejected), wake-pop, root-sources, absent/idle-caller → 400, biconditional-mismatch → 400 | depth-server-derived; agent-iff-fromSession; runaway-guard-preserved |
| 4 | Capture the revealing dispatch's depth at `addPendingTools` (getDepth while live); expose it; auto-continue passes it as the `depth` option; clear with `resetAutoContinue` | `src/session-manager.ts`, `src/routes/session-messages.ts` (runAutoContinue), tests | continuation-preserves-depth oracle | continuation-preserves-depth |
| 5 | Remove the depth rule from the correlation guard: delete `collapseChain`/`getEffectiveDepth`/`chain-stack.ts`; `CorrelationMetrics`/`RunawayRulesEngine` keep only rate + age | `src/correlation-metrics.ts`, `src/rules-engine.ts`, `src/chain-stack.ts` (delete), `tests/unit/correlation-metrics.test.ts`, `tests/unit/rules-engine.test.ts`, `tests/unit/chain-stack.test.ts` (delete) | rate/age oracles unchanged; no depth logic remains | rate/age-unchanged |
| 6 | Re-baseline `AGENT_MAX_DEPTH` 2 → 3 | `src/config.ts` | nesting hand case: depth 3 allowed, depth 4 rejected | depth-server-derived |
| 7 | Update `spec-session-orchestration.md`: depth is a server-derived per-dispatch hop-count (push on call, pop on wake, preserved on continuation); note `AGENT_MAX_DEPTH=3`; retire the M2 "stable-correlationId depth" note | `docs/spec-session-orchestration.md` | grep: no "collapseChain depth"/"depth-safe (live correlationId)" contradiction | - |

## Rationale (optional)

The earlier attempt reconstructed depth from correlation history and needed a
caller-keyed `depthMap` with last-write semantics, which dragged in interleaving,
re-entry, re-parent, concurrent-write, and biconditional-contract edge cases — all
artifacts of shared mutable depth state. Modeling depth as a per-dispatch hop-count
**derived by the server from the caller's live dispatch depth** (the standard
distributed-tracing move, minus the trust problem of a caller-carried field) makes
those cases disappear: the depth of a call is fixed at the call from the caller's
current depth, a fire-and-forget return is implicit (the caller's depth is unchanged
for its next call), and the herd wake — already `source:'system'` with no
`fromSession` — is the pop for free. The one genuine non-root system dispatch,
auto-continue, preserves its depth explicitly. `spec-session-orchestration.md:52`
had predicted the breadth-as-depth conflation; the server-derived hop-count is the
minimal correct resolution.
