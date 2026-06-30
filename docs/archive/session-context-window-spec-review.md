# Verdict: needs-revision

The core SDK mechanism exists, and recreate-via-resume is the right integration shape, but the spec has several correctness/implementability gaps that should be fixed before implementation.

## Must-fix

1. **Use the SDK's real denominator, not always `contextWindow`.** The runtime computes utilization against `modelInfo.capabilities.limits.max_prompt_tokens || max_context_window_tokens || 128e3`, so `T/W` should use the same prompt-token denominator when present, not only `max_context_window_tokens` exposed as `contextWindow`. Today Caco normalizes/exposes only `max_context_window_tokens`. Citations: `node_modules/@github/copilot/app.js:3644`, `src/session-manager.ts:166-175`, `src/routes/sessions.ts:147-150`, `src/model-billing.ts:18-22`.
2. **Resolve the threshold/buffer contradiction.** The spec says clamp to `0.95` while also saying background must be strictly below the default `bufferExhaustionThreshold` of `0.95`; equality is not strictly below. Specify either `>= 0.95 => clear`, or cap at a value below buffer (for example `0.949`). Citations: `docs/spec-session-context-window.md:56-61`, `node_modules/@github/copilot-sdk/dist/types.d.ts:1099-1109`, `node_modules/@github/copilot/app.js:3644`.
3. **Do not recreate while a session is busy.** Existing message dispatch marks sessions busy, but `PATCH /api/sessions/:id` and `setSessionModel` do not guard model changes against active dispatch; `setSessionModel` can disconnect and force-clear dispatch state. Add a `SESSION_BUSY` rejection or queue/apply-after-idle behavior for context budget changes. Citations: `src/routes/session-messages.ts:243-249`, `src/routes/sessions.ts:434-490`, `src/session-manager.ts:1037-1068`, `src/session-manager.ts:1117-1127`, `src/routes/sessions.ts:396-404`.
4. **Fix client active-model lookup.** `getAvailableModels()` exists, but the active model id is not exported from app state; it is private footer state or available from `/api/sessions/:id/state`. The command spec must require fetching state or adding an explicit state accessor. Citations: `public/ts/app-state.ts:48-64`, `public/ts/chat-view-controller.ts:43-46`, `public/ts/chat-view-controller.ts:380-388`, `src/routes/sessions.ts:571-580`.
5. **Update stale source locations.** Create/resume integration points are `createSession` args at `src/session-manager.ts:486-497` and `resumeArgs` at `src/session-manager.ts:610-621`, not the cited approximate lines. The raw RPC type is `dist/generated/rpc.d.ts`, not `dist/rpc.d.ts`. Citations: `src/session-manager.ts:486-497`, `src/session-manager.ts:610-621`, `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:10470-10505`.
6. **Specify rollback metadata ordering.** `setSessionModel` rollback uses `modelOverride` and does not first persist the new model; a budget setter that writes `SessionMeta.contextBudgetTokens` before recreate must explicitly restore the previous meta value on resume failure. Citations: `src/session-manager.ts:1037-1081`, `src/session-meta-store.ts:18-40`.

## Verified claims

