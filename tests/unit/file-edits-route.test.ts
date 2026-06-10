import { describe, it, expect } from 'vitest';
import { isValidRef } from '../../src/routes/file-edits.js';

describe('isValidRef (V6 §5.3 supported subset)', () => {
  describe('accepts', () => {
    const valid = [
      'HEAD',
      'HEAD~',
      'HEAD~3',
      'HEAD^',
      'HEAD^^',
      'master',
      'main',
      'v1.2.3',
      'feature/x',
      'feature/x-y_z',
      'abc123',
      'cafef00d1234567890',
      'HEAD~1..HEAD',
      'HEAD~1...HEAD',
      'A..B',
      'feature/x..master',
      'a1b2c3..d4e5f6',
    ];
    for (const ref of valid) {
      it(`"${ref}"`, () => {
        expect(isValidRef(ref)).toBe(true);
      });
    }
  });

  describe('rejects', () => {
    const invalid: Array<[string, string]> = [
      ['', 'empty'],
      ['-flag', 'leading dash'],
      [' HEAD', 'leading space'],
      ['HEAD ', 'trailing space'],
      ['HEAD~ ~3', 'internal space'],
      ['HEAD\u0000', 'embedded NUL'],
      ['HEAD\n', 'newline'],
      ['HEAD;rm -rf /', 'shell metachar'],
      ['HEAD$x', 'dollar'],
      ['HEAD`x`', 'backtick'],
      ['@{2.days.ago}', 'reflog syntax (deferred to V7+)'],
      ['HEAD^{tree}', 'peeling (deferred)'],
      [':/regex', 'pathspec magic (deferred)'],
      ['x'.repeat(257), 'too long'],
    ];
    for (const [ref, why] of invalid) {
      it(`"${ref.length > 30 ? '<long>' : ref}" — ${why}`, () => {
        expect(isValidRef(ref)).toBe(false);
      });
    }
  });

  it('rejects non-string input', () => {
    expect(isValidRef(undefined as unknown as string)).toBe(false);
    expect(isValidRef(null as unknown as string)).toBe(false);
    expect(isValidRef(123 as unknown as string)).toBe(false);
  });
});
