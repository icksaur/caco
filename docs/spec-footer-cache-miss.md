# spec-footer-cache-miss

Status: draft. Branch: TBD (off master).

Kin of `spec-budget.md` (the footer cost-display doc of record) and
`spec-input-cost-drivers.md` (the broader cache-miss cost-driver work, surfaced in
the mcp-servers applet). This spec is the **footer** slice: a single always-visible
red figure that answers "how much of my input spend was cache misses?" — the
cheapest possible read of the dominant remaining cost driver, right next to the
existing yellow spend figure. It is a lightweight, footer-only cousin of
`spec-input-cost-drivers.md` P1 (which does ratio-based cold/warm classification for
the applet); the two share the same underlying seam (`recordUsage`) but the footer
figure uses the simplest possible miss definition (zero cache read on the turn).

## Goals

Show cache misses clearly in the meta-context footer. After the prompt-cache work,
fresh (non-cached) input is the primary credit cost, and the single biggest input
waste is a **cache miss** — a model round trip that read zero cached tokens, so its
entire prompt was billed fresh at the full input rate (a slow-typed message that
outlived the ~5-min cache TTL, a compaction, a reveal/model-switch bust, or the
first turn of a conversation). Today the footer shows only the aggregate yellow
spend (`≈Ncr`), which cannot distinguish cheap warm turns from expensive cold
misses. Surface the cache-miss share of input spend as a distinct **red** figure
beside the yellow one.

## Design

**Miss definition (per turn, in `recordUsage`).** An `assistant.usage` turn is a
cache miss when it read **explicitly zero** cached tokens while having a non-empty
prompt (`inputTokens > 0`). "Explicitly zero" is load-bearing: `recordUsage` today
normalizes an absent/non-numeric `cacheReadTokens` to `0` via `safeInt`, which would
mis-count a telemetry gap (unknown cache data) as a miss. So the miss test must
gate on the RAW field being a present finite number equal to zero — not on the
normalized `cache` local. Concretely: `cachePresent = typeof
tokens.cacheReadTokens === 'number' && isFinite(tokens.cacheReadTokens)`, and
`miss = input > 0 && cachePresent && cache === 0`. On a miss turn the entire prompt
is fresh, so `fresh === input`. This is the simplest honest signal and matches the
user's definition; a turn with unknown/absent cache telemetry is simply not
classified either way (it still counts in `totalIn`, just not in the miss slice).

Note (BYOK): a provider without prompt caching reports `cacheReadTokens: 0` on every
turn, so every turn is a miss and the red figure equals the yellow spend. That is
correct and informative — with no caching, all input genuinely is cache-miss cost.

