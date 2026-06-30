# Long-Context Tier Spec

Status: **draft**

## Goals

Pin every Caco session to the model's **`long_context`** context tier (when the model
supports tiers) so that `/session-context-window` can actually control the full window,
and make Caco's billing/window display tier-aware so cost estimates stay honest.

## Background

Tiered models (e.g. `claude-opus-4.8`) expose two different "context_max" values that
live in **`billing.token_prices`**, NOT in `capabilities`:

| Source | Field | opus-4.8 |
| --- | --- | --- |
| `capabilities.limits` (flat ceiling) | `max_prompt_tokens` / `max_context_window_tokens` | 936K / 1M |
| `billing.token_prices.default` | `context_max` (+ prices) | ~200K |
| `billing.token_prices.long_context` | `context_max` (+ prices) | ~1M |

At session start the SDK reads the selected `contextTier`, looks up
`token_prices[tier].context_max`, and turns it into a `modelCapabilitiesOverrides` that
**clamps** the flat capability. Caco never sets `contextTier`, so sessions run on the
**default** tier (~200K). `session.usage_info.tokenLimit` then reports 200K → the footer
shows "200K window / 160K before compaction" (80%).

### Two bugs this causes

1. **`/session-context-window` is half-broken.** The budget→fraction math uses
   `modelTokenLimits` = the *flat* capabilities (936K), but the SDK actually runs at the
   default tier (200K). A budget of e.g. 500K becomes fraction `500K/936K = 0.53`, which
   the SDK applies against its 200K limit → compaction at ~106K. The user cannot express
   any window above the default tier, and budgets below it are miscalculated.
2. **Window/cost display is tier-naive.** `model-billing.ts` reports
   `max_context_window_tokens` (1M ceiling) as the window while the session is actually
   capped at 200K, and reports the *default*-tier prices. Both are inconsistent with the
   running session.

Pinning `long_context` aligns the SDK's effective limit (~1M) with Caco's flat-capability
denominator, fixing (1), and the billing change fixes (2).

### Measured — `claude-opus-4.8` (live `/api/models/raw`, 2026-06-20)

```
tokenPrices.default      : in 500 / out 2500 / cache 50 · contextMax 200,000
tokenPrices.long_context : in 500 / out 2500 / cache 50 · contextMax 936,000
capabilities.limits      : max_prompt_tokens 936,000 · max_context_window_tokens 1,000,000
```

Two findings that de-risk the decision:
- **Prices are identical across tiers** for opus-4.8 → pinning long_context costs *nothing*
  extra here. The pricing tradeoff is real only on models where the `long_context` block
  has higher prices (not this one).
- **`long_context.contextMax (936K) == flat max_prompt_tokens (936K)`** → Caco's existing
  `modelTokenLimits` (flat caps) already equals the long-context denominator, so the budget
  math is correct *once pinned* with no change to `modelTokenLimits`. The step-2 test guards
  the assumption for other models.

## Design

`contextTier` is a `SessionOptions` field (`"default" | "long_context"`) persisted by the
SDK in `session.start` and refreshed in `session.resume`. The SDK treats it as
"apply when supported" — non-tiered models ignore it, so setting it unconditionally is safe.

1. **Pin the tier (unconditional, v1).** Pass `contextTier: 'long_context'` in:
   - `createSession` (`session-manager.ts:594`),
   - resume args (`session-manager.ts:728-743`), and
   - the in-place **model-switch fast path** (`setSessionModel`, `session-manager.ts:1172-1197`).
   The fast path currently calls `active.session.setModel(model)`, typed `setModel(model: string)`
   — it cannot carry the tier. The underlying SDK exposes the richer
   `setSelectedModel(model, reasoningEffort?, modelCapabilitiesOverrides?, reasoningSummary?, contextTier?)`.
   **Impl substep:** verify Caco's `CopilotSessionInstance` can reach `setSelectedModel` (widen the
   interface at `session-manager.ts:139` if so) and pass `contextTier: 'long_context'`; if the live
   session object only exposes `setModel`, force the cross-provider **recreate/resume** path for any
   switch into a tiered model so the tier applies, and document that explicitly. No per-session meta
   field and no UI toggle in v1 — every session gets the max tier. (A future opt-out is noted under
   Considerations.) The `setSessionContextBudget` recreate path already goes through `resume()`
   (`session-manager.ts:1273-1275`), so it inherits the tier for free.
2. **Tier-aware billing.** `modelCostSummary` (`model-billing.ts`) must, when a
   `tokenPrices.longContext` block exists, prefer it:
   - `contextWindow = tokenPrices.longContext.contextMax ?? max_context_window_tokens ?? tokenPrices.contextMax`
   - `inputPerMtok / outputPerMtok / cachePerMtok` from `tokenPrices.longContext.*`,
     falling back to the flat fields when the long-context block omits one.
   This keeps the footer window, the cost estimate, and `/session-context-window`'s
   denominator all describing the same (long-context) tier. **Also:** `priceCategory` still comes
   from `modelPickerPriceCategory` (default-tier). When the long-context block has *higher* prices
   than default, the picker color/category understates cost — surface a "long context" marker (or
   recompute the category) so the category isn't read as default pricing. For price-equal models
   (opus-4.8) this is a no-op.
