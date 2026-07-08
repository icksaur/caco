# spec-session-orchestration

Document of record for **session orchestration**: one long-lived *orchestrator* session that starts and messages other Caco sessions (its *children*), never blocks on them, and is woken to *drain* their results as they complete. The whole structure is durable — it survives server restart, laptop sleep, and crash while Caco runs.

## Goals

A user talks to one orchestrator session. The orchestrator spawns and/or enrolls other top-level sessions as children and dispatches work to them **without blocking** — it finishes its turn and goes idle. As each child completes, Caco wakes the orchestrator with a system message telling it to call `caco_drain_children`, which returns the ready children's results. The orchestrator decides when each child is done (send a follow-up, or release it). All children remain visible as **top-level** sessions. No orchestration state lives only in memory: after any restart/sleep/crash the orchestrator is re-woken for every child still awaiting drain.

## Design

**Roles (the orchestrator role is IMPLICIT — children claim the parent).**
- **Child** — *any* session whose durable `orchestratedBy` field points at another session. "Child" is a **bond**, so an existing session can be enrolled without changing its own kind, and it still renders top-level.
- **Orchestrator** — *any* session that ≥1 child claims via `orchestratedBy`. There is **no `kind: 'orchestrator'` and no `childSessionIds[]` reverse-index**: the orchestrator role is *derived*, not stored. Children are the single source of truth for the relationship; the orchestrator's child set is computed by scanning sessions for `orchestratedBy === self`. This eliminates the reverse-index read-modify-write race entirely (a child's bond lives only in the child's own `meta.json`) and means any session can become an orchestrator with no special creation step — it simply becomes one the moment a child claims it.

The mechanism is a **durable, wake-driven drain loop** layered over the existing async child-creation primitive (`create_caco_session` already sets `parentSessionId` and dispatches non-blocking — see `src/agent-tools.ts`), *not* the blocking `caco_session_delegate` path.

**Parent→child dispatch — a new non-blocking tool (`caco_orchestrate`).** Today the only cross-session send tools are `create_caco_session` (create + optional first message, non-blocking) and `caco_session_delegate` (blocking); the old non-blocking `send_caco_message` was removed, so there is currently **no way to fire a follow-up at an existing session without blocking**. Orchestration adds `caco_orchestrate({ target, prompt })` — the non-blocking counterpart to `caco_drain_children`:
- `target` is either a `cwd` (create a fresh child there) or an existing `sessionId` (enroll it).
- It sets `orchestratedBy = caller` on the target and **fire-and-forget** dispatches `prompt` (never waits). This is how a session *becomes* a child (by being targeted) and how the parent sends both the first message and every follow-up. `create_caco_session` remains for ordinary independent (non-orchestrated) sessions.

**Durable orchestration state (all in `meta.json`, the source of truth).**
- Child: `orchestratedBy?: string` (orchestrator id — the bond; distinct from the overloaded `parentSessionId` used by fork/agent lineage), `orchestrationReadyAt?: string` (set when the child goes idle with undrained work; cleared on drain — the durable "ready"/"unobserved-by-parent" flag), `orchestrationDrainedAt?: string` (bookkeeping).
- Orchestrator: **nothing** — its role and child set are derived by scanning.

`updateSessionMeta` is synchronous (`readFileSync`→mutate→`writeFileSync` in one tick, `src/session-meta-store.ts:132`), so each per-session write is **atomic within the process** — a child setting its own flag can never interleave with another writer of the same file. The only remaining race surface is cross-session eventual consistency, which the drain-reads-all + re-check design absorbs (see §Considerations).

A child is "ready to drain" iff `orchestratedBy` is set **and** `orchestrationReadyAt` is set. Because this is a per-child flag on disk (not a counter or queue), repeated signals collapse idempotently and nothing is lost across a crash.

**The non-blocking contract.** After dispatching to children the orchestrator does **not** wait. It completes its turn and goes idle. This is the defining difference from `caco_session_delegate` (which blocks the caller until the target replies) and is why orchestration scales to many children and survives restarts: the orchestrator holds no in-memory wait.