**First turn is a counted case, not a false positive.** The first turn of a
conversation reads zero cache (nothing cached yet), so by the definition above it IS
a miss — and a real cold-start fresh-input cost. It is a legitimately *included*
case of this coarse footer metric, not an error to be excused. (Cross-session prefix
caching means even a brand-new session *can* read cache from a warm same-cwd/
same-model sibling; when it doesn't, counting the first turn as a miss is correct.)
This is a deliberately coarser rule than `spec-input-cost-drivers.md` P1's ratio
test (`r < 0.5 AND fresh > floor`); the footer figure trades that nuance for a
zero-parameter, instantly-legible number.

**Accumulation (two lifetime counters, O(1) per turn, no history).** Add to the
per-session throughput accumulator:

- `coldMissInputTokens` — session-lifetime SUM of `fresh` on miss turns.
- `coldMissTurns` — count of miss turns.

Both accrue in `recordUsage` inside a single `if (input > 0 && cache === 0)` branch,
using the `fresh` already computed there. They are session-lifetime (like `totalIn`
/ `totalCache` / `totalOut`), never reset by `resetRequest`, never persisted across
restart. Because `recordUsage` already adds every turn's `fresh` to `totalIn`, and a
miss turn's `fresh` is exactly its `input`, `coldMissInputTokens` is by construction
a **subset of `totalIn`**: the red figure is the slice of the yellow spend caused by
misses, not an additional cost.

**Snapshot / wire.** `snapshot()` already spreads the whole accumulator into
`ThroughputSnapshot`, so the two fields flow to the client automatically over the
existing `caco.throughput` event and `GET /throughput`. Add the two optional fields
to the footer's `ThroughputData` interface so the client is typed.

**Pricing (shared, pure, unit-tested path).** The red credit cost is
`coldMissInputTokens × rates.input / 1_000_000`. Extract this as a **pure helper**
`cacheMissCredits(rates, coldMissInputTokens): number | null` in
`public/ts/saved-pricing.ts` (already the footer's pure pricing module, covered by
`saved-pricing.test.ts`). It returns `null` when `rates` is null (Auto) or when
`coldMissInputTokens === 0`, and the credit number otherwise. `renderThroughput`
resolves `rates` via the **same** `resolveModelRates(getAvailableModels(),
activeModelId)` used by `estimateCost` / `priceSaved`, then calls
`cacheMissCredits`. Because rates come from the one shared resolver, the red figure
and the yellow spend share priced-vs-unpriced state and can never disagree; a
`null` result hides the red span. Making the pricing pure lets a unit test pin the
rate, the Auto-hide, and the zero-hide behaviors without a DOM.

**Render (footer `renderThroughput`).** After the yellow `tp-cost` span, append a red
`tp-cache-miss` span:

```
×≈1,234cr
```

`×` marks a miss; the number is formatted identically to the yellow cost
(`< 10 → toFixed(2)`, else `Math.round().toLocaleString()`). Styled orange via a new
`.context-footer .tp-cache-miss` CSS rule using `var(--orange, #d4956a)` (the
theme-aware orange). The yellow `tp-cost` spend keeps its color; the orange miss
figure sits beside it. The throughput tooltip gains one line:
`cache misses: <coldMissTurns> turns · <coldMissInputTokens> tok re-encoded (≈<credits>cr)`.

Footer layout order becomes: `… out  ≈Ncr(yellow)  ×≈Mcr(orange)  ⟲Turns`.

## Invariants

- **Red ⊆ yellow.** `coldMissInputTokens ≤ totalIn` always — every miss turn's
  `fresh` is also counted in `totalIn`. The red figure is a partition slice of the
  input spend, never an add-on. Unit-assert `coldMissInputTokens ≤ totalIn`.
- **One rate path.** The red figure resolves rates through `resolveModelRates`, the
  same resolver as the yellow spend; both show or hide together. A priced model
  never renders tokens where credits belong, and Auto hides both.
- **O(1), no per-turn history.** Two integer counters updated in `recordUsage`;
  never a per-turn log, never a scan.
- **Lifetime semantics match the yellow figure.** `coldMissInputTokens` /
  `coldMissTurns` are session-lifetime; `resetRequest` does not clear them (the red
  figure tracks lifetime spend, exactly like the yellow `totalIn`-based cost).
- **Miss = zero cache read on a non-empty prompt, from present telemetry.** Defined
  solely by `input > 0 && cacheReadTokens is a finite number === 0`; a turn whose
  `cacheReadTokens` is absent/non-numeric is NOT classified as a miss (though its
  fresh still counts in `totalIn`). No floor, no ratio (that nuance is
  `spec-input-cost-drivers.md`'s applet concern, not the footer's).

## Considerations

- The first-turn miss is a counted case, documented as such; over a long session it
  is a negligible share and is itself a real fresh cost.
- A degenerate `input === 0` usage event (should not occur) is excluded by the
  `input > 0` guard so it neither bumps `coldMissTurns` nor adds tokens.
- The red figure and the applet cost-driver breakdown (`spec-input-cost-drivers.md`)
  can coexist: the footer red uses the coarse zero-cache rule for a glanceable
  number; the applet may later show the finer TTL-gap-vs-bust attribution. The two
  counters here (`coldMissInputTokens`, `coldMissTurns`) do not conflict with that
  spec's `coldMissFreshTokens` / `warmDeltaFreshTokens` ratio counters — if both
  ship, they are independent fields (name them distinctly) measuring the same
  phenomenon at two granularities.

## Acceptance

- Observable (needs signoff): on a session that has had at least one zero-cache turn
  and runs a priced model, the footer shows a red `×≈Ncr` immediately to the right of
  the yellow `≈Ncr`; hovering shows the "cache misses: … turns · … tok re-encoded"
  line. A session with no miss, or an Auto (unpriced) session, shows no red figure.
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `npm run check:specs` — all green.
- Oracles:
  - `session-throughput.test.ts` — an explicit zero-cache turn (`input>0,
    cacheReadTokens=0`) adds `fresh` to `coldMissInputTokens` and bumps
    `coldMissTurns`; a warm turn (`cacheReadTokens>0`) changes neither; an
    `input=0` event changes neither; a turn with **absent/non-numeric**
    `cacheReadTokens` changes neither (not classified); after a mixed sequence
    `coldMissInputTokens ≤ totalIn` and equals the sum of the miss turns' inputs;
    `snapshot()` exposes both fields; `resetRequest` leaves them unchanged.
  - `saved-pricing.test.ts` — `cacheMissCredits` returns the input-rate credit for a
    priced model, `null` for Auto (null rates), and `null` for zero tokens.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| P1 | Add `coldMissInputTokens` + `coldMissTurns` to `SessionThroughput`; init in `blank()`; accrue in `recordUsage` under `if (input > 0 && cachePresent && cache === 0)` where `cachePresent` tests the raw `cacheReadTokens` is a finite number; leave untouched by `resetRequest` | `src/session-throughput.ts` | unit: explicit zero-cache turn accrues; warm/empty/absent-cache don't; `≤ totalIn`; snapshot exposes; reset preserves |
| P2 | Add pure `cacheMissCredits(rates, coldMissInputTokens)` (null on Auto/zero) | `public/ts/saved-pricing.ts` | unit: priced → credit; Auto → null; zero → null |
| P3 | Thread the two fields into `ThroughputData`; render orange `×≈Ncr` via `resolveModelRates` + `cacheMissCredits` next to `tp-cost` (hidden when null); add the tooltip line | `public/ts/context-footer.ts` | build; visual signoff |
| P4 | Add `.context-footer .tp-cache-miss` orange rule (`var(--orange, #d4956a)`, `margin-left: var(--space-xs)`) | `public/style.css` | visual signoff |
| P5 | Unit-test the P1 + P2 oracles | `tests/unit/session-throughput.test.ts`, `tests/unit/saved-pricing.test.ts` | P1/P2 oracles green |
