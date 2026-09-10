/**
 * Oracles for per-turn usage attribution (spec-usage-metrics amendment, row 8).
 *
 * Under Auto the model captured at dispatch start is 'auto', which prices
 * nothing. Every `assistant.usage` carries its OWN required `model`, so a
 * request is priced turn by turn instead. These pin that the per-turn path is
 * the single source of the record's token columns, cost columns, and turn
 * count — the shipped captured-rates path remains only as the no-turns fallback.
 */

import { describe, it, expect } from 'vitest';
import {
  buildUsageRecord,
  type PricedModel,
  type TurnUsage,
} from '../../src/usage-metrics.js';

const MODELS: PricedModel[] = [
  { id: 'claude-opus-4.6', inputPerMtok: 15, outputPerMtok: 75, cachePerMtok: 1.5, contextWindow: 200_000 },
  { id: 'gpt-5-mini', inputPerMtok: 1, outputPerMtok: 4, cachePerMtok: 0.1, contextWindow: 128_000 },
  { id: 'no-output-model', inputPerMtok: 10, contextWindow: 100_000 },
];

function turn(over: Partial<TurnUsage> = {}): TurnUsage {
  return {
    model: 'claude-opus-4.6',
    freshInputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    initiator: 'root',
    ...over,
  };
}

/** Independent reimplementation of the per-turn price, from the spec formula. */
function priceTurn(t: TurnUsage): number | null {
  const m = MODELS.find(x => x.id === t.model);
  if (!m || m.inputPerMtok === undefined || m.outputPerMtok === undefined) return null;
  return (
    t.freshInputTokens * m.inputPerMtok +
    t.cachedTokens * (m.cachePerMtok ?? 0) +
    t.outputTokens * m.outputPerMtok
  ) / 1_000_000;
}

const base = {
  sessionId: 'sess-1',
  model: 'auto' as string | null,
  rates: null,
  contextWindow: null,
  models: MODELS,
  ts: '2026-09-09T12:00:00.000Z',
};

