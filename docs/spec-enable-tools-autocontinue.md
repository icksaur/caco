# spec-enable-tools-autocontinue

`caco_enable_tools` reveals a deferred tool by shrinking the session's live
`excludedTools`, but the revealed tool is **not usable later in the same
response**: an autonomous agent that enables a tool and then tries to use it in
the same run fails, gives up, or falls back to a worse approach. This spec adds
an **auto-continuation** mode: after a dispatch that revealed tools goes idle,
Caco automatically sends one follow-up prompt to the same session — a distinct
purple `system` message in the chat stream — so a fresh dispatch runs with the
newly-enabled tools present and the agent continues its task.

Supersedes the disproven `spec-enable-tools-persistence` (resume-reseed /
used-here theories); see Design → Root cause for why those were wrong.

## Goals

- After a reveal, the agent can **use the enabled tool without the user sending
  another message** — Caco continues the task itself in a new dispatch.
- **All models** (no dependency on the SDK's native tool-search / `deferLoading`,
  which is Claude≥4 / GPT≥5.4 only — that path is out of scope here; see
  spec-tool-search-pivot).
- The follow-up renders as a **distinct purple `system` message** in the chat so
  the operator sees the machine-injected re-prompt (not a silent turn).
- **Bounded and loop-safe**: at most one continuation per reveal batch, a hard
  cap on consecutive continuations, and never firing over a live user message.

## Design

### Root cause (established by spike, replaces the old theories)

The SDK builds the tool array **once per dispatch**: `runAgenticLoop` calls
`prepareToolsForModelRequest` at the top, producing `toolsForExecution`, and the
entire multi-turn tool-calling loop runs *inside* `getCompletionWithTools` with
that frozen array. `caco_enable_tools` → `session.rpc.options.update({
excludedTools })` mutates `this.excludedTools` live and the SDK honours it — but
only for the **next** dispatch's tool-prep, never for the in-flight loop. Proven
empirically (spike branch, `[REVEAL-SPIKE]`): within one request a just-enabled
tool stayed absent across three turns; on a **new request** it was present and
callable. The only mid-dispatch load path is backend `deferLoading` + tool-search
(`copilot_defer_loading`, `tool_search` tool), gated by the `TOOL_SEARCH` feature
flag AND model family — deliberately out of scope. Since the tool array rebuilds
at **dispatch start**, the all-model fix is to **start a fresh dispatch** after a
reveal. The earlier resume-reseed (T1/T4) and used-here-protection theories were
red herrings: the failure is the per-dispatch frozen array, independent of
resume or protection.

### Mechanism (reuses existing herd / system-dispatch machinery)

- **Reveal record (SessionManager owns it) — two separate pieces of state.** To
  keep the cap coherent, the pending **tools** and the consecutive-continuation
  **counter** are stored separately (clearing one must never reset the other):
  - `pendingTools: Map<sessionId, Set<string>>` — the tools to make available in
    the continuation. `SessionManager.enableTools` already returns `{ ok:true,
    enabled: ToolKey[] }`; on `enabled.length > 0`, **union** the enabled names
    into this session's set (multiple reveals in one dispatch accumulate — see
    trailing-edge below). A failed / no-op / all-already-enabled enable adds
    nothing.
  - `autoContinueAttempts: Map<sessionId, number>` — consecutive auto-continuation
    count, **independent of `pendingTools`**. Firing a continuation clears
    `pendingTools` for that session but **increments** `autoContinueAttempts`; the
    counter is reset only by a non-autocontinue dispatch start (below). This is
    the single coherent state model: tools and the loop bound never share a record.
- **Idle trigger (existing hook).** `session.idle` is already handled at
  `src/routes/session-messages.ts:463`, which calls `onSessionIdle(sessionId)`
  (`src/herd-runtime.ts:85`). Add a sibling call `maybeAutoContinue(sessionId)`
  right after the herd hook. It reads the pending record and decides via the pure
  core below.
- **Pure decision core.** `decideAutoContinue({ hasPending, busy, attempts, cap })
  → 'fire' | 'skip' | 'cap-reached'` in a new `src/auto-continue.ts` (no I/O, no
  SDK): `fire` iff `hasPending` (pendingTools non-empty) AND `!busy` AND `attempts
  < cap`; `cap-reached` iff `hasPending` AND `attempts >= cap`; else `skip`.
  Unit-testable in isolation.
