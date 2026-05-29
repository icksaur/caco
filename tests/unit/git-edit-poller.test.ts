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
