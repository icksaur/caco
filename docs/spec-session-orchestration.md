# spec-session-orchestration

Document of record for **session orchestration**: one long-lived *orchestrator* session that starts and messages other Caco sessions (its *children*), never blocks on them, and is woken to *drain* their results as they complete. The whole structure is durable — it survives server restart, laptop sleep, and crash while Caco runs.

## Goals

A user talks to one orchestrator session. The orchestrator spawns and/or enrolls other top-level sessions as children and dispatches work to them **without blocking** — it finishes its turn and goes idle. As each child completes, Caco wakes the orchestrator with a system message telling it to call `caco_drain_children`, which returns the ready children's results. The orchestrator decides when each child is done (send a follow-up, or release it). All children remain visible as **top-level** sessions. No orchestration state lives only in memory: after any restart/sleep/crash the orchestrator is re-woken for every child still awaiting drain.

## Design

**Roles (a relationship, not a new child kind).**
- **Orchestrator** — a session with `kind: 'orchestrator'`. The user-facing session that owns a set of children.
- **Child** — *any* session (interactive, agent, …) whose durable `orchestratedBy` field points at a live orchestrator. "Child" is a **bond**, so an existing session can be enrolled without changing its own kind. A child renders top-level like any session.

The mechanism is a **durable, wake-driven drain loop** layered over the existing async child-creation primitive (`create_caco_session` already sets `parentSessionId` and dispatches non-blocking — see `src/agent-tools.ts`), *not* the blocking `caco_session_delegate` path.

**Durable orchestration state (all in `meta.json`, the source of truth).**
- Orchestrator: `kind: 'orchestrator'`.
- Child: `orchestratedBy?: string` (orchestrator id — the bond; distinct from the overloaded `parentSessionId` used by fork/agent lineage), `orchestrationReadyAt?: string` (set when the child goes idle with undrained work; cleared on drain — the durable "ready" flag), `orchestrationDrainedAt?: string` (bookkeeping).

A child is "ready to drain" iff `orchestratedBy` is set **and** `orchestrationReadyAt` is set. Because this is a per-child flag on disk (not a counter or queue), repeated signals collapse idempotently and nothing is lost across a crash.

**The non-blocking contract.** After dispatching to children the orchestrator does **not** wait. It completes its turn and goes idle. This is the defining difference from `caco_session_delegate` (which blocks the caller until the target replies) and is why orchestration scales to many children and survives restarts: the orchestrator holds no in-memory wait.

