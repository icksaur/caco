import { describe, it, expect } from 'vitest';
import { fuzzyScore } from '../../src/utils/fuzzy-score.js';

describe('fuzzyScore', () => {
  it('scores an empty query as 0 (no signal)', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('scores a non-empty query against an empty target as -1 (impossible)', () => {
    expect(fuzzyScore('a', '')).toBe(-1);
  });

  it('returns -1 when not all query chars are found in order', () => {
    expect(fuzzyScore('abc', 'xyz')).toBe(-1);
    // right chars, wrong order — 'ba' cannot be matched left-to-right in 'ab'
    expect(fuzzyScore('ba', 'ab')).toBe(-1);
  });

  it('awards +1 per char and +5 for a match at index 0 (word start)', () => {
    // 'a' matches 'abc'[0]: +1 base, +5 start-boundary = 6
    expect(fuzzyScore('a', 'abc')).toBe(6);
  });

  it('awards the +10 consecutive-run bonus', () => {
    // 'ab' in 'ab': a → 1 + 5(start) = 6; b → 1 + 10(consecutive) = 11; total 17
    expect(fuzzyScore('ab', 'ab')).toBe(17);
  });

  it('awards the +5 boundary bonus after a separator', () => {
    // 'f' matches 'my-file'[3], preceded by '-': +1 + 5 = 6
    expect(fuzzyScore('f', 'my-file')).toBe(6);
    // separators recognized: - _ / space .
    expect(fuzzyScore('f', 'a_file')).toBe(6);
    expect(fuzzyScore('f', 'a/file')).toBe(6);
    expect(fuzzyScore('f', 'a file')).toBe(6);
    expect(fuzzyScore('f', 'a.file')).toBe(6);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('A', 'abc')).toBe(fuzzyScore('a', 'abc'));
    expect(fuzzyScore('AB', 'ab')).toBe(17);
  });

  it('ranks a contiguous prefix match above a scattered match', () => {
    const contiguous = fuzzyScore('abc', 'abcdef');
    const scattered = fuzzyScore('abc', 'axbxc');
    expect(contiguous).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });
});
