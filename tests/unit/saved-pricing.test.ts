import { describe, it, expect } from 'vitest';
import { computeNetCreditsSaved, resolveModelRates, cacheMissCredits } from '../../public/ts/saved-pricing.js';
import type { ModelInfo } from '../../public/ts/types.js';

const rates = { input: 10, cache: 1, output: 30 };

const M = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo =>
  ({ id, name: id, cost: 1, inputPerMtok: 500, outputPerMtok: 2500, cachePerMtok: 50, ...extra });

const MODELS: ModelInfo[] = [
  M('auto', { inputPerMtok: undefined, outputPerMtok: undefined, cachePerMtok: undefined }),
  M('claude-opus-4.6', { inputPerMtok: 500, outputPerMtok: 2500, cachePerMtok: 50 }),
  M('claude-opus-4.7', { inputPerMtok: 600, outputPerMtok: 3000, cachePerMtok: 60 }),
  M('gpt-5', { inputPerMtok: 100, outputPerMtok: 400, cachePerMtok: 10 }),
  M('gpt-5.5', { inputPerMtok: 200, outputPerMtok: 800, cachePerMtok: 20 }),
];

describe('resolveModelRates — shared spent/saved rate resolution', () => {
  it('exact-matches a listed model', () => {
    expect(resolveModelRates(MODELS, 'claude-opus-4.6')).toEqual({ input: 500, cache: 50, output: 2500 });
  });

  it('resolves a -1m variant id to its base model rates', () => {
    expect(resolveModelRates(MODELS, 'claude-opus-4.6-1m')).toEqual({ input: 500, cache: 50, output: 2500 });
  });

  it('resolves a -1m-internal variant id to its base model rates', () => {
    expect(resolveModelRates(MODELS, 'claude-opus-4.7-1m-internal')).toEqual({ input: 600, cache: 60, output: 3000 });
  });

  it('does not false-match a sibling base whose id is a text prefix but not a segment prefix', () => {
    // 'gpt-5.5-1m' must resolve to gpt-5.5, NOT gpt-5 (boundary char after 'gpt-5' is '.', not '-')
    expect(resolveModelRates(MODELS, 'gpt-5.5-1m')).toEqual({ input: 200, cache: 20, output: 800 });
  });

  it('prefers the longest base-id prefix when several match', () => {
    const models = [M('gpt-5', { inputPerMtok: 100, outputPerMtok: 400, cachePerMtok: 10 }), M('gpt-5-turbo', { inputPerMtok: 150, outputPerMtok: 600, cachePerMtok: 15 })];
    expect(resolveModelRates(models, 'gpt-5-turbo-1m')).toEqual({ input: 150, cache: 15, output: 600 });
  });

  it('returns null for Auto (no pricing) even on exact match', () => {
    expect(resolveModelRates(MODELS, 'auto')).toBeNull();
  });

  it('returns null for an unknown id, null id, and empty id', () => {
    expect(resolveModelRates(MODELS, 'no-such-model')).toBeNull();
    expect(resolveModelRates(MODELS, null)).toBeNull();
    expect(resolveModelRates(MODELS, '')).toBeNull();
  });

  it('returns null when a matched model lacks pricing fields', () => {
    const models = [M('x', { inputPerMtok: 100, outputPerMtok: undefined })];
    expect(resolveModelRates(models, 'x')).toBeNull();
    expect(resolveModelRates(models, 'x-1m')).toBeNull();
  });
});

describe('computeNetCreditsSaved — footer headline math', () => {
  it('prices each class at its own rate: fresh+shaping@input, replay+compound+deferred@cache, delta@output', () => {
    const net = computeNetCreditsSaved(rates, {
      fresh: 100_000, shaping: 50_000, compound: 400_000, replay: 600_000, outputDelta: 20_000, deferredDefs: 0,
    });
    // (150k*10 + 1M*1 - 20k*30)/1e6 = (1.5M + 1M - 0.6M)/1e6 = 1.9
    expect(net).toBeCloseTo(1.9, 9);
  });

  it('is negative when output cost exceeds savings (a costly workflow)', () => {
    const net = computeNetCreditsSaved(rates, {
      fresh: 0, shaping: 0, compound: 0, replay: 0, outputDelta: 100_000, deferredDefs: 0,
    });
    expect(net).toBeCloseTo(-3, 9); // -100k*30/1e6
  });

  it('cache class never priced at the input rate (the anti-oversell guard)', () => {
    const onlyCache = computeNetCreditsSaved(rates, { fresh: 0, shaping: 0, compound: 0, replay: 1_000_000, outputDelta: 0, deferredDefs: 0 });
    const onlyFresh = computeNetCreditsSaved(rates, { fresh: 1_000_000, shaping: 0, compound: 0, replay: 0, outputDelta: 0, deferredDefs: 0 });
    expect(onlyCache).toBeCloseTo(1, 9);   // 1M*1/1e6
    expect(onlyFresh).toBeCloseTo(10, 9);  // 1M*10/1e6 — 10× cache, proving rate split
  });

  it('accrued deferred defs price at the cache rate, same class as replay/compound (Slice C)', () => {
    const onlyDeferred = computeNetCreditsSaved(rates, { fresh: 0, shaping: 0, compound: 0, replay: 0, outputDelta: 0, deferredDefs: 1_000_000 });
    const onlyReplay = computeNetCreditsSaved(rates, { fresh: 0, shaping: 0, compound: 0, replay: 1_000_000, outputDelta: 0, deferredDefs: 0 });
    expect(onlyDeferred).toBeCloseTo(1, 9); // 1M*cache(1)/1e6 — NOT the input rate (10)
    expect(onlyDeferred).toBeCloseTo(onlyReplay, 9); // identical class
  });

  it('zero rates yield zero credits (Auto-like)', () => {
    expect(computeNetCreditsSaved({ input: 0, cache: 0, output: 0 }, { fresh: 9e9, shaping: 9e9, compound: 9e9, replay: 9e9, outputDelta: 9e9, deferredDefs: 9e9 })).toBe(0);
  });
});

describe('cacheMissCredits — footer red cache-miss figure', () => {
  it('prices miss tokens at the input rate only', () => {
    // 1M miss tokens × input(10)/1e6 = 10 cr (never the cache rate)
    expect(cacheMissCredits(rates, 1_000_000)).toBeCloseTo(10, 9);
  });

  it('returns null for Auto (null rates) regardless of tokens', () => {
    expect(cacheMissCredits(null, 1_000_000)).toBeNull();
  });

  it('returns null when there are no miss tokens (hides in lockstep with zero misses)', () => {
    expect(cacheMissCredits(rates, 0)).toBeNull();
    expect(cacheMissCredits(rates, -5)).toBeNull();
  });
});
