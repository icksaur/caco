# Spec: `/session-context-window`

**Status:** draft · **SDK:** `@github/copilot-sdk@1.0.0-beta.7`

## Goals

Let a user cap an **active** session's live context window so the SDK compacts earlier, cutting per-call cache cost (the dominant cost on large-window models). One picker-driven slash command (`/session-context-window`), working identically for GitHub and BYOK models. Non-goals: new-session configuration; changing `bufferExhaustionThreshold`; a custom compaction loop.

## Design

**Mechanism:** `backgroundCompactionThreshold` (a fraction 0–1) is settable only at session create/resume — there is no live setter on the `session` object. Caco stores the budget as an absolute token count (`contextBudgetTokens` in `SessionMeta`), converts to a fraction at apply time, and applies by recreating the session via the existing `setSessionModel` disconnect→resume pattern.

**Token math:** `W = max_prompt_tokens ?? max_context_window_tokens ?? 128_000` (matching the runtime at `@github/copilot/app.js:3644`); `backgroundCompactionThreshold = clamp(T / W, 0.05, 0.94)`. Upper cap 0.94 keeps background strictly below `bufferExhaustionThreshold` (0.95); floor 0.05 prevents disabling compaction. `T/W ≥ 0.95` → clear override (treat as SDK default 0.80). BYOK uses the provider registry `contextWindow` as `W` (no separate prompt-token limit).

**Command UX:** `/session-context-window` with no arg opens a picker showing options for the active session's model window `W`: 20/40/60/80% snapped to nearest 100k (dedup by token value; red `danger` rendering for `effective < 100_000`), plus "SDK default (~80%)" which clears the override. Flat arg `200000` or `200k` bypasses picker. `default`/`reset`/`full` clears. Active session only; no active session → red toast; busy session → 409.

**Active-model lookup:** command fetches `/api/sessions/:id/state` for `data.model`, looks up `contextWindow` (and `max_prompt_tokens` when present) via `getAvailableModels()`. Unknown/missing `W` → reject (red toast).

**Picker option algorithm:** for each `pct` in `[0.2, 0.4, 0.6, 0.8]`: `raw = pct·W`; `snapped = Math.round(raw / 100_000) · 100_000`; `effective = snapped > 0 ? snapped : raw` (never offer 0). Dedup by `effective`. Sort ascending. Red `danger` for `effective < 100_000`.

**Data flow:** `PATCH /api/sessions/:id { contextBudgetTokens }` → persist to `SessionMeta` → `setSessionContextBudget` → disconnect+resume (reads `contextBudgetTokens`, resolves `W`, computes `infiniteSessionsFor`). On resume failure: restore stashed previous meta value before rethrowing.

| File | Change |
|---|---|
| `src/session-meta-store.ts` | Add `contextBudgetTokens?: number` to `SessionMeta` (absolute tokens; absent = SDK default). |
| `src/session-manager.ts` | `infiniteSessionsFor(modelCacoId)`: reads `contextBudgetTokens`, resolves `W`, returns `{ backgroundCompactionThreshold: clamp(T/W) }` or `undefined`. Thread into create/resume args. `setSessionContextBudget(sessionId, tokens\|null)`: reject busy (409), stash prev, persist, recreate, rollback on failure. |
| `src/routes/sessions.ts` | Extend `PATCH` with `contextBudgetTokens?: number\|null`; validate `> 0` and `≤ W`; null clears. Reject busy (409). Call `setSessionContextBudget`. |
| `public/ts/input-popup.ts` | Add `danger?: boolean` to `PopupItem`; render red class. |
| `public/ts/command-registry.ts` | Register `session-context-window`; flat-arg parse (`k`/`m` suffix, `default`/`reset`/`full`); picker with snapping/dedup/red-rendering; PATCH on select; green/red toasts. |
| `public/style.css` | `.input-popup-item.danger` → `--color-error`. |

No server compaction code — the runtime owns compaction. We only set the threshold at (re)create.

## Invariants

- `backgroundCompactionThreshold` is always strictly below `bufferExhaustionThreshold` (0.95): clamp upper bound is 0.94.
- A failed recreate always restores the previous `contextBudgetTokens` in meta before rethrowing — no orphaned meta state.
- The budget is never applied to a busy session; `setSessionContextBudget` rejects with 409 when busy.
- `T/W ≥ 0.95` is treated as "clear override" (apply SDK default 0.80), never applied as a threshold.

## Considerations