- **Re-assert + dispatch (impure glue).** On `fire`, in
  `src/auto-continue-runtime.ts`: (1) read the session's `pendingTools`;
  (2) **idempotently re-apply** `sessionManager.enableTools(sessionId,
  [...pendingTools])` so the reveal is guaranteed live in the continuation
  dispatch even if a resume reseeded `excludedTools` between dispatches (a no-op
  when still live); (3) **clear `pendingTools`** and **increment
  `autoContinueAttempts`** (separate state — the counter is retained across the
  clear); (4) call `dispatchMessage(sessionId, prefixMessageSource('system',
  'autocontinue', text), { needsObservation:false, requestId })`. The text names
  the tools: *"Enabled tools are now available for this request: X, Y. Continue
  the task you were working on."*
- **Trailing-edge single-flight.** Reuse the herd `wakeChains` trailing-edge
  pattern (a per-session promise chain, `src/herd.ts` `wakeParentIfNeeded`): many
  reveals within one dispatch **union** into `pendingTools` and coalesce into
  **one** continuation that re-asserts the whole accumulated set (so no earlier
  reveal in the batch is lost); an idle that arrives mid-evaluation re-evaluates
  once at the tail.
- **Loop cap + reset.** `cap = 3` consecutive continuations. `autoContinueAttempts`
  resets to `0` (and `pendingTools` is cleared) whenever a **non-autocontinue**
  dispatch starts for the session (any `source !== 'system:autocontinue'` — i.e. a
  real user/agent/applet/scheduler message), so a topic change never triggers a
  leftover re-prompt and human activity always re-arms the budget. On
  `cap-reached`, emit one `system` message — *"Auto-continue limit reached; enable
  the remaining tools and send a message to continue."* — and stop (leaving
  `pendingTools` for the operator's next message to consume or clear).
- **Tool wording.** `caco_enable_tools`' success text changes from "callable on
  your NEXT turn (not this one)" to: *"Enabled X. Not callable in this response —
  Caco will automatically continue in a new request where they are available.
  Finish your turn."* (accurate: it is the next **request**, auto-sent).
- **Purple rendering (requires end-to-end identifier plumbing, not just CSS).**
  The continuation uses `source:'system'` with identifier `autocontinue`
  (`[system:autocontinue] …`). Today the enrichment path (`parseMessageSource` →
  broadcast/history enrich) carries the `source` into client event data but **not
  the parsed `identifier`**, and the DOM mapping styles every `caco.system`
  uniformly — so scoped purple is not achievable by CSS alone. The plumbing must:
  (1) **server**: include the parsed `identifier` on the enriched `user.message`
  event data (extend `enrichUserMessageWithSource` to emit `sourceIdentifier`);
  (2) **client**: thread `sourceIdentifier` into the rendered message element's
  dataset so the DOM/region layer can add a modifier class
  (`.system-message.autocontinue`) when `identifier === 'autocontinue'`;
  (3) **CSS**: style `.system-message.autocontinue` purple via
  `--color-agent-bg` / `--purple`. Generic `[system:*]` (herd, etc.) stays gray.
  All three layers are explicit Plan steps (7a server, 7b client, 7c CSS).

## Invariants

- **Reveal-gated**: auto-continuation fires ONLY when a reveal actually succeeded
  this dispatch (`enabled.length > 0`); never on a failed/no-op/`already-enabled`
  enable.
- **At most one per reveal batch**: trailing-edge coalescing guarantees a single
  continuation even for many reveals in one dispatch.
- **Bounded**: ≤ `cap` (3) consecutive auto-continuations; the counter
  (`autoContinueAttempts`, stored separately from `pendingTools`) is reset only by
  a human/agent/applet/scheduler-sourced dispatch — clearing tools on a fire never
  resets it.
- **User wins**: never fires while the session is busy; a new user-sourced
  dispatch resets attempts and clears pending tools.
- **Guaranteed usable**: the continuation dispatch re-asserts the reveal, so the
  tool is present in `getCurrentToolMetadata` at continuation start regardless of
  any resume between dispatches.
