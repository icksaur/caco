# Session Reasoning Effort — Spec

## Goals

Allow users to select a reasoning effort level per session via `/session-effort`, see it in the model tooltip, and have it persist across server restarts. Setting effort is a live RPC call — no session reconnect required. After this change, a long session can switch effort (e.g. Low → High) mid-flight to trade cost vs. depth on demand.

## Design

**Mechanism:** `ReasoningEffort = "low" | "medium" | "high" | "xhigh"` — set via live RPC call (`rpc.model.setReasoningEffort`), no reconnect. Works for both GitHub Copilot and BYOK providers with no provider gate (capability flag gates the picker UI).

**Persistence:** `reasoningEffort?: string` in `SessionMeta`. Re-applied at resume via `resumeArgs.reasoningEffort` — not via `setModel` post-resume (which would fire a default-effort turn first). Skip the field in `resumeArgs` when effort equals `model.defaultReasoningEffort` or is absent (no-op).

**`setSessionReasoningEffort(sessionId, effort)` in `SessionManager`:**
- Session must be active → 404 if not.
- Model must support effort (`capabilities.supports.reasoningEffort`) → 400.
- `effort` must be in `model.supportedReasoningEfforts[]` (when present) → 400.
- `effort === null` → clear: call live RPC with `model.defaultReasoningEffort`, remove from meta.
- Calls `active.session.rpc.model.setReasoningEffort({ reasoningEffort: effort ?? defaultEffort })`, then persists.
- Allowed while session is busy (live RPC only affects the *next* turn; no reconnect).

**PATCH `/api/sessions/:id`** accepts `reasoningEffort?: string | null`. Returns `{ success: true }`; frontend updates footer **optimistically** via `setActiveReasoningEffort(value)` on `res.ok` (mirroring `setActiveContextBudget`). Apply same ordering rule as context-budget: mutate first, then read fresh meta for the `updated` snapshot.

**`/resume` and `/state`** return `reasoningEffort: meta?.reasoningEffort ?? null` so the footer initializes on session switch.

**`/session-effort` command:** picker with `supportedReasoningEfforts[]` values + "Default (clear)" first. Label map: `{ low: "Low", medium: "Medium", high: "High", xhigh: "xHigh" }`. If model doesn't support reasoning effort → toast. On selection: PATCH + optimistic `setActiveReasoningEffort` + green toast. Uses `InputPopup` same as `/session-context-window`.

**Model tooltip:** `modelTitleFor()` in `context-footer.ts` appends `· High effort` (or equivalent) when `activeReasoningEffort` is non-null and not equal to `model.defaultReasoningEffort`.

**Model switch clears effort:** `setSessionModel` clears `meta.reasoningEffort` before recreate if the new model lacks `supports.reasoningEffort` or `supportedReasoningEfforts` doesn't include the stored value.

| File | Change |
|---|---|
| `src/session-meta-store.ts` | Add `reasoningEffort?: string` to `SessionMeta` |
| `src/session-manager.ts` | `setSessionReasoningEffort()`; re-apply on resume via `resumeArgs`; clear on model switch |
| `src/routes/sessions.ts` | PATCH accepts `reasoningEffort`; `/resume` + `/state` return it |
| `public/ts/context-footer.ts` | `setActiveReasoningEffort()`, update `modelTitleFor()` |
| `public/ts/command-registry.ts` | `/session-effort` handler + picker |
| `public/ts/chat-view-controller.ts` | Read `reasoningEffort` from resume; call `setActiveReasoningEffort` |

No new files. Unit tests extend existing `command-registry.test.ts`.

## Invariants

- Effort is applied via `resumeArgs`, never via post-resume `setModel` — applying post-resume fires a default-effort turn first.
- Clearing effort = set live RPC to `defaultReasoningEffort` + remove from meta (`ModelSetReasoningEffortRequest.reasoningEffort` is a required `string`; no null/clear path via RPC).
- At the `resumeArgs` boundary, `meta.reasoningEffort` is cast `as ReasoningEffort` — storage is `string` for flexibility; the SDK type is the strict union.
- Model switch always clears an incompatible stored effort before recreate; no stale effort persists across a model change.

## Considerations