**User-observation vs parent-drain are separate, independent systems.** "Unobserved by the user" (`unobservedTracker` / `lastObservedAt` → the UI dot, cleared when the *user* opens the session) and "undrained by the parent" (`orchestrationReadyAt` → cleared by *drain*) never conflate. A child completes via a non-user source (agent/system, `needsObservation=false`), so its completion does **not** set the user dot; and draining does not touch the user dot. A child may be user-unobserved, parent-undrained, both, or neither, independently.

**Wake trigger — one funnel, three sources.** All three call `wakeOrchestratorIfReady(orchestratorId)`:
1. **Child goes idle** (`session.idle` in `completeDispatch`, `src/routes/session-messages.ts`), independent of the `needsObservation` gate (`session-messages.ts:452-456`) so a system/agent-sourced child turn still signals. If the session has `orchestratedBy`, resolve the parent and branch on **all three cases**:
   - **Parent missing/deleted/corrupt** (typed `ok|missing|corrupt` read of the orchestrator's meta returns not-ok) → **self-heal**: clear this child's `orchestratedBy`/orchestration flags so it reverts to a normal, delegatable top-level session; no wake. Covers a crash between orchestrator-delete and orphan cleanup.
   - **Parent present** → set the child's `orchestrationReadyAt = now`, then `wakeOrchestratorIfReady(parent)`, which itself handles parent-busy vs parent-idle (below).
2. **Orchestrator goes idle**: `wakeOrchestratorIfReady(self)`, also **outside** the `needsObservation` gate (its own turns are system-woken, `needsObservation=false`). This is the "drained some but not all ⇒ re-prompt immediately" and "was busy when a child fired ⇒ wake now" enforcement.
3. **Server boot** — a **post-listen** wake phase (after Express is listening and the message route is mounted; runs after `startScheduleManager()`, NOT inside pre-listen `init`/`hydrate`). Scan sessions for any that are claimed as a parent by ≥1 ready child and wake each. Restart/sleep/crash recovery. May dispatch in-process to avoid any listen-readiness race.

`wakeOrchestratorIfReady(orchId)`:
- Scan for children with `orchestratedBy === orchId` **and** `orchestrationReadyAt` set (corrupt child metas skipped).
- None ready → return.
- Orchestrator **busy** → return (do not inject; the orchestrator-idle trigger re-fires when it frees — nothing lost, the flags are durable). A concurrent second wake is also naturally dropped: the first wake's dispatch marks the orchestrator busy, so a near-simultaneous second `wakeOrchestratorIfReady` sees busy (or its POST hits the message route's `isBusy` 409) — at most one wake is ever in flight.
- Else → inject a **system wake** into the idle orchestrator: `[system] N child session(s) are ready. Call caco_drain_children to collect their results.`

**System message source.** Adds `'system'` to the `MessageSource` union (`src/message-source.ts:13`, which today is `user|applet|agent|scheduler|skill`), prefix `[system:orchestrator]`, dispatched via the existing message route (the same mechanism the scheduler uses to inject into an idle session). Rendered distinctly (like `[scheduler:…]`), and — like scheduler/agent sources — it does **not** mark the orchestrator "unobserved" for the user (`needsObservation` stays false for non-user sources).

**`caco_drain_children` tool (orchestrator-only, by derivation).**
- Guard: available only when ≥1 session claims the caller via `orchestratedBy` (i.e. the caller is *derived* to be an orchestrator); otherwise a hard error ("you have no orchestrated children"). No `kind` check — the role is implicit.
- Default: drains **all** ready children. Optional `sessionIds` filter drains a subset.
- Returns, per drained child: `sessionId`, `name`, `status` (idle/busy), and the child's last assistant message. This reuses `boundDelegateResponse` (exported, `src/delegate-tool.ts:31`) for byte-bounding and `getLastAssistantMessage` — which is **currently private to `delegate-tool.ts` and must be extracted/exported** (or lifted into a shared helper) so the drain tool and delegate share one implementation, exactly as `caco_session_delegate` does.
- Side effect: for each drained child set `orchestrationDrainedAt = now` and clear `orchestrationReadyAt`.