- **Unobserved-safe**: the continuation is dispatched with
  `needsObservation:false`, so the machine re-prompt never marks the session
  unobserved (no stray status dot).
- **Purple is scoped**: only `[system:autocontinue]` renders purple; `[system:*]`
  (herd, etc.) stays gray.

## Considerations

- **Cost**: +1 model request per reveal batch. Reveals are rare and batched (the
  tool already nudges "enable the whole family in one call"), so this is
  negligible and bounded by the cap.
- **In-memory only**: the pending record is process-lifetime. If Caco restarts
  between the reveal and idle, the pending continuation is lost — acceptable (the
  operator simply sends a message); no durable store is warranted.
- **Herd orthogonality**: a child/parent idle already runs the herd hook;
  `maybeAutoContinue` runs after it and is independent — an orchestrated child can
  also auto-continue its own reveals without disturbing herd wake logic.
- **Steering vs dispatch**: steering uses `sendStream` (accumulates into the
  ongoing request), while auto-continuation uses `dispatchMessage` (a fresh
  request) — correct, because we specifically need a new dispatch to rebuild the
  tool array.
- **Opt-out**: a preference flag (`autoContinueEnabled`, default on) disables the
  behavior for operators who prefer to re-prompt manually.

## Risks and Mitigations

- **Runaway enable→continue loop** → hard `cap` (3) + reset on human dispatch +
  trailing-edge single-flight; `cap-reached` emits a terminal system message and
  stops.
- **Stale continuation after the user changed topic** → clear the pending record
  when any new user-sourced dispatch starts, plus the busy guard.
- **Reveal dropped by a resume between the two dispatches** → the continuation
  re-asserts `enableTools` (idempotent) before sending; a seam test asserts the
  tool is present at continuation start.
- **Purple leaking to all system messages** → the modifier class is keyed on the
  `autocontinue` identifier only; herd/system stay gray (visual + a mapping unit
  check).
- **Double-fire from concurrent idles** → the per-session trailing-edge chain
  serializes evaluation; `decideAutoContinue` is pure and reads the record once
  inside the chain.
- **Continuation collides with a real user message racing in** → `dispatchMessage`
  already throws `409 SESSION_BUSY`; `maybeAutoContinue` checks `isBusy` first and
  skips, leaving the (now-superseded) pending record to be cleared by the user
  dispatch.

## Acceptance

- Observable: with a deferred tool, the agent calls `caco_enable_tools` and ends
  its turn; **without any user message**, a purple `[system:autocontinue]` message
  appears in the chat and the agent uses the tool in the following dispatch.
- The continuation carries the enabled tools: `getCurrentToolMetadata` at
  continuation start includes them.
- No continuation fires on a failed/no-op/already-enabled enable.
- ≤ 3 consecutive continuations; a user message resets the count; `cap-reached`
  shows the terminal system message.
- A user message arriving before the continuation suppresses it (busy guard +
  pending cleared).
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client, check:specs.
- Oracles:
  - `decideAutoContinue` unit table: pending+!busy+under-cap ⇒ `fire`;
    pending+at-cap ⇒ `cap-reached`; no-pending ⇒ `skip`; busy ⇒ `skip`.
  - Reveal-record unit: `enableTools` success (`enabled>0`) **unions** names into
    `pendingTools`; failure / no-op / all-already-enabled adds nothing; clearing
    `pendingTools` leaves `autoContinueAttempts` unchanged.
  - Trailing-edge coalescing: two reveals in one dispatch ⇒ exactly one
    continuation dispatch that re-asserts the **union** of both reveals.
  - Reset: a user-sourced dispatch resets `autoContinueAttempts` to 0 and clears
    `pendingTools`.
  - Seam test: enable → `session.idle` → assert a continuation `dispatchMessage`
    fired with `[system:autocontinue]`, `needsObservation:false`, and the tool
    present in the session's tool set at continuation start.
  - Identifier plumbing: `[system:autocontinue]` enriches to
    `source:'system', sourceIdentifier:'autocontinue'`; the DOM mapping adds the
    `.autocontinue` modifier for it and not for `[system:herd]`.
  - Wording: a unit test asserts `caco_enable_tools`' result string contains the
    "automatically continue in a new request" phrasing and does NOT contain "next
    turn".
  - Visual: `[system:autocontinue]` renders purple; `[system:herd]` stays gray.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| 1 | **Reveal state (two separate maps)**: `pendingTools: Map<sessionId,Set<string>>` (unioned on `enableTools` success, `enabled>0`) and `autoContinueAttempts: Map<sessionId,number>` on SessionManager; expose `addPendingTools`/`getPendingTools`/`clearPendingTools` and `getAttempts`/`bumpAttempts`/`resetAutoContinue` (clears tools + zeroes attempts) | `src/session-manager.ts` | unit: success unions tools; no-op/failed adds nothing; clearing tools leaves attempts intact |
