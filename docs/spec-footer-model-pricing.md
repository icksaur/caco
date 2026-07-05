# spec-footer-model-pricing

Status: in progress. Branch: `feature/tool-reveal-r0-r1`.

## Goals

The footer's "spent" (yellow `≈Ncr`) and "saved" (`↯≈Ncr`) figures must BOTH
price in credits whenever the active model has known per-MTOK rates, and BOTH
fall back to the token-only view only when rates are genuinely unknown (Auto).
Today a **context-window variant id** (e.g. `claude-opus-4.6-1m`,
`claude-opus-4.7-1m-internal`) is not found by the footer's exact-id model lookup,
so pricing silently degrades: the yellow cost vanishes and the `↯` glyph prints
raw tokens (`kAbbrev`) as if they were credits.

## Root cause

`estimateCost` and `priceSaved` each independently do
`getAvailableModels().find(m => m.id === activeModelId)` and each independently
bail when it returns `undefined`. The available-models list carries only BASE ids
(`claude-opus-4.6`), never the SDK's variant suffixes (`-1m`, `-1m-internal`), so a
session running a variant model matches nothing. Two failure modes result from one
missing lookup: cost hidden (looks like "no data") and tokens rendered where
credits belong (a silent unit swap — indistinguishable from the legitimate Auto
fallback). Classic implicit coupling: one contract (resolve the active model's
rates) lives in two places and fails silently in each.

## Design

**One shared, pure resolver.** Add `resolveModelRates(models, id): Rates | null`
to `public/ts/saved-pricing.ts` (already the footer's pure pricing module). It:

1. Exact-matches `id` against the model list.
2. On miss, resolves a **variant id to its base** via longest base-id prefix at a
   segment boundary: pick the model whose `id` satisfies
   `variantId.startsWith(model.id + '-')`, preferring the longest such `id`. This
   maps `claude-opus-4.6-1m` → `claude-opus-4.6` and
   `claude-opus-4.7-1m-internal` → `claude-opus-4.7` without matching `auto` or a
   sibling base (`gpt-5.5-1m` does not match `gpt-5`, because the boundary char
   differs).
3. Returns `{ input, cache, output }` only when both `inputPerMtok` and
   `outputPerMtok` are defined (`cachePerMtok` defaults to 0); otherwise `null`
   (Auto / unpriced).

`estimateCost` and `priceSaved` BOTH call it, so they can never disagree about
whether the active model is priced. The token-only glyph is then reached ONLY for
a genuinely unpriced model, never for a priced variant.

Scope: footer pricing only. The same exact-id lookup exists in
`command-registry.ts` (context-window display) and would mis-resolve the same
variant ids; that is noted but out of scope here (it degrades a window number, not
a credits/tokens unit). It can adopt the shared resolver later.

## Invariants

- **One rate-resolution path.** Spent and saved both resolve rates through
  `resolveModelRates`; neither re-implements model lookup. They always agree on
  priced-vs-unpriced.
- **Variant ids price at their base rate.** A `-1m` / `-<suffix>` variant resolves
  to the longest base-id prefix and prices identically to that base; only a truly
  unlisted/Auto model yields `null`.
- **Token fallback means unpriced, never mis-priced.** The `↯<tokens>` glyph and a
  hidden yellow cost occur together and ONLY when `resolveModelRates` returns
  `null`; a priced model never shows tokens in the credits slot.

## Acceptance

- Observable (needs signoff): on a session whose model is `claude-opus-4.6-1m`, the
  yellow `≈Ncr` spent figure renders again and the `↯≈Ncr` saved glyph shows
  credits (not raw tokens). Auto sessions still show tokens for both.
- Gates: `npm run typecheck`, `npm run lint:strict`, `npx knip`, `npx vitest run`,
  `npm run build:client`, `npm run check:specs` — all green.
- Oracles: unit tests on `resolveModelRates` — exact match; `-1m` and
  `-1m-internal` variants resolve to base rates; longest-prefix tiebreak; no false
  match across siblings or `auto`; `null` for unknown id, empty id, and a model
  lacking pricing.

## Plan

| # | Step | Files | Oracle |
|---|------|-------|--------|
| P1 | Add pure `resolveModelRates(models, id)` (exact → variant longest-prefix → rates/null) | `public/ts/saved-pricing.ts` | unit: exact/variant/tiebreak/no-false-match/null cases |
| P2 | Route `estimateCost` + `priceSaved` through `resolveModelRates`; delete the two inline `find`+bail blocks | `public/ts/context-footer.ts` | build; both use one path |
| P3 | Unit-test the resolver | `tests/unit/saved-pricing.test.ts` | P1 oracles green |