**"Drain all or be re-prompted."** Enforcement is emergent, not a special case: after the orchestrator's drain turn it goes idle → trigger (2) re-runs `wakeOrchestratorIfReady(self)` → if any child is still ready (the orchestrator drained a subset, or a new child completed meanwhile) it is immediately re-woken. The loop terminates only when the ready set is empty. The orchestrator "decides when children are done" by choosing, per drained child, to **send a follow-up** (the child runs again and will re-ready) or **release** it.

**Release / completion.** Releasing a child clears `orchestratedBy` (and the orchestration flags); the child reverts to an ordinary top-level session and `caco_session_delegate` works on it again. The orchestrator decides when to release; there is no automatic teardown.

**Orchestrator dispatch primitives.** Both "start a new child" and "message an existing session" are the one `caco_orchestrate({ target, prompt })` tool (above): it stamps `orchestratedBy = self` on the target and fire-and-forget dispatches. **Enrolling an already-idle existing session must set `orchestrationReadyAt = now` at enroll time** — the tool always dispatches a `prompt`, so the child will run and produce a future `session.idle`; but if a variant ever enrolls without dispatching, it must set readiness explicitly, or a session enrolled while already idle would never fire another `session.idle` and become permanently undrainable. Dispatch goes through the existing agent-message path (`source`, `fromSession`, `correlationId`) so the **runaway guard** (`checkAgentCall`/`recordAgentCall`, depth/rate/age limits in `session-manager.ts`) applies unchanged — orchestration never bypasses it, and nested orchestrators (an orchestrator that is itself a child) are bounded by it.

## Invariants