| Claim | Finding | Citations |
|---|---|---|
| `infiniteSessions` is on `SessionConfigBase`. | Verified. | `node_modules/@github/copilot-sdk/dist/types.d.ts:1125-1130`, `node_modules/@github/copilot-sdk/dist/types.d.ts:1322-1326` |
| `backgroundCompactionThreshold` default is `0.80`; `bufferExhaustionThreshold` default is `0.95`; both are 0-1 utilization thresholds. | Verified. | `node_modules/@github/copilot-sdk/dist/types.d.ts:1092-1109`, `node_modules/@github/copilot/app.js:3644` |
| SDK runtime applies `infiniteSessions` without provider gating. | Verified: normalizer reads only `e.infiniteSessions`, and the config is passed to compaction processor; provider is separate config. | `node_modules/@github/copilot/app.js:4947-4949` |
| SDK force-disables infinite sessions for child/sub-agent sessions. | Verified by sub-agent construction with `infiniteSessions:!1`. | `node_modules/@github/copilot/app.js:4947` |
| No live threshold setter exists on the public `Session` API. | Verified: API exposes `send`, `sendAndWait`, `on`, `getEvents`, `disconnect`, `abort`, `setModel`, `log`, `rpc`, and `ui`; no infinite-session setter. | `node_modules/@github/copilot-sdk/dist/session.d.ts:80-100`, `node_modules/@github/copilot-sdk/dist/session.d.ts:124-171`, `node_modules/@github/copilot-sdk/dist/session.d.ts:203-265` |
| Raw `history.*` RPC exists. | Verified in generated RPC types. | `node_modules/@github/copilot-sdk/dist/generated/rpc.d.ts:10470-10505` |
| Caco does not currently pass `infiniteSessions` on create/resume. | Verified by create/resume argument objects; no such field is present. | `src/session-manager.ts:486-497`, `src/session-manager.ts:610-621` |
| `/session-model` is a valid command template. | Verified: built-in command, picker, PATCH call, success/error toasts. | `public/ts/command-registry.ts:17-24`, `public/ts/command-registry.ts:122-147` |
| `PATCH /api/sessions/:id` handles `model` via `setSessionModel`. | Verified. | `src/routes/sessions.ts:434-443`, `src/routes/sessions.ts:481-489` |
| `setSessionModel` has a recreate + rollback pattern. | Partly verified: recreate path exists for BYOK/provider switches with rollback to previous model. GitHub→GitHub uses `session.setModel`. | `src/session-manager.ts:1024-1051`, `src/session-manager.ts:1053-1081` |
| `showToast(msg, {type:'success'|'error'})` is real. | Verified; default type is `error`, and classes are `toast-error`, `toast-success`, `toast-info`. | `public/ts/toast.ts:16-20`, `public/ts/toast.ts:26-47` |
| `PopupItem` lacks danger/red flag. | Verified. | `public/ts/input-popup.ts:3-9`, `public/ts/input-popup.ts:179-199` |
| Client models include `contextWindow`. | Verified. | `public/ts/types.ts:14-23`, `public/ts/app-state.ts:62-64`, `src/routes/sessions.ts:147-150` |
| Server model window source is available for GitHub and BYOK. | Verified for `max_context_window_tokens`; BYOK maps registry `contextWindow` into both capabilities and billing. | `src/model-billing.ts:18-22`, `src/provider-registry.ts:24-29`, `src/provider-registry.ts:105-116`, `src/provider-registry.ts:133-140`, `src/session-manager.ts:408-425` |

## Design disagreements

- **`100% (Full)` is misleading.** Clearing the override does not mean full-window operation; SDK default background compaction starts at 80% and hard-blocks at 95%. Rename to `SDK default (~80%)` or define a true full-window mode intentionally. Citations: `docs/spec-session-context-window.md:29-31`, `node_modules/@github/copilot-sdk/dist/types.d.ts:1099-1109`.
- **Savings may not pay back for short sessions.** The spec acknowledges replay cost, but the current success toast omits it. Consider a one-time confirmation for active sessions above a context/token threshold, or at least a toast/description that says applying reconnects and may replay history once. Citations: `docs/spec-session-context-window.md:44-48`, `docs/spec-session-context-window.md:92-103`.
- **Picker snapping needs an exact algorithm.** State `Math.round`, dedup by effective token value after raw fallback, and sort ascending. The 200k example produces `40k` red from 20%, `100k` from 40/60%, and `200k` from 80%; that is consistent but should be explicit. Citations: `docs/spec-session-context-window.md:27-37`.
- **Model-change recompute is sound only with a policy for `T > W_new`.** Flat args reject `> W`, but later model changes can make stored `T` too large. The risk table says clamp to 0.95; token math says `>=0.95` clears. Pick one behavior. Citations: `docs/spec-session-context-window.md:56-64`, `docs/spec-session-context-window.md:100-105`, `docs/spec-session-context-window.md:109-114`.

## Quality checklist

| Check | Result |
|---|---|
| Goal clear | Yes. `docs/spec-session-context-window.md:5-9` |
| UX comprehensive | Mostly; picker, flat args, toasts covered. Needs active-model source and replay/busy UX. `docs/spec-session-context-window.md:19-50` |
| Code analysis accurate | Mostly; SDK mechanism verified, but denominator/path/line claims need fixes. |
| Risks comprehensive | Missing busy-session recreate risk and short-session payoff/confirmation detail. `docs/spec-session-context-window.md:96-105` |
| Divisible | Yes: R1-R4 are reasonable; R1+R2 minimum useful slice is stated. `docs/spec-session-context-window.md:116-123` |
| Self-contained | Mostly; add denominator, active-model lookup, rollback order, busy behavior. |
| Avoids transient state | Yes. |
| Edge cases | Covers no active session, invalid args, Auto/no window, restart, child sessions; add busy active dispatch and model denominator mismatch. `docs/spec-session-context-window.md:107-114` |
