/**
 * Tests for context-budget.ts — absolute-token budget → backgroundCompactionThreshold.
 */

import { describe, it, expect } from 'vitest';
import {
  thresholdForBudget,
  promptTokenDenominator,
  SDK_DEFAULT_BACKGROUND_THRESHOLD,
} from '../../src/context-budget.js';

describe('promptTokenDenominator', () => {
  it('prefers max_prompt_tokens over context window', () => {
    expect(promptTokenDenominator({ maxPromptTokens: 190_000, maxContextWindowTokens: 200_000 })).toBe(190_000);
  });
  it('falls back to context window when no prompt limit', () => {
    expect(promptTokenDenominator({ maxContextWindowTokens: 1_000_000 })).toBe(1_000_000);
  });
  it('returns 0 when unknown', () => {
    expect(promptTokenDenominator(undefined)).toBe(0);
    expect(promptTokenDenominator({})).toBe(0);
    expect(promptTokenDenominator({ maxContextWindowTokens: 0 })).toBe(0);
  });
});

describe('thresholdForBudget', () => {
  const W1M = { maxContextWindowTokens: 1_000_000 };

  it('returns null when no budget', () => {
    expect(thresholdForBudget(undefined, W1M)).toBeNull();
    expect(thresholdForBudget(0, W1M)).toBeNull();
    expect(thresholdForBudget(-5, W1M)).toBeNull();
  });

  it('returns null when window unknown (undefined fraction)', () => {
    expect(thresholdForBudget(200_000, undefined)).toBeNull();
    expect(thresholdForBudget(200_000, {})).toBeNull();
  });

  it('computes T/W for a normal cap', () => {
    expect(thresholdForBudget(200_000, W1M)).toBeCloseTo(0.20, 5);
    expect(thresholdForBudget(500_000, W1M)).toBeCloseTo(0.50, 5);
  });

  it('clears (null) when T/W >= 0.95 — no meaningful cap', () => {
    expect(thresholdForBudget(950_000, W1M)).toBeNull();
    expect(thresholdForBudget(1_000_000, W1M)).toBeNull();
    // also when a later model shrink makes T exceed W
    expect(thresholdForBudget(300_000, { maxContextWindowTokens: 200_000 })).toBeNull();
  });

  it('caps just below the buffer threshold (0.94) for 0.95 > T/W >= 0.94', () => {
    // 0.945 ratio → clamp to 0.94, strictly below bufferExhaustionThreshold 0.95
    const t = thresholdForBudget(944_000, W1M);
    expect(t).not.toBeNull();
    expect(t!).toBeLessThan(0.95);
    expect(t!).toBeLessThanOrEqual(0.94);
  });

  it('floors tiny budgets at 0.05 so compaction is never disabled', () => {
    expect(thresholdForBudget(10_000, W1M)).toBe(0.05); // 0.01 ratio → floored
  });

  it('uses the prompt-token denominator when present', () => {
    // 100k budget against a 200k prompt limit = 0.5, not 100k/1M
    expect(thresholdForBudget(100_000, { maxPromptTokens: 200_000, maxContextWindowTokens: 1_000_000 })).toBeCloseTo(0.5, 5);
  });

  it('SDK default constant is 0.80 (documented clear-to value)', () => {
    expect(SDK_DEFAULT_BACKGROUND_THRESHOLD).toBe(0.80);
  });
});
