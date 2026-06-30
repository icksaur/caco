# Review — Session Reasoning Effort Spec

## Verdict: **NEEDS WORK**

The goal, UX, and file map are clear and the feature is well-scoped. But there are
two correctness bugs (clear-effort mechanism, R1/R2 internal contradiction) and one
inaccurate code-analysis claim that will mislead the implementer. Fix the blocking
items and this is a solid, implementable spec.

---

## Blocking issues

- **Clearing effort (`null`) is not achievable the way R2 describes.** The live RPC
  `ModelSetReasoningEffortRequest.reasoningEffort` is a **required `string`**
  (`generated/rpc.d.ts:4101`) — there is no unset/clear. R2 says clear = "omit from
  setModel call, remove from meta", but that only updates Caco meta; the live SDK
  session keeps the last effort until it is recreated. **Fix:** define clear as
  *set effort to `model.defaultReasoningEffort` via the live RPC*, then remove from
  meta. (Recreating the session like context-budget also works but is heavier and
  loses the "no reconnect" advantage.)

- **R1 contradicts R2 and the Considerations on the apply mechanism.** R1 says
  re-apply on resume via `session.setModel(modelId, { reasoningEffort })` *after*
  resume; the Considerations (correctly) say it must go through `resumeArgs`. The
  right path exists: `ResumeSessionConfig extends SessionConfigBase` which has
  `reasoningEffort?: ReasoningEffort` (`types.d.ts:1144`). **Fix:** in R1/Data Flow,
  add `...(effort && { reasoningEffort: effort as ReasoningEffort })` to the
  `resumeArgs` object (`session-manager.ts:~650-660`). Drop the post-resume
  `setModel` language entirely — it would fire a default-effort turn first.

- **Inaccurate claim: "Return `reasoningEffort` alongside `contextBudgetTokens`" in
  the PATCH response (R3).** The PATCH handler does **not** return
  `contextBudgetTokens` — its terminal response is `res.json({ success: true })`
  (`sessions.ts:571`). The picker updates the footer **optimistically** on `res.ok`
  via `setActiveContextBudget(tokens)` (`command-registry.ts:244`), not from a
  returned field. **Fix:** either follow the established optimistic pattern (call
  `setActiveReasoningEffort(value)` on `res.ok`, don't rely on a return field), or
  explicitly add a return body to PATCH — but then say so, since today it returns
  none. As written the spec assumes a field that does not exist.

---

## Non-blocking issues

- **"Works for both GitHub Copilot and BYOK… no provider gate" overstates BYOK.**
  The RPC is provider-agnostic, true — but BYOK models are emitted by
  `provider-registry.ts:137` with `supports: { reasoningEffort: false }` hardcoded.
  So in practice the picker (R5) will *not* appear for any current BYOK model. Note
  this: BYOK works only once a provider declares `reasoningEffort: true`.

- **Model-switch clearing is named as a Consideration but not specified as a
  requirement.** It affects correctness (a stale effort on the new model). Promote
  to an explicit requirement: when `setSessionModel` switches to a model whose
  `supportedReasoningEfforts` lacks the stored value (or that lacks
  `supports.reasoningEffort`), clear `meta.reasoningEffort` and don't pass it to the
  recreate. Reference the recreate path at `session-manager.ts:~1090`.

- **Type mismatch.** `SessionMeta.reasoningEffort?: string` is fine for storage, but
  the SDK `reasoningEffort` field on `resumeArgs`/`setModel` is the strict union
  `ReasoningEffort = "low"|"medium"|"high"|"xhigh"` (`types.d.ts:1114`). The live RPC
  param is `string` (no cast needed). Call out the `as ReasoningEffort` cast at the
  resumeArgs/setModel boundary so the implementer isn't surprised by the type error.

- **Busy-session handling unspecified.** Context-budget PATCH rejects busy sessions
  with 409 (`sessions.ts:487-490`) because it recreates. The live effort RPC does
  not recreate, but applying mid-turn is still a question. State explicitly whether
  `/session-effort` is allowed while busy (recommend allowed, since it only affects
  the *next* turn per the SDK doc).

- **Display rule is self-inconsistent.** R5 says entries display as
  `Low/Medium/High/xHigh` but also "capitalize first letter" — that yields `Xhigh`,
  not `xHigh`. Specify an explicit label map instead of a capitalization rule.

- **Default-equals-null edge (Considerations) needs to reach the tooltip/picker
  logic too.** Good that resume skips re-apply when effort == default; also state
  that `modelTitleFor()` must omit the label and the picker must show "Default" as
  selected when `meta.reasoningEffort === model.defaultReasoningEffort`, so the two
  representations of "default" don't diverge.

---

## Confirmed accurate

- `session.rpc.model.setReasoningEffort({ reasoningEffort })` exists and is live
  (`generated/rpc.js:407` → `session.model.setReasoningEffort`). RPC param/return
  shapes match.
- `SDKModelInfo` already carries `supportedReasoningEfforts[]` /
  `defaultReasoningEffort` and `capabilities.supports.reasoningEffort`
  (`session-manager.ts:67,84-85`) — no type plumbing needed there.
- `/resume` and `/state` response shapes are the right injection points
  (`sessions.ts:273,625`); `chat-view-controller.ts:182` already consumes
  `contextBudgetTokens` the same way the new field will be consumed.
- Spec is appropriately small/cohesive, carries no transient/todo state, and the
  file-change table is otherwise correct.
