# Session Reasoning Effort — Spec

## Goal

Allow users to select a reasoning effort level per session, see it in the model tooltip, and have it persist across server restarts.

---

## Background

The SDK exposes `ReasoningEffort = "low" | "medium" | "high" | "xhigh"` per model. Whether a model supports it is declared in `ModelInfo.capabilities.supports.reasoningEffort` and `ModelInfo.supportedReasoningEfforts[]`. Setting effort is a **live RPC call** (`rpc.model.setReasoningEffort`) — no reconnect required (unlike context-window budget). Works for both GitHub Copilot and BYOK providers with no provider gate.

---

## Requirements

### R1 — Persist effort in session meta

Add `reasoningEffort?: string` to `SessionMeta` in `session-meta-store.ts`. On resume, pass `...(effort && effort !== defaultEffort && { reasoningEffort: effort as ReasoningEffort })` into `resumeArgs` (alongside `model`) — do **not** re-apply via `setModel` after resume, as that would fire a default-effort turn first. `ResumeSessionConfig` extends `SessionConfigBase` which carries `reasoningEffort?: ReasoningEffort`, so this is the correct injection point.

### R2 — `setSessionReasoningEffort(sessionId, effort)` in session-manager

New method on `SessionManager`. Validates:
- Session must be active → 404
- Model must support reasoning effort (`capabilities.supports.reasoningEffort`) → 400 with clear message
- `effort` must be in `model.supportedReasoningEfforts[]` (when present) → 400
- `effort === null` → clear: call live RPC with `model.defaultReasoningEffort`, then remove `reasoningEffort` from meta. The live RPC `ModelSetReasoningEffortRequest.reasoningEffort` is a required `string` — there is no null/unset path; reverting to default is the only way to clear without reconnecting.

Calls `active.session.rpc.model.setReasoningEffort({ reasoningEffort: effort ?? defaultEffort })`, then persists to meta.
Allowed while session is busy (live RPC only affects the *next* turn; no reconnect occurs).

### R3 — PATCH `/api/sessions/:id` accepts `reasoningEffort`

Add `reasoningEffort?: string | null` to the PATCH body. Wire to `setSessionReasoningEffort`. The PATCH handler returns `{ success: true }` (no body fields) — the frontend updates the footer **optimistically** via `setActiveReasoningEffort(value)` on `res.ok`, mirroring the `setActiveContextBudget` pattern. Apply same ordering rule as context-budget: mutate first, then read fresh meta for the `updated` snapshot.

### R4 — `/resume` and `/state` return `reasoningEffort`

Add `reasoningEffort: meta?.reasoningEffort ?? null` to both response shapes. The frontend needs this to initialize the footer tooltip on session switch.

### R5 — `/session-effort` command with picker

Registered in `command-registry.ts`. Behavior:
- If the active model has `supportedReasoningEfforts[]`, show a picker with those values plus a "Default (clear)" option.
- If the model does not support reasoning effort, show toast: "Active model does not support reasoning effort".
- Picker entries use an explicit label map: `{ low: "Low", medium: "Medium", high: "High", xhigh: "xHigh" }`. The "Default (clear)" entry appears first.
- When `meta.reasoningEffort === model.defaultReasoningEffort` (or effort is null), "Default" is shown as selected in the picker and no effort label appears in the tooltip.
- Uses the same `InputPopup` picker pattern as `/session-context-window`.
- On selection: PATCH with `{ reasoningEffort: value | null }`, call `setActiveReasoningEffort(value)` optimistically on `res.ok`, show green toast.

Command description: `Set reasoning effort for models that support it`.

### R6 — Model tooltip shows effort

Update `modelTitleFor()` in `context-footer.ts`:

```
Claude Opus 4.8 · 400K context window · High effort
```

Effort label is only appended when `activeReasoningEffort` is non-null. Omit when model does not support reasoning effort or effort is at model default.

Add `setActiveReasoningEffort(effort: string | null)` export, mirroring `setActiveContextBudget`. Called from:
- `chat-view-controller.ts` on `/resume` response
- Command registry on successful PATCH

---

## Data Flow

```
/session-effort picker → PATCH /api/sessions/:id { reasoningEffort }
  → setSessionReasoningEffort()
    → rpc.model.setReasoningEffort({ reasoningEffort: effort ?? defaultEffort })  ← live, no reconnect
    → persist meta.reasoningEffort (null = remove field)
  → res.ok → setActiveReasoningEffort(effort) optimistically
→ modelTitleFor() refreshed

On restart:
resumeArgs ← { model, reasoningEffort: meta.reasoningEffort as ReasoningEffort }
  (skipped when effort === defaultEffort or absent)
→ /resume response includes reasoningEffort from fresh meta
→ chat-view-controller calls setActiveReasoningEffort()
```

---

## Considerations

- **Resume via resumeArgs, not setModel:** effort must be in `resumeArgs` (like model), not applied post-resume. `ResumeSessionConfig` extends `SessionConfigBase` which has `reasoningEffort?: ReasoningEffort`. Skip the field when effort equals `model.defaultReasoningEffort` (no-op).
- **Type cast:** `SessionMeta.reasoningEffort` is `string` (for storage flexibility). At the `resumeArgs`/`setModel` boundary, cast `as ReasoningEffort` — the SDK type is the strict union `"low"|"medium"|"high"|"xhigh"`.
- **Clearing effort:** `ModelSetReasoningEffortRequest.reasoningEffort` is a required `string` (no null/clear path via live RPC). Clearing = set to `model.defaultReasoningEffort` via live RPC, then remove from meta. Picker shows "Default" as selected; tooltip omits the effort label.
- **Model switch clears effort (R2 promotes to requirement):** when `setSessionModel` switches to a model that lacks `supports.reasoningEffort` or whose `supportedReasoningEfforts` does not include the stored value, clear `meta.reasoningEffort` before the recreate. See recreate path at `session-manager.ts:~1090`.
- **Busy-session allowed:** `setReasoningEffort` does not recreate the session; it only affects the *next* turn. Reject-when-busy (409) is not needed.
- **BYOK scope:** the RPC is provider-agnostic, but the provider registry currently hardcodes `supports: { reasoningEffort: false }` for all BYOK models. The picker will therefore not appear for BYOK sessions in practice, until a provider declares support. No special casing needed — the capability flag gates it correctly.
- **Tooltip / picker coherence:** when `meta.reasoningEffort === model.defaultReasoningEffort` or effort is null, `modelTitleFor()` omits the effort segment and the picker highlights "Default". These two views must agree on what "default" means.
- **No new-session flow:** effort selection at session create is out of scope.

---

## Files Changed

| File | Change |
|---|---|
| `src/session-meta-store.ts` | Add `reasoningEffort?: string` to `SessionMeta` |
| `src/session-manager.ts` | `setSessionReasoningEffort()`, re-apply on resume via `resumeArgs`, clear on model switch |
| `src/routes/sessions.ts` | PATCH accepts `reasoningEffort`, `/resume` + `/state` return it |
| `public/ts/context-footer.ts` | `setActiveReasoningEffort()`, update `modelTitleFor()` |
| `public/ts/command-registry.ts` | `/session-effort` handler + picker, update description list |
| `public/ts/chat-view-controller.ts` | Read `reasoningEffort` from resume, call `setActiveReasoningEffort` |

No new files needed. No new tests file — unit tests extend existing `command-registry.test.ts`.

---

## Out of Scope

- New-session effort selection (new-chat card)
- Visual indicator on the session list tile for effort level
- Auto-adjusting effort based on task complexity
