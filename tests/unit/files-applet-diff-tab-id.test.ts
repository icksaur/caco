import { describe, it, expect } from 'vitest';

// V6: collision-safe tab id helper. Inlined from
// applets/files/script.js — keep in sync. See spec §4.3.
function diffTabId(opts: { mode?: string; ref?: string | null; relPath?: string }): string {
  const mode = (opts && opts.mode) || 'unstaged';
  const rel = (opts && opts.relPath) || '';
  if (mode === 'staged') return '\u0000diff-staged\u0000' + rel;
  if (mode === 'range') {
    const ref = (opts && opts.ref) || '';
    return '\u0000diff-range\u0000' + ref.length + '\u0000' + ref + rel;
  }
  return rel;
}

describe('diffTabId', () => {
  it('unstaged returns relPath unchanged (V1 schema)', () => {
    expect(diffTabId({ mode: 'unstaged', relPath: 'README.md' })).toBe('README.md');
    expect(diffTabId({ relPath: 'src/foo.ts' })).toBe('src/foo.ts');
  });

  it('staged prepends NUL-sentinelled prefix', () => {
    expect(diffTabId({ mode: 'staged', relPath: 'README.md' }))
      .toBe('\u0000diff-staged\u0000README.md');
  });

  it('range prepends NUL-sentinelled, length-prefixed form', () => {
    expect(diffTabId({ mode: 'range', ref: 'HEAD~1..HEAD', relPath: 'foo.ts' }))
      .toBe('\u0000diff-range\u000012\u0000HEAD~1..HEADfoo.ts');
  });

  it('cannot collide with a real path containing "diff-staged:"', () => {
    // A real file path can contain "diff-staged:" but cannot
    // contain NUL (API rejects NUL at file-edits.ts:88).
    const realPath = 'diff-staged:README.md';
    const unstagedId = diffTabId({ mode: 'unstaged', relPath: realPath });
    const stagedId = diffTabId({ mode: 'staged', relPath: 'README.md' });
    expect(unstagedId).not.toBe(stagedId);
    expect(unstagedId).toBe('diff-staged:README.md');
    expect(stagedId).toBe('\u0000diff-staged\u0000README.md');
  });

  it('range is unambiguous for (ref, relPath) pairs', () => {
    // Without length-prefix, ref="foo"+relPath="bar" and
    // ref="fooba"+relPath="r" both produce "foobar". The length
    // prefix disambiguates.
    const a = diffTabId({ mode: 'range', ref: 'foo', relPath: 'bar' });
    const b = diffTabId({ mode: 'range', ref: 'fooba', relPath: 'r' });
    expect(a).not.toBe(b);
  });

  it('staged with empty relPath is distinct from unstaged with empty relPath', () => {
    // Edge case: shouldn't matter in practice (API rejects empty
    // relativePath) but the id helper still distinguishes.
    expect(diffTabId({ mode: 'staged', relPath: '' }))
      .not.toBe(diffTabId({ mode: 'unstaged', relPath: '' }));
  });
});