3. **Budget denominator alignment.** `modelTokenLimits` (`session-manager.ts:476-483`) currently
   reads only the flat `capabilities.limits`. Because tiering is NOT a capability concept, correctness
   must not depend on the flat ceiling happening to equal the tier's `context_max`. Change
   `modelTokenLimits` to **prefer `billing.tokenPrices.longContext.contextMax`** (the tier Caco pins),
   falling back to flat `max_prompt_tokens ?? max_context_window_tokens` only when no long-context
   block exists. This makes `/session-context-window` route validation and `thresholdForBudget` use the
   same W the SDK enforces, for every tiered model — not just opus.

## Considerations

- **Pricing tradeoff (the one real cost).** `long_context` is a *separate* billing tier; for
  some models it is pricier. opus-4.8 is **price-identical** across tiers (measured), so "always
  long_context" is free there. Step 0 enumerates *all* built-in models exposing a
  `tokenPrices.longContext` block, records each tier's price delta and `context_max`, and smoke
  create/resumes each — to catch not just price but any availability/latency/quota difference of
  the long-context tier. If some model's long_context is materially worse, we revisit a per-session
  opt-out (`contextTier` in meta + a `/session-context-tier` command, mirroring
  `/session-context-window`). Deferred out of v1 per the decision to "always set long_context."
- **Non-tiered & BYOK models.** `contextTier` is ignored by the SDK when unsupported;
  billing falls back to flat fields when no `longContext` block exists. No special-casing.
- **Existing sessions.** The tier is applied on next resume (incl. the recreate triggered by
  `setSessionContextBudget`), so already-running sessions pick it up without migration.
- **No new persisted state** in v1 → nothing to migrate or prune.

## Acceptance

| Behavior | Oracle |
| --- | --- |
| create/resume args carry `contextTier:'long_context'` | unit test on the option-builder (reference: the field is present for tiered + non-tiered model ids alike) |
| model-switch fast path applies the tier | unit test on `setSessionModel`: switching into a tiered model results in `contextTier:'long_context'` being applied (via `setSelectedModel`, or a forced recreate/resume) |
| `modelCostSummary` returns long-context prices + window when a `longContext` block exists | **reference reimpl** in test: hand-built `SDKModelInfo` with distinct default vs long_context prices/contextMax → assert summary equals the long_context numbers; and a no-longContext model → assert it equals the flat numbers (fallback) |
| budget math uses the long-context denominator | **synthetic hand case** with deliberately distinct values: flat caps `max_prompt_tokens 1_000_000`, `tokenPrices.longContext.contextMax 800_000`, budget `400_000` → `modelTokenLimits` returns `800_000` and `thresholdForBudget` yields `0.5` (= 400K/800K), NOT 0.4 (= 400K/1M). Also: budget ≥ `0.95×800_000` clears (null). |
| live: a fresh tiered session reports the long-context window | integration check — `session.usage_info.tokenLimit` ≈ long_context `context_max` (≫200K), footer shows ~936K |

Oracles are reference reimplementations / hand cases (not weak invariants): the billing test
compares against independently-stated tier numbers, and the budget test computes the expected
compaction point on paper.

## Plan

- [x] **0. Measure tiers.** Done for opus-4.8 — see "Measured" above. **Remaining:** enumerate ALL
  built-in models with a `tokenPrices.longContext` block (via `/api/models/raw`), record each tier's
  price delta + `context_max`, and smoke create/resume each to confirm the long-context tier is
  available with no materially worse latency/quota. Confirms go/no-go for unconditional pin.
- [ ] **1. Tier-aware billing (test-first).** Write the `modelCostSummary` reference test
  (long_context block present → long-context numbers; absent → flat fallback). Then update
  `model-billing.ts` to prefer `tokenPrices.longContext` for prices + `contextMax`. Surface a
  long-context price-category marker when long_context prices exceed default. Verify footer window + cost.
- [ ] **2. Budget denominator (test-first).** Add the synthetic `modelTokenLimits`/`thresholdForBudget`
  test (flat 1M vs long 800K vs budget 400K → 0.5). Update `modelTokenLimits` to prefer
  `tokenPrices.longContext.contextMax`, falling back to flat limits only when absent. Confirm the
  `/session-context-window` route validation reads the same W.
- [ ] **3. Pin the tier.** Add `contextTier: 'long_context'` to `createSession`, resume args, AND the
  `setSessionModel` fast path (widen `CopilotSessionInstance` to `setSelectedModel` or force recreate
  for tiered switches — see Design §1). Add option-builder + `setSessionModel` unit tests. Type the
  field on Caco's create/resume/session config as needed.
- [ ] **4. Integration verify.** Start a fresh opus-4.8 session; confirm `usage_info.tokenLimit`
  ≈ 936K and that a `/session-context-window` budget of e.g. 500K produces compaction at ~500K
  (not ~106K). Switch a running session into opus-4.8 and confirm it also reports the long-context
  window. Visual signoff on the footer window/cost.
- [ ] **5. Gates + review.** typecheck ×2, lint:strict, knip, vitest; dispatch a background
  spec/code review; fold warranted feedback.
