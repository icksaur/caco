import { describe, it, expect } from 'vitest';
import { modelCostSummary } from '../../src/model-billing.js';
import type { SDKModelInfo } from '../../src/session-manager.js';

function makeModel(overrides: Partial<SDKModelInfo> = {}): SDKModelInfo {
  return { id: 'test', name: 'Test', ...overrides };
}

function tokenPrices(inputPrice: number, outputPrice: number, cachePrice: number, batchSize = 1_000_000) {
  return { billing: { tokenPrices: { inputPrice, outputPrice, cachePrice, batchSize } } };
}

describe('modelCostSummary', () => {
  it('sonnet: 300/1500/30 batch 1e6 medium versatile', () => {
    const m = makeModel({
      ...tokenPrices(300, 1500, 30),
      modelPickerPriceCategory: 'medium',
      modelPickerCategory: 'versatile',
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBe(300);
    expect(s.outputPerMtok).toBe(1500);
    expect(s.cachePerMtok).toBe(30);
    expect(s.priceCategory).toBe('medium');
    expect(s.category).toBe('versatile');
    expect(s.multiplier).toBe(1);
  });

  it('opus: 500/2500/50 batch 1e6 high powerful', () => {
    const m = makeModel({
      ...tokenPrices(500, 2500, 50),
      modelPickerPriceCategory: 'high',
      modelPickerCategory: 'powerful',
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBe(500);
    expect(s.outputPerMtok).toBe(2500);
    expect(s.cachePerMtok).toBe(50);
    expect(s.priceCategory).toBe('high');
    expect(s.category).toBe('powerful');
    expect(s.multiplier).toBe(1);
  });

  it('haiku: 100/500/10 batch 1e6 low lightweight', () => {
    const m = makeModel({
      ...tokenPrices(100, 500, 10),
      modelPickerPriceCategory: 'low',
      modelPickerCategory: 'lightweight',
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBe(100);
    expect(s.outputPerMtok).toBe(500);
    expect(s.cachePerMtok).toBe(10);
    expect(s.priceCategory).toBe('low');
    expect(s.category).toBe('lightweight');
    expect(s.multiplier).toBe(1);
  });

  it('gpt-5.5: 500/3000/50 batch 1e6 high powerful', () => {
    const m = makeModel({
      ...tokenPrices(500, 3000, 50),
      modelPickerPriceCategory: 'high',
      modelPickerCategory: 'powerful',
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBe(500);
    expect(s.outputPerMtok).toBe(3000);
    expect(s.cachePerMtok).toBe(50);
    expect(s.priceCategory).toBe('high');
    expect(s.category).toBe('powerful');
    expect(s.multiplier).toBe(1);
  });

  it('auto: no billing → multiplier 1, all price fields undefined', () => {
    const m = makeModel();
    const s = modelCostSummary(m);
    expect(s.multiplier).toBe(1);
    expect(s.priceCategory).toBeUndefined();
    expect(s.category).toBeUndefined();
    expect(s.inputPerMtok).toBeUndefined();
    expect(s.outputPerMtok).toBeUndefined();
    expect(s.cachePerMtok).toBeUndefined();
  });

  it('synthetic batchSize 500000: price 300 → inputPerMtok 600', () => {
    const m = makeModel({
      billing: { tokenPrices: { inputPrice: 300, batchSize: 500_000 } },
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBe(600);
    expect(s.outputPerMtok).toBeUndefined();
  });

  it('fractional price 2.5 batch 1e6 → inputPerMtok 2.5 unrounded', () => {
    const m = makeModel({
      billing: { tokenPrices: { inputPrice: 2.5, batchSize: 1_000_000 } },
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBe(2.5);
  });

  it('missing batchSize → per-MTOK fields undefined, no throw', () => {
    const m = makeModel({
      billing: { tokenPrices: { inputPrice: 300 } },
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBeUndefined();
    expect(s.multiplier).toBe(1);
  });

  it('batchSize 0 → per-MTOK undefined (no division by zero)', () => {
    const m = makeModel({
      billing: { tokenPrices: { inputPrice: 300, outputPrice: 1500, batchSize: 0 } },
    });
    const s = modelCostSummary(m);
    expect(s.inputPerMtok).toBeUndefined();
    expect(s.outputPerMtok).toBeUndefined();
    expect(Number.isFinite(s.inputPerMtok as number)).toBe(false);
  });
});