describe('buildUsageRecord per-turn attribution', () => {
  it('prices each turn at its own model and sums them', () => {
    const perTurn = [
      turn({ model: 'claude-opus-4.6', freshInputTokens: 1_000_000, cachedTokens: 2_000_000, outputTokens: 100_000 }),
      turn({ model: 'gpt-5-mini', freshInputTokens: 500_000, cachedTokens: 1_000_000, outputTokens: 200_000 }),
    ];
    const expected = perTurn.reduce((s, t) => s + (priceTurn(t) ?? 0), 0);

    const rec = buildUsageRecord({
      ...base,
      tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
      perTurn,
    });

    expect(rec.requestCredits).toBeCloseTo(expected, 9);
    expect(rec.creditsComplete).toBe(true);
    expect(rec.unpricedTurns ?? 0).toBe(0);
  });

  it('sources the token columns and turn count from perTurn, not the passed tokens', () => {
    const perTurn = [
      turn({ freshInputTokens: 10, cachedTokens: 20, outputTokens: 30 }),
      turn({ model: 'gpt-5-mini', freshInputTokens: 1, cachedTokens: 2, outputTokens: 3 }),
    ];

    const rec = buildUsageRecord({
      ...base,
      // Deliberately disagrees with perTurn: the record must not read these.
      tokens: { inputTokens: 999, cachedTokens: 999, outputTokens: 999, turns: 99 },
      perTurn,
    });

    expect(rec.inputTokens).toBe(11);
    expect(rec.cachedTokens).toBe(22);
    expect(rec.outputTokens).toBe(33);
    expect(rec.turns).toBe(2);
  });

  it('keeps the per-class cost identity under the per-turn path', () => {
    const perTurn = [
      turn({ freshInputTokens: 123_456, cachedTokens: 789_012, outputTokens: 34_567 }),
      turn({ model: 'gpt-5-mini', freshInputTokens: 7_777, cachedTokens: 88_888, outputTokens: 999 }),
    ];

    const rec = buildUsageRecord({ ...base, tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 }, perTurn });

    expect(rec.requestCredits).toBeCloseTo(
      (rec.inputTokenCost ?? 0) + (rec.cachedTokenCost ?? 0) + (rec.outputTokenCost ?? 0),
      9,
    );
  });

  it('breaks credits and tokens down per model', () => {
    const perTurn = [
      turn({ model: 'claude-opus-4.6', freshInputTokens: 1_000_000, outputTokens: 0 }),
      turn({ model: 'claude-opus-4.6', freshInputTokens: 1_000_000, outputTokens: 0 }),
      turn({ model: 'gpt-5-mini', freshInputTokens: 2_000_000, outputTokens: 0 }),
    ];

    const rec = buildUsageRecord({ ...base, tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 }, perTurn });

    expect(rec.perModelBreakdown?.['claude-opus-4.6'].turns).toBe(2);
    expect(rec.perModelBreakdown?.['claude-opus-4.6'].credits).toBeCloseTo(30, 9);
    expect(rec.perModelBreakdown?.['claude-opus-4.6'].inputTokens).toBe(2_000_000);
    expect(rec.perModelBreakdown?.['gpt-5-mini'].credits).toBeCloseTo(2, 9);
  });

  it('counts an unresolvable model as unpriced while still keeping its tokens', () => {
    const perTurn = [
      turn({ model: 'claude-opus-4.6', freshInputTokens: 1_000_000 }),
      turn({ model: 'mystery-model', freshInputTokens: 500 }),
    ];

    const rec = buildUsageRecord({ ...base, tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 }, perTurn });

    expect(rec.unpricedTurns).toBe(1);
    expect(rec.creditsComplete).toBe(false);
    // Credits are the sum over PRICED turns only...
    expect(rec.requestCredits).toBeCloseTo(15, 9);
    // ...but the unpriced turn's tokens still land in the totals and breakdown.
    expect(rec.inputTokens).toBe(1_000_500);
    expect(rec.perModelBreakdown?.['mystery-model'].credits).toBeNull();
    expect(rec.perModelBreakdown?.['mystery-model'].inputTokens).toBe(500);
  });

  it('nulls all four cost fields when no turn prices, rather than reporting zero spend', () => {
    const perTurn = [turn({ model: 'mystery-model', freshInputTokens: 500, outputTokens: 10 })];

    const rec = buildUsageRecord({ ...base, tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 }, perTurn });

    expect(rec.requestCredits).toBeNull();
    expect(rec.inputTokenCost).toBeNull();
    expect(rec.cachedTokenCost).toBeNull();
    expect(rec.outputTokenCost).toBeNull();
    expect(rec.creditsComplete).toBe(false);
    expect(rec.inputTokens).toBe(500);
  });

  it('splits credits and tokens by initiator without excluding sub-agent spend', () => {
    const perTurn = [
      turn({ initiator: 'root', freshInputTokens: 1_000_000 }),
      turn({ initiator: 'sub-agent', freshInputTokens: 2_000_000 }),
      turn({ initiator: 'mcp-sampling', freshInputTokens: 1_000_000 }),
    ];

    const rec = buildUsageRecord({ ...base, tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 }, perTurn });

    expect(rec.initiatorBreakdown?.root.credits).toBeCloseTo(15, 9);
    expect(rec.initiatorBreakdown?.subAgent?.credits).toBeCloseTo(30, 9);
    expect(rec.initiatorBreakdown?.mcpSampling?.credits).toBeCloseTo(15, 9);
    // Sub-agent spend counts toward the request total (no filter).
    expect(rec.requestCredits).toBeCloseTo(60, 9);
    expect(rec.turns).toBe(3);
  });

  it('omits an initiator bucket that saw no turns', () => {
    const rec = buildUsageRecord({
      ...base,
      tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
      perTurn: [turn({ freshInputTokens: 10 })],
    });

    expect(rec.initiatorBreakdown?.root).toBeDefined();
    expect(rec.initiatorBreakdown?.subAgent).toBeUndefined();
    expect(rec.initiatorBreakdown?.mcpSampling).toBeUndefined();
  });

  it('sums nano-AIU only when a turn reports it, and leaves it absent otherwise', () => {
    const withAiu = buildUsageRecord({
      ...base,
      tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
      perTurn: [turn({ nanoAiu: 120 }), turn({ nanoAiu: 30 }), turn()],
    });
    expect(withAiu.sdkNanoAiu).toBe(150);

    const withoutAiu = buildUsageRecord({
      ...base,
      tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
      perTurn: [turn(), turn()],
    });
    // Absent, not 0 — 0 would claim the SDK reported zero cost.
    expect(withoutAiu.sdkNanoAiu).toBeUndefined();
    expect('sdkNanoAiu' in withoutAiu).toBe(false);
  });

  it('carries the display-only Auto metadata through untouched', () => {
    const rec = buildUsageRecord({
      ...base,
      tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
      perTurn: [turn()],
      autoResolvedTo: 'gpt-5-mini',
      switchedDuringRequest: { fromModel: 'gpt-5-mini', toModel: 'claude-opus-4.6', cause: 'rate_limit_auto_switch' },
    });

    expect(rec.autoResolvedTo).toBe('gpt-5-mini');
    expect(rec.switchedDuringRequest).toEqual({
      fromModel: 'gpt-5-mini',
      toModel: 'claude-opus-4.6',
      cause: 'rate_limit_auto_switch',
    });
    // The captured column is NOT rewritten to the model that actually ran.
    expect(rec.model).toBe('auto');
  });

  it('falls back to the captured-rates path when no turn was observed', () => {
    const rec = buildUsageRecord({
      sessionId: 'sess-1',
      model: 'claude-opus-4.6',
      tokens: { inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0, turns: 3 },
      rates: { input: 15, cache: 1.5, output: 75 },
      contextWindow: 200_000,
      perTurn: [],
    });

    expect(rec.requestCredits).toBeCloseTo(15, 9);
    expect(rec.turns).toBe(3);
    expect(rec.inputTokens).toBe(1_000_000);
    // The fallback path makes no completeness claim.
    expect(rec.creditsComplete).toBeUndefined();
    expect(rec.perModelBreakdown).toBeUndefined();
  });

  it('leaves every amendment field absent on the fallback path so old readers parse unchanged', () => {
    const rec = buildUsageRecord({
      sessionId: 'sess-1',
      model: 'claude-opus-4.6',
      tokens: { inputTokens: 1, cachedTokens: 2, outputTokens: 3, turns: 1 },
      rates: { input: 15, cache: 1.5, output: 75 },
      contextWindow: null,
    });

    for (const key of ['perModelBreakdown', 'unpricedTurns', 'creditsComplete', 'sdkNanoAiu', 'autoResolvedTo', 'switchedDuringRequest', 'initiatorBreakdown']) {
      expect(key in rec).toBe(false);
    }
    // Round-trips as plain JSON with no undefined-valued keys.
    expect(JSON.parse(JSON.stringify(rec))).toEqual(rec);
  });
});