**Wake trigger — one funnel, three sources.** All three call `wakeOrchestratorIfReady(orchestratorId)`:
1. **Child goes idle** (`session.idle` in `completeDispatch`, `src/routes/session-messages.ts`): if the session has `orchestratedBy`, set its `orchestrationReadyAt = now`, then wake that orchestrator. This runs on **every** idle, independent of the `needsObservation` gate (`src/routes/session-messages.ts:452-456`) — the wake path must not be nested inside the user-observation branch, or a system/scheduler-sourced child turn (`needsObservation=false`) would never signal readiness.
2. **Orchestrator goes idle**: `wakeOrchestratorIfReady(self)` — also **outside** the `needsObservation` gate (the orchestrator's own turns are system-woken, so `needsObservation=false`; gating the re-wake on observation would stall the drain loop). Enforces "drained some but not all ⇒ re-prompt immediately" and "was busy when a child fired ⇒ wake now".
3. **Server boot**: a **post-listen** wake phase (after Express is listening and the message route is mounted — NOT inside the pre-listen `init`/`hydrate` ordering where a POST to `/api/sessions/:id/messages` would fail). It scans sessions for orchestrators with ≥1 ready child and wakes each. This is the restart/sleep/crash recovery. Runs after `startScheduleManager()` in the same post-listen block; may dispatch in-process rather than via HTTP to avoid any listen-readiness race.

`wakeOrchestratorIfReady(orchId)`:
- Gather children with `orchestratedBy === orchId` and `orchestrationReadyAt` set.
- None ready → return.
- Orchestrator **busy** → return (do not inject; the orchestrator-idle trigger re-fires when it frees — nothing lost, the flags are durable).
- Else → inject a **system wake** into the idle orchestrator: `[system] N child session(s) are ready. Call caco_drain_children to collect their results.`

**System message source.** Adds `'system'` to the `MessageSource` union (`src/message-source.ts:13`, which today is `user|applet|agent|scheduler|skill`), prefix `[system:orchestrator]`, dispatched via the existing message route (the same mechanism the scheduler uses to inject into an idle session). Rendered distinctly (like `[scheduler:…]`), and — like scheduler/agent sources — it does **not** mark the orchestrator "unobserved" for the user (`needsObservation` stays false for non-user sources).

**`caco_drain_children` tool (orchestrator-only).**
- Guard: available only when the caller's `kind === 'orchestrator'`; otherwise a hard error.
- Default: drains **all** ready children. Optional `sessionIds` filter drains a subset.
- Returns, per drained child: `sessionId`, `name`, `status` (idle/busy), and the child's last assistant message. This reuses `boundDelegateResponse` (exported, `src/delegate-tool.ts:31`) for byte-bounding and `getLastAssistantMessage` — which is **currently private to `delegate-tool.ts` and must be extracted/exported** (or lifted into a shared helper) so the drain tool and delegate share one implementation, exactly as `caco_session_delegate` does.
- Side effect: for each drained child set `orchestrationDrainedAt = now` and clear `orchestrationReadyAt`.

**"Drain all or be re-prompted."** Enforcement is emergent, not a special case: after the orchestrator's drain turn it goes idle → trigger (2) re-runs `wakeOrchestratorIfReady(self)` → if any child is still ready (the orchestrator drained a subset, or a new child completed meanwhile) it is immediately re-woken. The loop terminates only when the ready set is empty. The orchestrator "decides when children are done" by choosing, per drained child, to **send a follow-up** (the child runs again and will re-ready) or **release** it.

**Release / completion.** Releasing a child clears `orchestratedBy` (and the orchestration flags); the child reverts to an ordinary top-level session and `caco_session_delegate` works on it again. The orchestrator decides when to release; there is no automatic teardown.

**Orchestrator dispatch primitives.** Starting a child reuses `create_caco_session`'s non-blocking create+dispatch but stamps `orchestratedBy = self`; messaging an existing session enrolls it (`orchestratedBy = self`) and fire-and-forget dispatches. **Enrolling an already-idle session must set `orchestrationReadyAt = now` at enroll time** (or the enroll is paired with a dispatch that will produce a future idle): otherwise a session enrolled while already idle would never fire another `session.idle` and become permanently undrainable. Both flows go through the existing agent-message path (`source`, `fromSession`, `correlationId`) so the **runaway guard** (`checkAgentCall`/`recordAgentCall`, depth/rate/age limits in `session-manager.ts`) applies unchanged — orchestration never bypasses it, and nested orchestrators are bounded by it.

## Invariants

- **Durable-by-disk** (invariant): every piece of orchestration state (bonds, ready flags) is in `meta.json`; in-memory holds nothing the boot scan can't reconstruct. A restart/sleep/crash must leave every ready child drainable and its orchestrator woken.
- **Non-blocking orchestrator** (invariant): the orchestrator never synchronously waits on a child; it dispatches and goes idle. Progress is driven only by idle-transition + boot wakes.
- **Idempotent readiness** (invariant): readiness is a per-child flag, not a queue/counter; duplicate signals, double wakes, and re-runs collapse without double-draining or lost children.
- **Children are not delegatable** (invariant): while `orchestratedBy` is set, `caco_session_delegate` targeting that child fails — its lifecycle is owned by the orchestrator's drain loop, and a blocking third-party delegate would fight it.
- **No wake to a busy orchestrator** (invariant): a wake is injected only into an idle orchestrator; a busy one is retried on its next idle, never queued in memory.
- **Runaway guard preserved** (invariant): orchestrator↔child messaging goes through `checkAgentCall`; orchestration adds no bypass.

## Considerations

- **Enforcement point for "drain all"** is the orchestrator-idle re-wake, not the tool — so partial drains, mid-drain new completions, and an orchestrator that ignores the wake all converge to the same "keep re-prompting until empty" behavior.
- **Busy orchestrator during a child completion**: the child's `orchestrationReadyAt` is set regardless; the wake is simply deferred to the orchestrator's next idle. No message is lost because none is enqueued — the durable flag *is* the queue.
- **Crash mid-drain**: drain clears flags only on success; a crash before the clear leaves the child ready, so boot re-wakes and the orchestrator re-drains (idempotent — reading the last assistant message twice is harmless).
- **Enrolling an already-busy or already-child session**: enrolling sets the bond; if the session is already a child of another orchestrator, reject (a child has exactly one orchestrator).
- **Self/loops**: an orchestrator cannot enroll itself; the runaway guard bounds nested orchestration depth.
- **Frontend**: children stay top-level (unlike hidden swarm sessions, `session-panel.ts` `kind !== 'swarm'`); an orchestration badge/affordance is desirable but the requirement is only that they remain visible and independently openable.

## Risks and Mitigations

- **Wake storm** (many children idle at once): each sets its flag; `wakeOrchestratorIfReady` injects **one** message summarizing N ready children, and a busy orchestrator coalesces the rest into the next idle — bounded to at most one in-flight wake per orchestrator.
- **Lost wake across restart**: mitigated by the boot hydrate scan (source of truth is disk), the whole reason readiness is a durable flag.
- **Orphaned children** (orchestrator deleted): on orchestrator delete, clear `orchestratedBy` on its children (they revert to normal sessions) so they are not stuck undelegatable.
- **Runaway re-prompt loop**: the ready set only shrinks unless the orchestrator sends new work; the correlation runaway guard caps pathological orchestrator↔child churn.
- **Corrupt child meta**: typed `ok|missing|corrupt` disk reads skip a corrupt child in the drain scan (never crash the wake), matching the scheduler/unobserved posture.

## Acceptance

- Observable: with an orchestrator and ≥2 children, dispatching work then idling the orchestrator; as children finish, the orchestrator is woken with a `[system]` message and `caco_drain_children` returns each ready child's last response; draining a subset triggers an immediate re-wake for the rest; restarting the server mid-flight re-wakes the orchestrator for all still-ready children.
- Budgets: at most one in-flight wake per orchestrator; drain result byte-bounded under the output-shaper threshold.
- Gates: typecheck ×2, lint:strict, knip, full tests (`npm test`, coverage thresholds), build:client.
- Oracles:
  - `wakeOrchestratorIfReady` — hand cases: no ready → no wake; ready + idle → one wake with correct N; ready + busy → no wake; multiple ready → single coalesced wake.
  - drain state machine — ref/property: child idle sets `orchestrationReadyAt`; drain clears it and sets `orchestrationDrainedAt`; a subset drain leaves the rest ready (⇒ re-wake); idempotent double-drain.
  - `caco_drain_children` guard — non-orchestrator caller → error; orchestrator → ready children returned, byte-bounded.
  - delegate guard — `caco_session_delegate` targeting a session with `orchestratedBy` set → the child-error message; released child (bond cleared) → delegatable again.
  - boot hydrate — orchestrator with a ready child on disk → woken on start (post-listen); busy orchestrator → deferred, not double-woken.
  - enroll-while-idle — a session enrolled while already idle is set ready at enroll time (or paired with a dispatch) → it is drainable, never permanently stuck.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `kind: 'orchestrator'`; child bond fields (`orchestratedBy`, `orchestrationReadyAt`, `orchestrationDrainedAt`) to `SessionMeta` | `src/session-meta-store.ts` | type/round-trip persist | durable-by-disk |
| 2 | `'system'` message source + `[system:…]` prefix, non-observing, rendered distinctly | `src/message-source.ts`, `public/ts` render | test: parse/prefix round-trip; not unobserved | - |
| 3 | Pure `wakeOrchestratorIfReady` (gather ready children, gate on idle, compose one wake) + inject via message route | `src/orchestration.ts` (new), `src/routes/session-messages.ts` | hand cases (see Oracles) | non-blocking, idempotent, no-wake-when-busy |
| 4 | Child-idle + orchestrator-idle triggers set/clear flags and call the funnel | `src/routes/session-messages.ts` (`completeDispatch`) | test: idle sets readyAt then wakes parent/self | idempotent readiness |
| 5 | `caco_drain_children` tool (orchestrator-only guard, drain all/subset, byte-bounded results, clear flags). Extract/export `getLastAssistantMessage` from `delegate-tool.ts` into a shared helper | `src/drain-tool.ts` (new), `src/delegate-tool.ts` | guard + return + clear oracles | children-not-delegatable |
| 6 | Delegate guard: add `orchestratedBy` to the existing `delegateTargetError` opts (caller already reads `meta`); child target → error | `src/delegate-tool.ts` | delegate-guard oracle | children-not-delegatable |
| 7 | Orchestrator start/enroll primitives stamp `orchestratedBy`; **enrolling an already-idle session sets `orchestrationReadyAt`**; reject double-enroll/self; runaway guard unchanged | `src/agent-tools.ts` | test: enroll sets bond; enroll-while-idle is drainable; double-enroll rejected | runaway guard preserved |
| 8 | **Post-listen** boot wake phase (after Express `listen`, alongside `startScheduleManager`) re-wakes orchestrators with ready children; orphan cleanup on orchestrator delete | `src/orchestration.ts`, `server.ts`, delete route | boot-hydrate oracle | durable-by-disk |
| 9 | Frontend: keep children top-level; orchestration badge/affordance | `public/ts/session-panel.ts`, `session-list-model.ts` | visual signoff | - |

## Rationale

The async child primitive already exists (`create_caco_session`: `parentSessionId` + non-blocking dispatch), as do idle detection (`session.idle`/`unobservedTracker`), programmatic message injection into an idle session (the scheduler's `source`-tagged POST), durable per-session metadata with typed corrupt-safe reads, a boot hydrate hook, and a correlation runaway guard. Orchestration composes these into a durable drain loop rather than inventing new machinery. The key design choice is making **readiness a durable per-child flag re-driven by every idle transition and by boot** — that single decision delivers the crash/sleep/restart durability, the "drain all or be re-prompted" enforcement, and the wake-coalescing, with no in-memory queue to lose. `caco_session_delegate` (blocking, 1–2 targets) remains the tool for synchronous review/lookup; orchestration is the asynchronous, many-child, durable counterpart.

**Role modeling (`kind: 'orchestrator'` vs an `isOrchestrator` flag).** A reviewer noted a boolean flag avoids widening `SessionKind` and its coupling surfaces (frontend filters, guards). We keep `kind: 'orchestrator'` because it mirrors the existing `swarm`/`agent`/`scheduled` categorization the drain-tool guard and session-panel already key off, and a session is *either* orchestrator or child, never both — so a distinct kind is the natural taxonomy. The **child** side is deliberately a relationship flag (`orchestratedBy`), not a kind, so any existing session can be enrolled without losing its own identity.