- **Clearing effort:** live RPC requires a `string` value; reverting = set to `model.defaultReasoningEffort` via RPC, then remove from meta. Picker shows "Default" as selected; tooltip omits the effort label.
- **Busy-session allowed:** `setReasoningEffort` does not recreate; it only affects the *next* turn. 409 is not needed.
- **BYOK scope:** provider registry currently hardcodes `supports: { reasoningEffort: false }` for all BYOK models; picker will not appear for BYOK sessions until a provider declares support. No special casing — capability flag gates it correctly.
- **Tooltip / picker coherence:** when `meta.reasoningEffort === model.defaultReasoningEffort` or null, `modelTitleFor()` omits the effort segment and the picker highlights "Default". Both views must agree on what "default" means.
- **No new-session flow:** effort selection at session create is out of scope.
- **No visual indicator on session list tile:** out of scope.
- **Auto-adjusting effort based on task complexity:** out of scope.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Stale effort persists after model switch to incompatible model | `setSessionModel` clears `meta.reasoningEffort` before recreate when new model doesn't support it. |
| Post-resume `setModel` fires a default-effort turn first | Apply via `resumeArgs`, never post-resume `setModel`. |
| RPC type mismatch (`string` meta vs `ReasoningEffort` SDK union) | Cast at the `resumeArgs`/`setModel` boundary; validated by capability flags before dispatch. |
| BYOK models not supported | `supports.reasoningEffort: false` hardcoded for BYOK; picker doesn't appear; no special case needed. |
| Tooltip and picker diverge on "default" | Both check `meta.reasoningEffort === model.defaultReasoningEffort || null`; same condition. |

## Acceptance

- Observable: `/session-effort` shows a picker with Low/Medium/High/xHigh + "Default (clear)"; selecting updates the model tooltip (e.g. `Claude Opus 4.8 · 400K · High effort`); effort persists across server restart; switching to a model that doesn't support effort clears it.
- Budgets: n/a (live RPC, no reconnect).
- Gates: `npm run build` green; `tests/unit/command-registry.test.ts` green.
- Oracles:
  - Effort field absent in `resumeArgs` when `meta.reasoningEffort === model.defaultReasoningEffort` (by-construction in `resumeArgs` builder).
  - `setSessionReasoningEffort(null)` → live RPC with `defaultReasoningEffort` → field removed from meta (by-construction, `session-manager` unit).
  - Model switch to incompatible model clears effort before recreate (by-construction, `session-manager` unit).
  - Footer tooltip includes effort label only when non-null and non-default (by-construction, `context-footer` unit).
  - Unsupported model → toast, no picker (by-construction, `command-registry.test.ts`).

## Plan

| # | Step | Files | Oracle | Invariants |
|---|------|-------|--------|------------|
| 1 | Add `reasoningEffort?: string` to `SessionMeta` + thread into `resumeArgs` | `src/session-meta-store.ts`, `src/session-manager.ts` | skip when equals `defaultReasoningEffort` — by-construction | Apply via `resumeArgs` |
| 2 | `setSessionReasoningEffort()` + clear on model switch | `src/session-manager.ts` | null → live RPC with default; model switch clears — unit | Incompatible effort cleared |
| 3 | PATCH accepts `reasoningEffort`; `/resume` + `/state` return it | `src/routes/sessions.ts` | by-construction | - |
| 4 | `setActiveReasoningEffort()` + `modelTitleFor()` update | `public/ts/context-footer.ts` | tooltip has effort label only when non-null+non-default — unit | - |
| 5 | `/session-effort` command + picker | `public/ts/command-registry.ts` | picker on supported; toast on unsupported — `command-registry.test.ts` | - |
| 6 | Read `reasoningEffort` from resume + call `setActiveReasoningEffort` | `public/ts/chat-view-controller.ts` | by-construction | - |

## Background

The SDK exposes `ReasoningEffort = "low" | "medium" | "high" | "xhigh"` per model. Whether a model supports it is declared in `ModelInfo.capabilities.supports.reasoningEffort` and `ModelInfo.supportedReasoningEfforts[]`. Setting effort is a live RPC call (`rpc.model.setReasoningEffort`) — no reconnect required. Works for both GitHub Copilot and BYOK providers with no provider gate.
