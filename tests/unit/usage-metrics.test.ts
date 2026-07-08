import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildUsageRecord,
  resolveUsageRates,
  registerUsageSink,
  emitUsageRecord,
  clearUsageSinks,
  type UsageRecord,
  type PricedModel,
} from '../../src/usage-metrics.js';

const MODELS: PricedModel[] = [
  { id: 'claude-opus-4.6', inputPerMtok: 15, outputPerMtok: 75, cachePerMtok: 1.5, contextWindow: 200_000 },
  { id: 'claude-sonnet-4.6', inputPerMtok: 3, outputPerMtok: 15, cachePerMtok: 0.3, contextWindow: 200_000 },
  { id: 'no-cache-model', inputPerMtok: 10, outputPerMtok: 20, contextWindow: 100_000 },
  { id: 'no-output-model', inputPerMtok: 10, contextWindow: 100_000 },
];

describe('resolveUsageRates', () => {
  it('resolves an exact model id to its rates + contextWindow', () => {
    const r = resolveUsageRates(MODELS, 'claude-opus-4.6');
    expect(r.rates).toEqual({ input: 15, cache: 1.5, output: 75 });
    expect(r.contextWindow).toBe(200_000);
    expect(r.model).toBe('claude-opus-4.6');
  });

  it('falls back to the longest base id for a variant id (segment boundary)', () => {
    const r = resolveUsageRates(MODELS, 'claude-opus-4.6-1m-internal');
    expect(r.rates).toEqual({ input: 15, cache: 1.5, output: 75 });
    expect(r.model).toBe('claude-opus-4.6');
  });

  it('defaults the cache rate to 0 when the model omits it', () => {
    const r = resolveUsageRates(MODELS, 'no-cache-model');
    expect(r.rates).toEqual({ input: 10, cache: 0, output: 20 });
  });

  it('returns null rates when the output rate is missing (still surfaces contextWindow)', () => {
    const r = resolveUsageRates(MODELS, 'no-output-model');
    expect(r.rates).toBeNull();
    expect(r.contextWindow).toBe(100_000);
    expect(r.model).toBe('no-output-model');
  });

  it('returns null rates + null id for an unknown model (Auto)', () => {
    const r = resolveUsageRates(MODELS, null);
    expect(r.rates).toBeNull();
    expect(r.contextWindow).toBeNull();
    expect(r.model).toBeNull();
  });
});

describe('buildUsageRecord', () => {
  it('prices each token class per-MTOK and sums requestCredits (footer parity)', () => {
    const rec = buildUsageRecord({
      sessionId: 'sess-1',
      model: 'claude-opus-4.6',
      tokens: { inputTokens: 1_000_000, cachedTokens: 2_000_000, outputTokens: 500_000, turns: 4 },
      rates: { input: 15, cache: 1.5, output: 75 },
      contextWindow: 200_000,
      ts: '2026-07-07T12:00:00.000Z',
    });
    // footer formula: (In*input + Cache*cache + Out*output)/1e6
    expect(rec.inputTokenCost).toBeCloseTo(15, 9);
    expect(rec.cachedTokenCost).toBeCloseTo(3, 9);
    expect(rec.outputTokenCost).toBeCloseTo(37.5, 9);
    expect(rec.requestCredits).toBeCloseTo(55.5, 9);
    expect(rec.model).toBe('claude-opus-4.6');
    expect(rec.contextWindow).toBe(200_000);
    expect(rec.inputTokens).toBe(1_000_000);
    expect(rec.turns).toBe(4);
    expect(rec.ts).toBe('2026-07-07T12:00:00.000Z');
  });

  it('matches the footer estimateCost arithmetic exactly on the same inputs', () => {
    const rates = { input: 3, cache: 0.3, output: 15 };
    const t = { inputTokens: 123_456, cachedTokens: 789_012, outputTokens: 34_567, turns: 2 };
    const footer = (t.inputTokens * rates.input + t.cachedTokens * rates.cache + t.outputTokens * rates.output) / 1_000_000;
    const rec = buildUsageRecord({ sessionId: 's', model: 'claude-sonnet-4.6', tokens: t, rates, contextWindow: null });
    expect(rec.requestCredits).toBeCloseTo(footer, 9);
  });

  it('yields null costs but keeps token counts when rates are unknown (Auto)', () => {
    const rec = buildUsageRecord({
      sessionId: 'sess-1',
      model: null,
      tokens: { inputTokens: 500, cachedTokens: 100, outputTokens: 50, turns: 1 },
      rates: null,
      contextWindow: null,
    });
    expect(rec.inputTokenCost).toBeNull();
    expect(rec.cachedTokenCost).toBeNull();
    expect(rec.outputTokenCost).toBeNull();
    expect(rec.requestCredits).toBeNull();
    expect(rec.inputTokens).toBe(500);
    expect(rec.outputTokens).toBe(50);
  });

  it('stamps an ISO ts when none is given', () => {
    const rec = buildUsageRecord({
      sessionId: 's', model: null,
      tokens: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, turns: 0 },
      rates: null, contextWindow: null,
    });
    expect(() => new Date(rec.ts).toISOString()).not.toThrow();
    expect(rec.ts).toBe(new Date(rec.ts).toISOString());
  });
});

describe('usage sink registry', () => {
  beforeEach(() => clearUsageSinks());

  it('fans a record out to every registered sink', () => {
    const seen: UsageRecord[] = [];
    registerUsageSink({ emit: r => { seen.push(r); } });
    registerUsageSink({ emit: r => { seen.push(r); } });
    const rec = buildUsageRecord({
      sessionId: 's', model: null,
      tokens: { inputTokens: 1, cachedTokens: 0, outputTokens: 0, turns: 1 },
      rates: null, contextWindow: null,
    });
    emitUsageRecord(rec);
    expect(seen).toHaveLength(2);
  });

  it('is best-effort: a throwing sink never blocks the others', () => {
    const seen: string[] = [];
    registerUsageSink({ emit: () => { throw new Error('boom'); } });
    registerUsageSink({ emit: () => { seen.push('ok'); } });
    const rec = buildUsageRecord({
      sessionId: 's', model: null,
      tokens: { inputTokens: 1, cachedTokens: 0, outputTokens: 0, turns: 1 },
      rates: null, contextWindow: null,
    });
    expect(() => emitUsageRecord(rec)).not.toThrow();
    expect(seen).toEqual(['ok']);
  });
});
