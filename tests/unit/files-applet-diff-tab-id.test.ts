import { describe, it, expect } from 'vitest';

// V6: collision-safe tab id helper. Inlined from
// applets/files/script.js — keep in sync. See spec §4.3.
// V6.1: simplified — only unstaged + staged.
function diffTabId(opts: { mode?: string; relPath?: string }): string {
  const mode = (opts && opts.mode) || 'unstaged';
  const rel = (opts && opts.relPath) || '';
  if (mode === 'staged') return '\u0000diff-staged\u0000' + rel;
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

  it('staged with empty relPath is distinct from unstaged with empty relPath', () => {
    expect(diffTabId({ mode: 'staged', relPath: '' }))
      .not.toBe(diffTabId({ mode: 'unstaged', relPath: '' }));
  });
});
