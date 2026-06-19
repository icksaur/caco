import { describe, it, expect } from 'vitest';
import { estimateSavedTokens, BYTES_PER_TOKEN } from '../../src/workflow/savings.js';

describe('estimateSavedTokens', () => {
  it('converts the byte surplus to tokens at the fixed ratio', () => {
    expect(estimateSavedTokens(4000, 0)).toBe(4000 / BYTES_PER_TOKEN);
    expect(estimateSavedTokens(4000, 400)).toBe(Math.round(3600 / BYTES_PER_TOKEN));
  });

  it('never reports negative savings when the result is larger than reads', () => {
    expect(estimateSavedTokens(100, 5000)).toBe(0);
  });

  it('treats absent/invalid counts as zero', () => {
    expect(estimateSavedTokens(NaN, 10)).toBe(0);
    expect(estimateSavedTokens(-50, 0)).toBe(0);
    expect(estimateSavedTokens(0, 0)).toBe(0);
  });

  it('rounds to the nearest token', () => {
    expect(estimateSavedTokens(10, 0)).toBe(Math.round(10 / BYTES_PER_TOKEN));
  });
});
