/**
 * Tests for src/git-edit-poller.ts internals.
 *
 * Covers the pure-function pieces: porcelain parser and diff truncation.
 * End-to-end poll behavior is integration-tested manually against this repo.
 */

import { describe, it, expect } from 'vitest';
import { _internal } from '../../src/git-edit-poller.js';

describe('parsePorcelain', () => {
  function buf(s: string): Buffer { return Buffer.from(s, 'utf-8'); }

  it('returns empty for empty input', () => {
    expect(_internal.parsePorcelain(buf(''))).toEqual(new Map());
  });

  it('parses a single modified file', () => {
    // ' M path\0'
    const result = _internal.parsePorcelain(buf(' M src/foo.ts\0'));
    expect(result.size).toBe(1);
    expect(result.get('src/foo.ts')).toEqual({ status: 'modified', renamedFrom: undefined });
  });

  it('parses untracked files', () => {
    const result = _internal.parsePorcelain(buf('?? newfile.txt\0'));
    expect(result.get('newfile.txt')?.status).toBe('untracked');
  });

  it('parses deleted files', () => {
    const result = _internal.parsePorcelain(buf(' D src/dead.ts\0'));
    expect(result.get('src/dead.ts')?.status).toBe('deleted');
  });

  it('parses renames with the source path on the next NUL field', () => {
    // 'R  new\0old\0'
    const result = _internal.parsePorcelain(buf('R  src/new.ts\0src/old.ts\0'));
    expect(result.size).toBe(1);
    const entry = result.get('src/new.ts');
    expect(entry?.status).toBe('renamed');
    expect(entry?.renamedFrom).toBe('src/old.ts');
  });

  it('parses multiple entries', () => {
    const input = ' M a.ts\0?? b.ts\0 D c.ts\0';
    const result = _internal.parsePorcelain(buf(input));
    expect(result.size).toBe(3);
    expect(result.get('a.ts')?.status).toBe('modified');
    expect(result.get('b.ts')?.status).toBe('untracked');
    expect(result.get('c.ts')?.status).toBe('deleted');
  });

  it('handles renames mixed with other entries', () => {
    const input = ' M before.ts\0R  new.ts\0old.ts\0?? after.ts\0';
    const result = _internal.parsePorcelain(buf(input));
    expect(result.size).toBe(3);
    expect(result.get('before.ts')?.status).toBe('modified');
    expect(result.get('new.ts')?.renamedFrom).toBe('old.ts');
    expect(result.get('after.ts')?.status).toBe('untracked');
  });

  it('parses copies (status.renames=copies) with the same two-field encoding', () => {
    // 'C  new\0old\0'
    const result = _internal.parsePorcelain(buf('C  src/copied.ts\0src/orig.ts\0'));
    expect(result.size).toBe(1);
    const entry = result.get('src/copied.ts');
    expect(entry?.status).toBe('renamed');  // copies bucket under renamed
    expect(entry?.renamedFrom).toBe('src/orig.ts');
  });

  it('handles paths containing spaces', () => {
    const result = _internal.parsePorcelain(buf(' M src/file with space.ts\0'));
    expect(result.get('src/file with space.ts')?.status).toBe('modified');
  });

  it('skips empty trailing fields gracefully', () => {
    const result = _internal.parsePorcelain(buf(' M a.ts\0\0'));
    expect(result.size).toBe(1);
    expect(result.get('a.ts')?.status).toBe('modified');
  });
});

describe('truncateDiff', () => {
  it('returns diff unchanged when under the cap', () => {
    const diff = 'line1\nline2\nline3';
    const result = _internal.truncateDiff(diff);
    expect(result.diff).toBe(diff);
    expect(result.truncated).toBeUndefined();
  });

  it('truncates and reports hidden line count', () => {
    const lines: string[] = [];
    for (let i = 0; i < 1500; i++) lines.push('+ line ' + i);
    const diff = lines.join('\n');
    const result = _internal.truncateDiff(diff);
    expect(result.truncated?.hiddenLines).toBe(500);
    expect(result.diff.split('\n').length).toBe(1001); // 1000 kept + truncation footer
    expect(result.diff).toContain('500 lines hidden');
  });
});

describe('parseHunks', () => {
  it('returns [] for empty diff', () => {
    expect(_internal.parseHunks('')).toEqual([]);
  });

  it('returns [] for a diff with no hunks (binary message only)', () => {
    expect(_internal.parseHunks('Binary files a/x.bin and b/x.bin differ\n')).toEqual([]);
  });

  it('parses a single mixed hunk with explicit lengths', () => {
    const diff = [
      'diff --git a/foo.ts b/foo.ts',
      'index abc..def 100644',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +5,2 @@',
      '-old1',
      '-old2',
      '-old3',
      '+new1',
      '+new2',
    ].join('\n');
    expect(_internal.parseHunks(diff)).toEqual([
      { headStart: 1, headLen: 3, workStart: 5, workLen: 2 },
    ]);
  });

  it('defaults omitted length to 1', () => {
    const diff = '@@ -10 +12 @@\n context';
    expect(_internal.parseHunks(diff)).toEqual([
      { headStart: 10, headLen: 1, workStart: 12, workLen: 1 },
    ]);
  });

  it('parses pure addition (headLen=0) at file start', () => {
    const diff = '@@ -0,0 +1,5 @@\n+new1\n+new2\n+new3\n+new4\n+new5';
    expect(_internal.parseHunks(diff)).toEqual([
      { headStart: 0, headLen: 0, workStart: 1, workLen: 5 },
    ]);
  });

  it('parses pure deletion (workLen=0)', () => {
    const diff = '@@ -1,5 +0,0 @@\n-a\n-b\n-c\n-d\n-e';
    expect(_internal.parseHunks(diff)).toEqual([
      { headStart: 1, headLen: 5, workStart: 0, workLen: 0 },
    ]);
  });

  it('parses multiple hunks in order', () => {
    const diff = [
      '@@ -1,2 +1,3 @@',
      ' ctx',
      '+added',
      ' ctx2',
      '@@ -50,1 +51,1 @@',
      '-old',
      '+new',
      '@@ -100,0 +102,2 @@',
      '+a',
      '+b',
    ].join('\n');
    expect(_internal.parseHunks(diff)).toEqual([
      { headStart: 1,   headLen: 2, workStart: 1,   workLen: 3 },
      { headStart: 50,  headLen: 1, workStart: 51,  workLen: 1 },
      { headStart: 100, headLen: 0, workStart: 102, workLen: 2 },
    ]);
  });

  it('ignores hunk-like text inside diff bodies', () => {
    // A '@@' inside a context line (preceded by a space, not at line start)
    // must not match. The regex is anchored to ^@@ via `m` flag, so a
    // context line like ` @@ inside @@` is ignored.
    const diff = [
      '@@ -1,3 +1,3 @@',
      ' some @@ inline',
      ' another @@',
      '-old',
      '+new',
    ].join('\n');
    expect(_internal.parseHunks(diff)).toEqual([
      { headStart: 1, headLen: 3, workStart: 1, workLen: 3 },
    ]);
  });
});

describe('toLines', () => {
  it('returns [] for empty string', () => {
    expect(_internal.toLines('')).toEqual([]);
  });

  it('handles a single line without trailing newline', () => {
    expect(_internal.toLines('hello')).toEqual(['hello']);
  });

  it('strips the trailing empty entry from a final newline', () => {
    expect(_internal.toLines('a\nb\n')).toEqual(['a', 'b']);
  });

  it('preserves last line when file lacks trailing newline', () => {
    expect(_internal.toLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('preserves intentional blank lines', () => {
    expect(_internal.toLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});
