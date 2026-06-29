# spec-batch-factor (done)

Make `caco_run_workflow` round-trip savings model-adaptive: discount avoided
round trips by the session's *measured* tool-call batching, instead of the
current full-credit (every collapsed facade call = one saved round trip).

## Goals

- Replay savings stop overselling for batching models (GPT-5.5) and stay realistic
  for serializing ones (Opus). Headline `↯` becomes defensible enough to include
  the replay term. Tooltip exposes the measured batchFactor so the user can *see*
  whether the active model batches.

## Design

The model's batching habit is observable: `batchFactor = totalToolCalls /
totalTurns` (avg tool calls per round trip). ~1 = serializes (collapsing N facade
calls saved ~N−1 trips); ≫1 = batches (those N would have been ~N/M turns, saved
~N/M−1). Trips saved = `ceil(C / batchFactor) − 1` (B=1 → C−1, full; C≤B → 0).

`batchFactor` is computed in `tool.ts` from a throughput snapshot at record time
and passed into the pure `estimateWorkflowSavings(input)`; the model module stays
pure (no session state). Below a warmup (`totalTurns < BATCH_WARMUP_TURNS`, e.g.
3) batchFactor = 1 (current behavior — conservative, keeps full credit early).
`cacheReplayTokensSaved = roundTripsSaved × W` shrinks with the smaller trip count,
so the headline (which already sums replay+compound) self-corrects — no footer
pricing change, just an upstream estimator fix. Footer tooltip adds one line:
`batching: ×B (tools/turn)`.

Mechanism chosen over a fixed `SEQUENTIAL_FRACTION` constant: a constant can't be
right for both models; the ratio self-calibrates with zero model-specific config.

## Invariants

- Model module pure: no session reads; batchFactor is an input.
- batchFactor ≥ 1 (parallelism never *adds* trips); warmup → 1.
- `freshInputTokensSaved` still billed once (pending-bucket deferral unchanged).

## Considerations

- Ratio needs turns to stabilize → warmup fallback. A failed-call retry slightly
  inflates totalToolCalls (overstates batching, conservative — shrinks credit).
- `totalToolCalls/totalTurns` counts narration/final turns with no tool call, so
  it *under*states true tools-per-tool-turn and drifts toward 1 — conservative for
  batchers, and ~1 is the realistic case for serial narrators anyway. Accepted as a
  floor; clamp B≥1. A precise "turns with ≥1 tool call" denominator isn't tracked
  today (future refinement, not v1).
- W proxy + variable fan-out width already make replay an estimate; this only
  improves the trip count. Keep `↯` labelled est.
- batchFactor uses session-lifetime totals (stable), not request totals.

## Risks and Mitigations

- Replay now in headline could still feel large for Opus (B≈1) → it's real there; tooltip shows B + trips so a skeptic verifies.
- Tiny totalTurns div-by-zero → guard, return 1.

## Acceptance

- Observable: footer tooltip shows `batching ×B`; net `↯` shrinks for a batching session, holds for a serial one.
- Gates: typecheck ×2, lint:strict, knip, full tests, build:client.
- Oracles: `workflow-savings-model.test.ts` — B=1 → roundTripsSaved=C−1; B=4,C=49 → ceil(49/4)−1=12; C≤B → 0; B<1 clamped to 1; replay=trips×W; net headline = (fresh+shaping)·in + (replay+compound)·cache − outDelta·out.

## Plan

| # | Step | Files | Oracle | Inv |
|---|------|-------|--------|-----|
| 1 | Add `batchFactor` input; `roundTripsSaved=ceil(C/B)−1`, clamp B≥1 | `src/workflow/savings-model.ts` | model test cases above | pure |
| 2 | Compute B (totals, warmup→1) in tool.ts; pass in | `src/workflow/tool.ts`, `src/config.ts` (WARMUP) | test: B=1 under warmup, B=totals after | B≥1 |
| 3 | Tooltip `batching ×B` line; verify headline math | `public/ts/context-footer.ts` | DOM: B line renders; net = expected sum | - |

## Rationale

A low batchFactor is itself the "Opus won't batch" measurement; workflow is then
the only lever, which is why it dominates Opus savings. Replaces the deep spec's
fixed 0.5 fraction (never implemented) with a measured one.
