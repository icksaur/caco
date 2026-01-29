import { describe, it, expect } from 'vitest';
import { collapseChain, getEffectiveDepth, getUniqueSessionCount } from '../../src/chain-stack.js';

describe('collapseChain', () => {
  it('collapses simple delegation: 1→2→1', () => {
    expect(collapseChain(['1', '2', '1'])).toEqual(['1']);
  });

  it('collapses bounded oscillation: 1→2→1→2→1', () => {
    expect(collapseChain(['1', '2', '1', '2', '1'])).toEqual(['1']);
  });

  it('preserves chain with no returns: 1→2→3', () => {
    expect(collapseChain(['1', '2', '3'])).toEqual(['1', '2', '3']);
  });

  it('handles multi-peer pattern: 1→2→1→3', () => {
    expect(collapseChain(['1', '2', '1', '3'])).toEqual(['1', '3']);
  });

  it('fully collapses complex pattern: 1→2→1→3→1', () => {
    expect(collapseChain(['1', '2', '1', '3', '1'])).toEqual(['1']);
  });

  it('handles partial collapse: 1→2→1→2', () => {
    expect(collapseChain(['1', '2', '1', '2'])).toEqual(['1', '2']);
  });

  it('handles deep chain without collapse: 1→2→3→4→5', () => {
    expect(collapseChain(['1', '2', '3', '4', '5'])).toEqual(['1', '2', '3', '4', '5']);
  });

  it('handles single session', () => {
    expect(collapseChain(['1'])).toEqual(['1']);
  });

  it('handles empty chain', () => {
    expect(collapseChain([])).toEqual([]);
  });

  it('handles immediate return: 1→2→1 at start', () => {
    expect(collapseChain(['1', '2', '1'])).toEqual(['1']);
  });

  it('handles return to middle of stack: 1→2→3→2', () => {
    expect(collapseChain(['1', '2', '3', '2'])).toEqual(['1', '2']);
  });
});

describe('getEffectiveDepth', () => {
  it('returns 1 for simple delegation', () => {
    expect(getEffectiveDepth(['1', '2', '1'])).toBe(1);
  });

  it('returns 1 for oscillation', () => {
    expect(getEffectiveDepth(['1', '2', '1', '2', '1'])).toBe(1);
  });

  it('returns 3 for no-return chain', () => {
    expect(getEffectiveDepth(['1', '2', '3'])).toBe(3);
  });

  it('returns 5 for deep chain', () => {
    expect(getEffectiveDepth(['1', '2', '3', '4', '5'])).toBe(5);
  });

  it('returns 0 for empty chain', () => {
    expect(getEffectiveDepth([])).toBe(0);
  });
});

describe('getUniqueSessionCount', () => {
  it('counts 2 unique sessions in oscillation', () => {
    expect(getUniqueSessionCount(['1', '2', '1', '2', '1'])).toBe(2);
  });

  it('counts 3 unique sessions in multi-peer', () => {
    expect(getUniqueSessionCount(['1', '2', '1', '3', '1'])).toBe(3);
  });

  it('counts 5 unique sessions in deep chain', () => {
    expect(getUniqueSessionCount(['1', '2', '3', '4', '5'])).toBe(5);
  });

  it('counts 1 for single session', () => {
    expect(getUniqueSessionCount(['1'])).toBe(1);
  });

  it('counts 0 for empty chain', () => {
    expect(getUniqueSessionCount([])).toBe(0);
  });
});
