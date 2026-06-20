import { describe, it, expect } from 'vitest';
import { modelCostSummary, effectiveContextTier, effectiveContextMax, tokenLimitsForModel } from '../../src/model-billing.js';
import { thresholdForBudget } from '../../src/context-budget.js';
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

// A tiered model whose long-context tier is PRICE-EQUAL to default (Claude-style):
// Caco pins long_context — a free window upgrade.
function priceEqualTiered(): SDKModelInfo {
  return {
    id: 'opus-like',
    name: 'Opus-like',
    billing: {
      tokenPrices: {
        inputPrice: 500, outputPrice: 2500, cachePrice: 50, batchSize: 1_000_000,
        contextMax: 200_000,
        longContext: { inputPrice: 500, outputPrice: 2500, cachePrice: 50, contextMax: 936_000 },
      },
    },
    capabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 936_000 } },
  };
}

// A tiered model whose long-context tier costs MORE (GPT-5.5-style): Caco stays on
// default to avoid silently multiplying token cost.
function priceHigherTiered(): SDKModelInfo {
  return {
    id: 'gpt55-like',
    name: 'GPT-5.5-like',
    billing: {
      tokenPrices: {
        inputPrice: 500, outputPrice: 3000, cachePrice: 50, batchSize: 1_000_000,
        contextMax: 272_000,
        longContext: { inputPrice: 1000, outputPrice: 4500, cachePrice: 100, contextMax: 922_000 },
      },
    },
    capabilities: { limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000 } },
  };
}

describe('effectiveContextTier (single source of truth)', () => {
  it('price-equal long-context block → long_context', () => {
    expect(effectiveContextTier(priceEqualTiered())).toBe('long_context');
  });
  it('price-higher long-context block → default (no silent cost increase)', () => {
    expect(effectiveContextTier(priceHigherTiered())).toBe('default');
  });
  it('no long-context block → default', () => {
    const m = makeModel({ ...tokenPrices(300, 1500, 30) });
    expect(effectiveContextTier(m)).toBe('default');
  });
  it('no billing → default', () => {
    expect(effectiveContextTier(makeModel())).toBe('default');
  });
});

describe('effectiveContextMax (budget denominator)', () => {
  it('price-equal model → long-context contextMax (936K)', () => {
    expect(effectiveContextMax(priceEqualTiered())).toBe(936_000);
  });
  it('price-higher model → default contextMax (272K)', () => {
    expect(effectiveContextMax(priceHigherTiered())).toBe(272_000);
  });
  it('no billing → undefined (caller falls back to flat caps)', () => {
    expect(effectiveContextMax(makeModel())).toBeUndefined();
  });
});

describe('modelCostSummary tier-awareness', () => {
  it('price-equal model: long-context window + (equal) long-context prices', () => {
    const s = modelCostSummary(priceEqualTiered());
    expect(s.contextWindow).toBe(936_000);
    expect(s.inputPerMtok).toBe(500);
    expect(s.outputPerMtok).toBe(2500);
    expect(s.cachePerMtok).toBe(50);
  });

  it('price-higher model: DEFAULT window + DEFAULT prices (never long window at default price)', () => {
    const s = modelCostSummary(priceHigherTiered());
    expect(s.contextWindow).toBe(272_000);
    expect(s.contextWindow).not.toBe(1_050_000);
    expect(s.contextWindow).not.toBe(922_000);
    expect(s.inputPerMtok).toBe(500);
    expect(s.outputPerMtok).toBe(3000);
    expect(s.cachePerMtok).toBe(50);
  });

  it('non-tiered model: falls back to capabilities max_context_window_tokens', () => {
    const m = makeModel({
      ...tokenPrices(300, 1500, 30),
      capabilities: { limits: { max_context_window_tokens: 128_000 } },
    });
    const s = modelCostSummary(m);
    expect(s.contextWindow).toBe(128_000);
  });
});

describe('tokenLimitsForModel + thresholdForBudget (budget denominator)', () => {
  // Synthetic hand case with DISTINCT values so the test cannot pass on a
  // shared-wrong denominator: flat cap 1M, long-context (price-equal) ctx 800K,
  // budget 400K → threshold 0.5 (= 400K/800K), NOT 0.4 (= 400K/1M).
  function distinctTiered(): SDKModelInfo {
    return {
      id: 'distinct',
      name: 'Distinct',
      billing: {
        tokenPrices: {
          inputPrice: 100, outputPrice: 200, cachePrice: 10, batchSize: 1_000_000,
          contextMax: 150_000,
          longContext: { inputPrice: 100, outputPrice: 200, cachePrice: 10, contextMax: 800_000 },
        },
      },
      capabilities: { limits: { max_context_window_tokens: 1_000_000, max_prompt_tokens: 1_000_000 } },
    };
  }

  it('prefers the pinned (long-context) contextMax over flat caps', () => {
    const limits = tokenLimitsForModel(distinctTiered());
    expect(limits.maxPromptTokens).toBe(800_000);
    expect(thresholdForBudget(400_000, limits)).toBeCloseTo(0.5, 5);
    expect(thresholdForBudget(400_000, limits)).not.toBeCloseTo(0.4, 5);
  });

  it('budget ≥ 0.95×window clears (null)', () => {
    const limits = tokenLimitsForModel(distinctTiered());
    expect(thresholdForBudget(760_000, limits)).toBeNull(); // 0.95 × 800K
  });

  it('price-higher model uses default contextMax as denominator', () => {
    const m: SDKModelInfo = {
      id: 'gpt-like', name: 'GPT-like',
      billing: { tokenPrices: {
        inputPrice: 500, outputPrice: 3000, cachePrice: 50, batchSize: 1_000_000,
        contextMax: 272_000,
        longContext: { inputPrice: 1000, outputPrice: 4500, cachePrice: 100, contextMax: 922_000 },
      } },
      capabilities: { limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 922_000 } },
    };
    expect(tokenLimitsForModel(m).maxPromptTokens).toBe(272_000);
  });

  it('non-tiered model falls back to flat capability limits', () => {
    const m: SDKModelInfo = {
      id: 'flat', name: 'Flat',
      capabilities: { limits: { max_prompt_tokens: 128_000, max_context_window_tokens: 200_000 } },
    };
    const limits = tokenLimitsForModel(m);
    expect(limits.maxPromptTokens).toBe(128_000);
    expect(limits.maxContextWindowTokens).toBe(200_000);
  });
});