| 2 | **Pure decision core** `decideAutoContinue({hasPending,busy,attempts,cap})` → `'fire'|'skip'|'cap-reached'` | new `src/auto-continue.ts` | unit table (fire/skip/cap) |
| 3 | **Idle wiring + single-flight**: `maybeAutoContinue(sessionId)` called after the herd hook in the `session.idle` handler; per-session trailing-edge chain (reuse `herd.ts` `wakeChains` pattern) | `src/routes/session-messages.ts`, new `src/auto-continue-runtime.ts`, `src/herd.ts` (pattern only) | coalescing (2 reveals ⇒ 1 continuation, union re-asserted) + busy-guard unit test |
| 4 | **Continuation dispatch**: on `fire` → re-assert `enableTools([...pendingTools])` (idempotent) → `clearPendingTools` + `bumpAttempts` → `dispatchMessage(id, prefixMessageSource('system','autocontinue',text), {needsObservation:false, requestId})` | `src/auto-continue-runtime.ts`, `src/message-source.ts` (identifier), `src/session-manager.ts` | seam test: continuation fired; accumulated tools present at start; attempts incremented not reset |
| 5 | **Cap + reset**: `resetAutoContinue` on any non-autocontinue dispatch start; on `cap-reached` emit one terminal `system` message | `src/routes/session-messages.ts`, `src/auto-continue-runtime.ts` | reset unit test (attempts→0, tools cleared); cap-message test |
| 6 | **Tool wording**: `caco_enable_tools` result text → "…Caco will automatically continue in a new request…" | `src/tool-reveal-tool.ts`, `tests/unit/tool-reveal-tool.test.ts` | unit: result string contains the new phrasing and NOT "next turn" |
| 7a | **Server identifier plumbing**: emit parsed `sourceIdentifier` on the enriched `user.message` event data | `src/message-source.ts`, the broadcast/history enrich path (`enrichUserMessageWithSource`) | unit: `[system:autocontinue]` enriches to `source:'system', sourceIdentifier:'autocontinue'` |
| 7b | **Client identifier → class**: thread `sourceIdentifier` into the message element dataset; add `.autocontinue` modifier on `caco.system` when identifier matches | `public/ts/dom-regions.ts`, `public/ts/session-panel.ts` | mapping unit: autocontinue ⇒ modifier class; herd ⇒ none |
| 7c | **CSS**: `.system-message.autocontinue` purple via `--color-agent-bg`/`--purple` | `public/style.css` | visual: autocontinue purple, herd gray |
| 8 | **Opt-out pref** `autoContinueEnabled` (default true); `maybeAutoContinue` short-circuits when off | `src/preferences.ts`, `src/types.ts` (UserPreferences type), preference update route/handler, `src/auto-continue-runtime.ts` | unit: off ⇒ no fire; pref round-trips through the typed surface |

## Rationale

The frozen-per-dispatch tool array makes true same-dispatch re-enable impossible
without the SDK's model-gated tool-search. Auto-continuation delivers the same
agent-visible outcome (enable → use) on **every** model by exploiting the one
seam the SDK gives us for free: a new dispatch rebuilds the tool array. It reuses
the herd idle hook, the exported `dispatchMessage`, the `system` message source,
and the trailing-edge single-flight pattern — so the net-new surface is a small
pure decision core, a thin runtime, and a purple style variant. The cap + reset +
busy guard make runaway loops structurally impossible; the re-assert makes the
continuation robust to any resume in between.
