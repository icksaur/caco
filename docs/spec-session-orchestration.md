# spec-session-orchestration

Document of record for **session orchestration (herds)**: a *parent* session that starts, messages, and supervises other ordinary Caco sessions (its *children*), never blocks on them, and is re-woken with the herd's state whenever a child needs attention. The structure is durable — it survives server restart, laptop sleep, and crash while Caco runs.

## Goals

A user talks to one parent session. The parent starts and/or acquires other top-level sessions as its children and gives them work **without blocking** — it finishes its turn and goes idle. **Children are ordinary sessions: they are not told they are children, need no special prompt or behavior, and simply receive a prompt, act, and respond as usual.** All herd awareness lives on the parent side. Whenever a child stops working (goes idle) the parent is re-woken with the full herd state so it can read each child's result and decide what's next — give a child more work, or disown it. The parent may only rest once every child is either still working or disowned. All children stay visible as **top-level** sessions. After any restart/sleep/crash the parent is re-woken to reassess its herd from durable state.

## Design

**Definitions.**
- **Parent** — a session that has ≥1 child. The role is **derived, not stored**: a session is a parent iff some other session claims it (see `orchestratedBy`). No parent-side flag or child list is persisted.
- **Child** — any ordinary session that a parent claims via the durable `orchestratedBy` field (= its parent's session id). Being a child is a **bond on the child's own metadata**; the child's kind, prompt, and behavior are unchanged and it does not know it is in a herd.
- **Herd** — the group formed by a parent and its children (transitively: a child may itself be a parent of its own children, so a herd is a tree). Herd operations are parent-relative — "the herd" from a tool's view means the caller's own children.

**Children are unaware by construction.** Nothing injects herd instructions, a system prompt, or special tools into a child. A child receives its prompt through the normal agent-message path (`source: 'agent'`, a `[agent:…]` prefix — the same a `task`/`create_caco_session` child already gets) and responds normally. Every herd mechanism — the wake, the state tool, the drain loop — runs on the **parent** and in Caco's server, never in the child. This keeps children reusable as plain sessions and means acquiring an existing session into a herd changes nothing about how that session behaves.

**Durable state (the only persisted field).**
- Child: `orchestratedBy?: string` — its parent's session id (the herd bond; distinct from the overloaded `parentSessionId` used by fork/agent lineage). This single field, stored in the child's own `meta.json`, is the entire durable representation of the herd. Everything else (a child's status, its last result, when it went idle) is derived from state Caco already persists: live busy/idle state, `meta.lastIdleAt`, and the child's event history.

There is deliberately **no `readyAt`/`drainedAt` flag and no parent-side child index**. "This child needs the parent's attention" is *derived*: a child needs attention iff it is in the herd **and not currently active (busy)**. Because the bond has exactly one writer (the child's own meta), there is no reverse-index read-modify-write race to manage.

**The non-blocking contract.** After giving children work the parent does **not** wait — it completes its turn and goes idle. This is the difference from `caco_session_delegate` (which blocks the caller until the target replies) and is why a herd scales to many children and survives restarts: the parent holds no in-memory wait; all progress is driven by idle transitions and the boot scan.

**Reading child results — `caco_herd_state`.** The parent's go-to tool. It returns, for **every** child of the caller: `sessionId`, `name`, `status` (busy/idle/inactive), `lastIdleAt`, and the child's **last assistant message** (byte-bounded via `boundDelegateResponse`). This closes a real API gap: today `get_session_state` / `GET /sessions/:id/state` returns status/cwd/model/kind/intent but **not** the last response, and the only code that reads a session's last response is `getLastAssistantMessage`, private to `delegate-tool.ts`. That helper is extracted into a shared module so `caco_herd_state` returns each child's result in one call — the parent never needs to know history APIs, exactly as the `task` tool returns a subagent's result automatically.

**Herd control — `caco_herd`.** One tool, an `action` enum:
- `create` — start a **new** session (cwd, model, prompt), stamp `orchestratedBy = self`, dispatch the prompt non-blocking. This is how a fresh child is born.
- `acquire` — adopt an **existing** unowned session (`sessionId`) into the herd (set `orchestratedBy = self`), optionally dispatching a prompt. Rejected if the target is already a child of a different parent, is the caller itself, or would form a cycle.
- `resume` — give an **existing** child (already in the herd) more work: dispatch a prompt, making it active again. ("Resume the child's work" — the herd verb, not the internal session-resume.)
- `disown` — remove a child from the herd (clear `orchestratedBy`). The child reverts to a normal top-level session, `caco_session_delegate` works on it again, and it no longer keeps the parent awake. This is how the parent marks a child "done."

All dispatches (`create`/`acquire`/`resume`) go through the existing agent-message path (`source`, `fromSession`, `correlationId`), so the **runaway guard** (`checkAgentCall`/`recordAgentCall`, depth/rate/age limits in `session-manager.ts`) applies unchanged — a herd never bypasses it, and nested herds are bounded by it.

**Wake machinery — one funnel, three sources.** All call `wakeParentIfNeeded(parentId)`, which re-prompts an **idle** parent with a system message **plus** the current `caco_herd_state` summary iff **not all of its children are active** (≥1 child is idle/inactive):
1. **A child goes idle** (`session.idle` in `completeDispatch`, `src/routes/session-messages.ts`, run **outside** the `needsObservation` gate so agent/system-sourced child turns still trigger). Resolve the child's `orchestratedBy`:
   - Parent **missing/deleted/corrupt** (typed `ok|missing|corrupt` read is not-ok) → **self-heal**: clear this child's `orchestratedBy` (it reverts to a normal session); no wake.
   - Parent **present** → `wakeParentIfNeeded(parent)`.
2. **The parent goes idle** → `wakeParentIfNeeded(self)`. This is the enforcement: a parent that goes idle while any child is not active is immediately re-woken with the herd state. It converges only when the parent has made every child active (via `resume`) or disowned it.
3. **Server boot** — a **post-listen** phase. `startScheduleManager()` and friends run *before* `server.listen()` (`server.ts:311` vs `:340`), so the herd boot scan must run **inside the `server.listen(...)` callback** (or dispatch **in-process** via `dispatchMessage`, not an HTTP POST) — a pre-listen scan whose wake POSTs to `/api/sessions/:id/messages` would fail because the server is not yet accepting connections. Scan for parents with ≥1 non-active child and wake each; self-heal any child whose parent is gone. This is the restart/sleep/crash recovery.

`wakeParentIfNeeded(parentId)`:
- Gather the parent's children; if all are active (busy), return — the parent legitimately rests while its herd works.
- Parent **busy** → return (don't inject; the parent-idle trigger re-fires when it frees — nothing lost, membership is durable and status is live).
- Else inject one `[system]` wake carrying a compact herd-state summary: `[system] Your herd has N child session(s) awaiting attention. Their state: … Call caco_herd_state for full results, then resume or disown each.` At most one wake is ever in flight (the injected dispatch marks the parent busy; a racing second wake sees busy or its POST 409s).

**Reliable child idle-stamping.** `caco_herd_state` reports each child's `lastIdleAt` and derives "not active" partly from it — but today `lastIdleAt` is written only by `unobservedTracker.markIdle`, which is **gated by `needsObservation`** and therefore **skipped for `source:'agent'` child turns** (`src/routes/session-messages.ts:452`, `unobserved-tracker.ts:55`). So the child-idle herd hook (Step 5) must stamp `lastIdleAt` **unconditionally** on every `session.idle` (independent of `needsObservation`), or a child that ran as an agent would report a stale/missing idle time. This stamping is separate from `markIdle`'s user-observation bookkeeping (which stays gated) — it is the herd's own durable "last stopped working" signal.

**Herd info on parent wake.** The current herd-state summary is delivered by exactly one path: the `[system]` **wake message** that `wakeParentIfNeeded` injects. That single, well-defined dispatch is how the parent re-enters with herd context ("herd info is sent when resuming a parent" — Caco *resumes* the parent by dispatching the wake, which carries the summary). There is deliberately **no** separate "inject on any activation" hook — that would risk duplicate/late injections. A parent the *user* opens is not force-injected; it calls `caco_herd_state` on demand, and if any child is pending it is woken on its next idle regardless. The full detail is always one `caco_herd_state` call away.

**System message source.** Adds `'system'` to the `MessageSource` union (`src/message-source.ts:13`, today `user|applet|agent|scheduler|skill`). The wake path composes its payload with `prefixMessageSource('system', 'herd', body)` and posts with `source:'system'`; the message route gains a `system` branch alongside the existing `applet`/`agent`/`scheduler` prefixing (`src/routes/session-messages.ts:182-189`). Rendered distinctly (like `[scheduler:…]`) and, like scheduler/agent sources, it does **not** mark the parent "unobserved" for the user (`needsObservation` stays false for non-user sources).

**User-observation and herd-attention are orthogonal.** "Unobserved by the user" (`unobservedTracker`/`lastObservedAt` → the UI dot, cleared when the *user* opens the session) and "needs the parent's attention" (a child being idle-in-herd → cleared when the parent resumes or disowns it) are independent systems. A child completes via a non-user source (`needsObservation=false`), so its completion never sets the user dot; and herd handling never touches the user dot. A session can be user-unobserved, herd-pending, both, or neither, independently.

## Invariants

- **Children are unaware** (invariant): no herd prompt, tool, or behavior is injected into a child; herd logic lives only on the parent and in the server. Acquiring/disowning a session must not change how that session itself behaves.
- **Role derived, never stored** (invariant): a parent has no persisted flag or child list; the role and child set are computed by scanning `orchestratedBy === self`. The bond has exactly one writer (the child), so it cannot desync.
- **Durable-by-disk** (invariant): the only persisted herd state is each child's `orchestratedBy`; everything else is derived from state Caco already persists (live status, `lastIdleAt`, history). A restart/sleep/crash must leave the parent re-woken to reassess every non-active child.
- **Non-blocking parent** (invariant): the parent never synchronously waits on a child; progress is driven only by idle transitions + the boot scan.
- **Rest only when settled** (invariant): a parent that goes idle while any child is idle/inactive is re-woken; it converges only by making every child active or disowned. The correlation runaway guard bounds a non-converging parent.
- **Children are not delegatable** (invariant): while `orchestratedBy` is set, `caco_session_delegate` targeting that child fails — its lifecycle is owned by the herd, and a blocking third-party delegate would fight it.
- **No wake to a busy parent** (invariant): a wake is injected only into an idle parent; a busy one is retried on its next idle, never queued in memory; at most one wake in flight per parent.
- **Orphans self-heal** (invariant): a child whose `orchestratedBy` resolves to a missing/corrupt session clears its own bond on its next idle and on the boot scan — no child is stuck pointing at a dead parent.
- **Runaway guard preserved** (invariant): parent↔child messaging goes through `checkAgentCall`; the herd adds no bypass.

## Considerations

- **The result API gap is the crux for usability**: `caco_herd_state` bundling each child's last assistant message (via the extracted `getLastAssistantMessage` + `boundDelegateResponse`) is what makes "the parent gets each child's result easily" true — without it the parent has only `get_session_state` (status, no content) and no ergonomic way to read a child's answer.
- **"Needs attention" is derived from live status, not a flag**: this means it is always correct after a restart (no child is active post-restart → the parent is woken to reassess) with no stored flag to reconcile. The tradeoff: an idle child the parent has *not yet* disowned keeps re-prompting — that is the intended "drain-all-or-be-re-prompted" behavior, and the parent converges by disowning.
- **Convergence & loops**: the wake message instructs the parent to resume-or-disown each pending child; a well-behaved parent empties the pending set in one turn. A parent that ignores it loops until the runaway guard trips — acceptable and bounded, matching the requested "immediately re-prompt" semantics.
- **Busy parent during a child completion**: no message is enqueued; the child's idleness is durable-enough (it stays idle), so the parent's own next idle re-derives it and wakes. The durable membership + live status *is* the queue.
- **Crash mid-handling**: nothing to un-wind — there is no readyAt flag to clear. On boot, non-active children re-trigger the wake; `caco_herd_state` re-reads durable results (reading a last message twice is harmless).
- **Acquire semantics**: acquiring sets only the bond; the acquired session keeps its identity, history, and behavior. A session already in another herd is rejected (one parent per child). Self/cycle targets are rejected.
- **Frontend**: children stay top-level (unlike hidden swarm sessions, `session-panel.ts` `kind !== 'swarm'`). A derived herd badge (a session some child claims; a session with `orchestratedBy`) is desirable but the requirement is only that all sessions remain visible and independently openable.

## Risks and Mitigations

- **Re-prompt loop burns tokens**: a parent that neither resumes nor disowns a pending child re-wakes each idle; mitigated by the explicit wake instruction to converge and hard-bounded by the correlation runaway guard.
- **Wake storm** (many children idle at once): each child idle calls the funnel, but the first wake marks the parent busy so the rest coalesce into the next parent-idle; `caco_herd_state` reads *all* children, so one wake surfaces every result — bounded to one in-flight wake per parent.
- **Lost wake across restart**: recovered by the post-listen boot scan; the source of truth is disk (the bond) + live status.
- **Orphaned children** (parent deleted/crashed): two layers — proactively clear children's `orchestratedBy` on parent delete, and each child self-heals on its next idle / the boot scan if its parent is gone.
- **Result too large**: each child's last message is byte-bounded (`boundDelegateResponse`) so a multi-child `caco_herd_state` stays under the output-shaper threshold, as `caco_session_delegate` already does.
- **Corrupt child meta**: typed `ok|missing|corrupt` reads skip a corrupt child in the scan (never crash the wake), matching the scheduler/unobserved posture.

## Acceptance

- Observable: a parent uses `caco_herd` to start/acquire ≥2 children and give them work, then goes idle; while all children are busy the parent rests; as each child finishes, the parent is re-woken with a `[system]` message + herd summary and `caco_herd_state` returns every child's status and last response; the parent `disown`s finished children and `resume`s others; once every child is active-or-disowned the parent rests; restarting the server mid-herd re-wakes the parent to reassess. Children behave as ordinary sessions throughout (no herd-specific prompt or tools).
- Budgets: at most one in-flight wake per parent; `caco_herd_state` results byte-bounded under the output-shaper threshold.
- Gates: typecheck ×2, lint:strict, knip, full tests (`npm test`, coverage thresholds), build:client.
- Oracles:
  - `wakeParentIfNeeded` — hand cases: all children active → no wake; ≥1 non-active + parent idle → one wake with correct N + summary; parent busy → no wake; child idle + parent idle → wake; child idle + parent busy → no wake (deferred).
  - child-idle branching — parent present → wake; parent missing/corrupt → self-heal (bond cleared), no wake.
  - `caco_herd_state` — returns all children with status + `lastIdleAt` + last response; last response byte-bounded; empty herd → empty list.
  - `caco_herd` actions — `create` stamps bond + dispatches; `acquire` sets bond (+ optional dispatch), rejects already-owned/self/cycle; `resume` dispatches to a member; `disown` clears bond (→ delegatable again).
  - delegate guard — `caco_session_delegate` targeting a child (`orchestratedBy` set) → child-error; disowned child → delegatable.
  - unaware-child — a child receives a normal `[agent:…]` prompt with no herd system message/tools; acquiring a session injects nothing into it.
  - boot scan — parent with a non-active child on disk → woken **inside the listen callback** (post-listen; a pre-listen wake would 404); child with a missing parent → bond cleared; busy parent → deferred, not double-woken.
  - idle-stamping — a child that ran as `source:'agent'` still gets `lastIdleAt` written on idle (unconditional stamp), so `caco_herd_state` reports a fresh idle time.

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add child bond field `orchestratedBy` to `SessionMeta` (no parent-side field/kind) | `src/session-meta-store.ts` | type/round-trip persist | role-derived, durable-by-disk |
| 2 | `'system'` message source + a `system` prefix branch in the message route (`prefixMessageSource('system','herd',…)`), non-observing, rendered distinctly | `src/message-source.ts`, `src/routes/session-messages.ts`, `public/ts` render | parse/prefix round-trip; route prefixes `system`; not unobserved | user↔herd orthogonal |
| 3 | Extract/export `getLastAssistantMessage` into a shared helper (used by delegate + herd) | `src/delegate-tool.ts`, `src/session-history.ts` (new/shared) | last-message oracle | - |
| 4 | Pure herd derivation + `wakeParentIfNeeded` (scan children, all-active gate, idle gate, one coalesced wake w/ summary) + inject via message route | `src/herd.ts` (new), `src/routes/session-messages.ts` | `wakeParentIfNeeded` hand cases | non-blocking, no-wake-when-busy, rest-only-when-settled |
| 5 | Child-idle hook: **stamp `lastIdleAt` unconditionally** (independent of `needsObservation`); parent present/missing branching + self-heal; parent-idle trigger; all outside `needsObservation` | `src/routes/session-messages.ts` (`completeDispatch`) | child-idle-branching oracle; agent-source child stamps `lastIdleAt` | orphans self-heal, rest-only-when-settled |
| 6 | `caco_herd_state` tool — all children: status, `lastIdleAt`, byte-bounded last response | `src/herd-tools.ts` (new) | `caco_herd_state` oracle | children-unaware |
| 7 | `caco_herd` tool — `create`/`acquire`/`resume`/`disown`; stamps/clears bond; rejects self/cycle/already-owned; dispatches via agent path (runaway guard) | `src/herd-tools.ts`, `src/routes/sessions.ts` | `caco_herd` action oracles | non-blocking, runaway guard, children-unaware |
| 8 | Delegate guard: add `orchestratedBy` to `delegateTargetError` opts; child target → error | `src/delegate-tool.ts` | delegate-guard oracle | children-not-delegatable |
| 9 | Herd-info-on-wake: `wakeParentIfNeeded` composes the `[system]` wake body with the herd summary (single injection path — no separate on-activation hook) | `src/herd.ts`, `src/routes/session-messages.ts` | test: wake body carries herd summary; no duplicate injection on user resume | - |
| 10 | Boot scan runs **inside the `server.listen` callback** (post-listen), or dispatches in-process; re-wakes parents with non-active children; self-heals orphaned children; orphan cleanup on parent delete | `src/herd.ts`, `server.ts`, delete route | boot-scan oracle (post-listen) | durable-by-disk, orphans self-heal |
| 11 | Frontend: keep children top-level; derived herd/child badge | `public/ts/session-panel.ts`, `session-list-model.ts` | visual signoff | - |

## Rationale

Most primitives already exist: non-blocking parent-linked child creation (`create_caco_session`: `parentSessionId` + fire-and-forget), idle detection (`session.idle`/`unobservedTracker`), message injection into an idle session (the scheduler's `source`-tagged POST), durable per-session metadata with typed corrupt-safe reads, a boot hydrate hook, and a correlation runaway guard. Two things are genuinely missing and this spec supplies them: (1) a **non-blocking, ergonomic result read** — no current tool returns a session's last response (`get_session_state` omits it, `getLastAssistantMessage` is private) — delivered by `caco_herd_state`; and (2) a **durable supervise/re-wake loop** that keeps a parent engaged with idle children, delivered by the `orchestratedBy` bond + `wakeParentIfNeeded`.

Two design choices carry the weight. First, **children are unaware**: all herd logic is parent-side + server-side, so any ordinary session can be a child with zero behavioral change — the herd is a supervision layer, not a protocol the child must speak. Second, **role and readiness are derived, not stored**: a parent is "a session some child claims," and "needs attention" is "a herd child that isn't busy." The only persisted field is the child's one-way `orchestratedBy` bond — a single writer, no reverse index, no readiness flag — which is what makes the whole structure race-free and trivially correct across restart/sleep/crash (re-derive from disk + live status on boot). `caco_session_delegate` (blocking, 1–2 targets, returns a reply) remains for synchronous review/lookup; the herd is the asynchronous, many-child, durable, supervise-and-collect counterpart, and `caco_herd_state` is its automatic result channel — the equivalent of the `task` tool returning a subagent's answer, but for durable top-level sessions.