- **Wrong denominator:** the runtime uses `max_prompt_tokens ?? max_context_window_tokens`, not just `max_context_window_tokens`. Server conversion uses this rule; picker `%` labels are approximate (client uses context window for legibility).
- **Model switch with stored budget:** `infiniteSessionsFor` recomputes `T/W` against the current model at each (re)create; if `T/W ≥ 0.95` for the new model, the override is inert (SDK default applies) but meta value is retained.
- **Re-selecting the current budget:** short-circuit, no recreate, success toast.
- **Auto model or BYOK without `contextWindow`:** `W` unknown → reject with red toast (no denominator).
- **Short sessions:** recreate replays full context once; pays off within a few calls on a long session. User opts in explicitly; success toast states "history replays once".
- **Server restart:** budget persists in meta; `infiniteSessionsFor` re-applies on next resume automatically.
- **Sub-agent/swarm sessions:** runtime force-disables `infiniteSessions` there; out of scope.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Threshold ≥ buffer (0.95) disables background compaction | Single rule: `T/W ≥ 0.95 ⇒ clear override`; clamp to `[0.05, 0.94]`. |
| Wrong denominator (window vs prompt-token limit) | Use `max_prompt_tokens ?? max_context_window_tokens ?? 128k`, matching the runtime. |
| `W` unknown (Auto model, BYOK without `contextWindow`) | Reject with red toast; never apply an undefined fraction. |
| Rollback leaves stale meta after failed recreate | Setter stashes previous `contextBudgetTokens`; restores on resume failure before rethrowing. |
| Recreate while session is mid-response | **Busy-session guard**: route returns 409; client red toast. No recreate while busy. |
| Small-model picker offers degenerate sub-100k values | Snap + raw fallback + red rendering (`danger`) + dedup + ascending sort. |
| BYOK compaction summarization unverified live | Failure surfaces as normal resume error + rollback. |
| Budget stored, model later switched to smaller `W` so `T > W_new` | `infiniteSessionsFor` recomputes at each (re)create; same `T/W ≥ 0.95` rule applies. |

## Acceptance

- Observable: `/session-context-window` opens a picker with percentage options + "SDK default"; selecting an option shows a green toast "Context capped at Xk (~Y%) — reconnecting, history replays once"; the footer shows the updated context budget.
- Budgets: one-time replay cost is user-accepted; subsequent calls are cheaper.
- Gates: `npm run build` green; `tests/unit/context-budget.test.ts` green.
- Oracles:
  - `infiniteSessionsFor` computes correct fraction and clamps to `[0.05, 0.94]` (`context-budget.test.ts`).
  - `T/W ≥ 0.95` returns `undefined` (no `infiniteSessions`) (`context-budget.test.ts`).
  - Busy session → 409 (by-construction in route handler).
  - Rollback on resume failure: prev `contextBudgetTokens` restored (by-construction, `session-manager` unit).
  - Picker snapping + dedup + red-rendering: visual (by-construction).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `contextBudgetTokens` to `SessionMeta` + `infiniteSessionsFor` wired into create/resume | `src/session-meta-store.ts`, `src/session-manager.ts` | fraction computed correctly; `T/W≥0.95` → undefined — `context-budget.test.ts` | Threshold always < 0.95 |
| 2 | `setSessionContextBudget` + PATCH route | `src/session-manager.ts`, `src/routes/sessions.ts` | busy → 409; rollback on failure — by-construction | Busy guard; meta rollback |
| 3 | `/session-context-window` command + flat-arg path + toasts | `public/ts/command-registry.ts` | by-construction (integration) | - |
| 4 | Picker UI: `danger` flag, snapping, dedup, red rendering | `public/ts/input-popup.ts`, `public/ts/command-registry.ts`, `public/style.css` | visual (by-construction) | - |

## Rationale

**Apply-timing:** immediate via recreate — the value is mid-job cost reduction. Recreate reuses `setSessionModel`'s proven disconnect→resume→rollback machinery. A purely lazy option (persist now, apply next restart) is strictly weaker.

**No literal "100%":** a cap at the full window inverts the background/buffer thresholds and disables background compaction. "Full window" intent maps to clearing the override (SDK default ~80%).

**BYOK:** `infiniteSessions` has no provider gate (`app.js:4947`); the same field works for BYOK — one mechanism, both paths.

## Edge Cases

- No active session → red toast, no-op.
- Busy session (mid-dispatch) → 409, red toast, no recreate.
- Flat arg `> W` → reject (red). `0` or negative → reject. `default`/`reset`/`full` → clear.
- Re-selecting current budget → short-circuit, no recreate, success toast.
- Auto model or BYOK with no `contextWindow` → reject (no denominator).
- Model switched to smaller window: `T/W ≥ 0.95` → treated as cleared at that (re)create; meta value retained but inert.
- Server restart: budget persists in meta; re-applied on next resume.
