import { describe, it, expect } from 'vitest';
import { computeNetCreditsSaved } from '../../public/ts/saved-pricing.js';

const rates = { input: 10, cache: 1, output: 30 };

describe('computeNetCreditsSaved — footer headline math', () => {
  it('prices each class at its own rate: fresh+shaping@input, replay+compound@cache, delta@output', () => {
    const net = computeNetCreditsSaved(rates, {
      fresh: 100_000, shaping: 50_000, compound: 400_000, replay: 600_000, outputDelta: 20_000,
    });
    // (150k*10 + 1M*1 - 20k*30)/1e6 = (1.5M + 1M - 0.6M)/1e6 = 1.9
    expect(net).toBeCloseTo(1.9, 9);
  });

  it('is negative when output cost exceeds savings (a costly workflow)', () => {
    const net = computeNetCreditsSaved(rates, {
      fresh: 0, shaping: 0, compound: 0, replay: 0, outputDelta: 100_000,
    });
    expect(net).toBeCloseTo(-3, 9); // -100k*30/1e6
  });

  it('cache class never priced at the input rate (the anti-oversell guard)', () => {
    const onlyCache = computeNetCreditsSaved(rates, { fresh: 0, shaping: 0, compound: 0, replay: 1_000_000, outputDelta: 0 });
    const onlyFresh = computeNetCreditsSaved(rates, { fresh: 1_000_000, shaping: 0, compound: 0, replay: 0, outputDelta: 0 });
    expect(onlyCache).toBeCloseTo(1, 9);   // 1M*1/1e6
    expect(onlyFresh).toBeCloseTo(10, 9);  // 1M*10/1e6 — 10× cache, proving rate split
  });

  it('zero rates yield zero credits (Auto-like)', () => {
    expect(computeNetCreditsSaved({ input: 0, cache: 0, output: 0 }, { fresh: 9e9, shaping: 9e9, compound: 9e9, replay: 9e9, outputDelta: 9e9 })).toBe(0);
  });
});