- **Durable-by-disk** (invariant): every piece of orchestration state (bonds, ready flags) is in `meta.json`; in-memory holds nothing the boot scan can't reconstruct. A restart/sleep/crash must leave every ready child drainable and its orchestrator woken.
- **Non-blocking orchestrator** (invariant): the orchestrator never synchronously waits on a child; it dispatches and goes idle. Progress is driven only by idle-transition + boot wakes.
- **Idempotent readiness** (invariant): readiness is a per-child flag, not a queue/counter; duplicate signals, double wakes, and re-runs collapse without double-draining or lost children.
- **Children are not delegatable** (invariant): while `orchestratedBy` is set, `caco_session_delegate` targeting that child fails — its lifecycle is owned by the orchestrator's drain loop, and a blocking third-party delegate would fight it.
- **No wake to a busy orchestrator** (invariant): a wake is injected only into an idle orchestrator; a busy one is retried on its next idle, never queued in memory. At most one wake is in flight per orchestrator (the first wake's dispatch makes it busy; the `isBusy` gate drops a racing second).
- **Orchestrator role is derived, never stored** (invariant): a session is an orchestrator iff ≥1 session claims it via `orchestratedBy`; there is no orchestrator-side field or reverse-index to keep consistent, so the relationship has exactly one writer (the child) and cannot desync.
- **User-observation and parent-drain are orthogonal** (invariant): `orchestrationReadyAt` (parent-undrained) and `lastObservedAt`/the user dot (user-unobserved) are independent; neither clears the other, and a child's non-user-sourced completion never sets the user dot.
- **Orphans self-heal** (invariant): a child whose `orchestratedBy` resolves to a missing/corrupt session clears its own bond on next idle (and on boot scan), reverting to a normal delegatable session — no child is ever stuck pointing at a dead parent.
- **Runaway guard preserved** (invariant): orchestrator↔child messaging goes through `checkAgentCall`; orchestration adds no bypass.

## Considerations

- **Enforcement point for "drain all"** is the orchestrator-idle re-wake, not the tool — so partial drains, mid-drain new completions, and an orchestrator that ignores the wake all converge to the same "keep re-prompting until empty" behavior.
- **Busy orchestrator during a child completion**: the child's `orchestrationReadyAt` is set regardless; the wake is simply deferred to the orchestrator's next idle. No message is lost because none is enqueued — the durable flag *is* the queue.
- **Crash mid-drain**: drain clears flags only on success; a crash before the clear leaves the child ready, so boot re-wakes and the orchestrator re-drains (idempotent — reading the last assistant message twice is harmless).
- **Enrolling a session already claimed by another orchestrator**: `caco_orchestrate` targeting a session whose `orchestratedBy` is set to a *different* live orchestrator is rejected (a child has exactly one orchestrator). Re-targeting by the *same* orchestrator is a no-op re-dispatch.
- **Self/loops**: a session cannot orchestrate itself (`target !== self`); the runaway guard bounds nested orchestration depth.
- **Race — two children idle at once**: each writes its own `orchestrationReadyAt` (different files, atomic per file), then both call `wakeOrchestratorIfReady(parent)`. The first injects and marks the parent busy; the second sees busy (or its POST 409s) and drops. Because drain **reads all** ready children, the single surviving wake collects both — double-wake is harmless, a dropped wake is recovered by the parent-idle re-check.
- **Frontend**: children stay top-level (unlike hidden swarm sessions, `session-panel.ts` `kind !== 'swarm'`); an orchestration badge/affordance is desirable but the requirement is only that they remain visible and independently openable. An "is-orchestrator" badge is derived (a session some child claims), not a stored flag.

## Risks and Mitigations

- **Wake storm** (many children idle at once): each sets its flag; `wakeOrchestratorIfReady` injects **one** message summarizing N ready children, and a busy orchestrator coalesces the rest into the next idle — bounded to at most one in-flight wake per orchestrator.
- **Lost wake across restart**: mitigated by the post-listen boot scan (source of truth is disk), the whole reason readiness is a durable flag.
- **Orphaned children** (orchestrator deleted/crashed): two layers — on orchestrator delete, proactively clear `orchestratedBy` on its children; and a child self-heals on its own next idle / the boot scan if it finds its parent missing. Either way a child never stays stuck undelegatable.
- **Runaway re-prompt loop**: the ready set only shrinks unless the orchestrator sends new work; the correlation runaway guard caps pathological orchestrator↔child churn.
- **Corrupt child meta**: typed `ok|missing|corrupt` disk reads skip a corrupt child in the drain scan (never crash the wake), matching the scheduler/unobserved posture.

## Acceptance

- Observable: with an orchestrator and ≥2 children, dispatching work then idling the orchestrator; as children finish, the orchestrator is woken with a `[system]` message and `caco_drain_children` returns each ready child's last response; draining a subset triggers an immediate re-wake for the rest; restarting the server mid-flight re-wakes the orchestrator for all still-ready children.
- Budgets: at most one in-flight wake per orchestrator; drain result byte-bounded under the output-shaper threshold.
- Gates: typecheck ×2, lint:strict, knip, full tests (`npm test`, coverage thresholds), build:client.
- Oracles:
  - `wakeOrchestratorIfReady` — hand cases: no ready → no wake; ready + idle → one wake with correct N; ready + busy → no wake; multiple ready → single coalesced wake.
  - child-idle branching — parent present → sets `orchestrationReadyAt` + wakes; parent missing/corrupt → self-heals (clears bond), no wake; parent busy → flag set, no inject.
  - drain state machine — ref/property: child idle sets `orchestrationReadyAt`; drain clears it and sets `orchestrationDrainedAt`; a subset drain leaves the rest ready (⇒ re-wake); idempotent double-drain.
  - `caco_drain_children` guard — caller with no claiming children → error; caller claimed by ≥1 child → ready children returned, byte-bounded.
  - `caco_orchestrate` — new child stamped `orchestratedBy`; enroll existing sets bond + dispatches non-blocking; target already claimed by a different orchestrator → rejected; self-target → rejected.
  - delegate guard — `caco_session_delegate` targeting a session with `orchestratedBy` set → the child-error message; released child (bond cleared) → delegatable again.
  - user-vs-parent separation — a child completion (agent/system source) does NOT set the user dot; drain does not clear the user dot; the two flags move independently.
  - boot scan — session claimed by a ready child on disk → woken on start (post-listen); busy → deferred, not double-woken; child with a missing parent on disk → bond cleared.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Child bond fields (`orchestratedBy`, `orchestrationReadyAt`, `orchestrationDrainedAt`) on `SessionMeta`. **No orchestrator-side field/kind** — role is derived by scan | `src/session-meta-store.ts` | type/round-trip persist | durable-by-disk, role-derived |
| 2 | `'system'` message source + `[system:…]` prefix, non-observing, rendered distinctly | `src/message-source.ts`, `public/ts` render | test: parse/prefix round-trip; not unobserved | user↔parent orthogonal |
| 3 | Pure `wakeOrchestratorIfReady` (scan claiming children, gate on idle, one coalesced wake) + inject via message route | `src/orchestration.ts` (new), `src/routes/session-messages.ts` | hand cases (see Oracles) | non-blocking, idempotent, no-wake-when-busy |
| 4 | Child-idle (with parent-present/missing/busy branching + self-heal) + orchestrator-idle triggers call the funnel, outside the `needsObservation` gate | `src/routes/session-messages.ts` (`completeDispatch`) | child-idle-branching oracle | idempotent readiness, orphans self-heal |
| 5 | `caco_drain_children` tool (derived-orchestrator guard, drain all/subset, byte-bounded results, clear flags). Extract/export `getLastAssistantMessage` from `delegate-tool.ts` into a shared helper | `src/drain-tool.ts` (new), `src/delegate-tool.ts` | guard + return + clear oracles | children-not-delegatable, role-derived |
| 6 | `caco_orchestrate({target,prompt})` tool — non-blocking create-child-or-enroll-existing, stamps `orchestratedBy`, rejects self/other-claimed; dispatches via the agent-message path (runaway guard) | `src/orchestrate-tool.ts` (new), `src/routes/sessions.ts` | `caco_orchestrate` oracle | non-blocking, runaway guard preserved |
| 7 | Delegate guard: add `orchestratedBy` to the existing `delegateTargetError` opts (caller already reads `meta`); child target → error | `src/delegate-tool.ts` | delegate-guard oracle | children-not-delegatable |
| 8 | **Post-listen** boot wake phase (after Express `listen`, alongside `startScheduleManager`) re-wakes sessions claimed by ready children; self-heals children with missing parents; orphan cleanup on orchestrator delete | `src/orchestration.ts`, `server.ts`, delete route | boot-scan oracle | durable-by-disk, orphans self-heal |
| 9 | Frontend: keep children top-level; derived orchestration/child badge/affordance | `public/ts/session-panel.ts`, `session-list-model.ts` | visual signoff | - |

## Rationale

The async child primitive already exists (`create_caco_session`: `parentSessionId` + non-blocking dispatch), as do idle detection (`session.idle`/`unobservedTracker`), programmatic message injection into an idle session (the scheduler's `source`-tagged POST), durable per-session metadata with typed corrupt-safe reads, a boot hydrate hook, and a correlation runaway guard. The one genuinely missing primitive is a **non-blocking parent→child send** (the old `send_caco_message` was removed; `caco_session_delegate` blocks), supplied by the new `caco_orchestrate` tool. Everything else composes existing machinery into a durable drain loop. The key design choice is making **readiness a durable per-child flag re-driven by every idle transition and by boot** — that single decision delivers the crash/sleep/restart durability, the "drain all or be re-prompted" enforcement, and the wake-coalescing, with no in-memory queue to lose. `caco_session_delegate` (blocking, 1–2 targets) remains the tool for synchronous review/lookup; orchestration is the asynchronous, many-child, durable counterpart.

**Role modeling — derived, not stored (revised per user review).** Earlier drafts gave the orchestrator `kind: 'orchestrator'`. That is dropped: a session **is** an orchestrator iff ≥1 session claims it via `orchestratedBy`, so the role is *derived* by scanning. This is strictly better than either a `kind` or an `isOrchestrator`/`childSessionIds[]` field because the relationship then has exactly **one writer** (the child's own `meta.json`) and no reverse-index to keep consistent — eliminating a whole class of read-modify-write race. The drain guard, the wake funnel, and the frontend badge all derive the role from the same scan. The **child** side is a relationship flag (`orchestratedBy`), not a kind, so any existing session can be enrolled without losing its own identity — including an orchestrator that is itself another orchestrator's child (bounded by the runaway guard).
