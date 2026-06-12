import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { lineDiff, parseEditResult } from '../../public/ts/edit-diff.js';
import type { EditDiff } from '../../public/ts/edit-diff.js';

function fixture(name: string): Record<string, unknown> {
  const p = join(__dirname, '../fixtures/edit-tool-results', name);
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
}

// ── lineDiff ────────────────────────────────────────────────────

describe('lineDiff', () => {
  it('empty before → all adds', () => {
    const hunks = lineDiff('', 'a\nb\nc');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].added).toEqual(['a', 'b', 'c']);
    expect(hunks[0].removed).toEqual([]);
  });

  it('empty after → all removes', () => {
    const hunks = lineDiff('a\nb', '');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removed).toEqual(['a', 'b']);
    expect(hunks[0].added).toEqual([]);
  });

  it('equal before and after → empty hunks', () => {
    const hunks = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(hunks).toHaveLength(0);
  });

  it('single-line change in middle → one hunk', () => {
    const hunks = lineDiff('a\nold\nc', 'a\nnew\nc');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].removed).toEqual(['old']);
    expect(hunks[0].added).toEqual(['new']);
  });

  it('multiple separated changes → multiple hunks', () => {
    const hunks = lineDiff('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE');
    expect(hunks).toHaveLength(2);
    expect(hunks[0].removed).toEqual(['a']);
    expect(hunks[0].added).toEqual(['A']);
    expect(hunks[1].removed).toEqual(['e']);
    expect(hunks[1].added).toEqual(['E']);
  });

  it('adds at end only', () => {
    const hunks = lineDiff('a', 'a\nb\nc');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].added).toEqual(['b', 'c']);
    expect(hunks[0].removed).toEqual([]);
  });
});

// ── parseEditResult ─────────────────────────────────────────────

describe('parseEditResult', () => {
  it('returns null for status-only result.content', () => {
    expect(parseEditResult({ result: { content: 'Updated 1 file' } })).toBeNull();
  });

  it('returns null for missing arguments and no diff content', () => {
    expect(parseEditResult({ result: { content: 'File written successfully' } })).toBeNull();
  });

  it('returns null for completely opaque data', () => {
    expect(parseEditResult({ toolName: 'edit', success: true, result: { content: 'ok' } })).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseEditResult({})).toBeNull();
  });

  it('returns null on mangled data (non-string content)', () => {
    expect(parseEditResult({ result: { content: 42 } })).toBeNull();
    expect(parseEditResult({ arguments: { old_string: 123 } })).toBeNull();
  });

  describe('old_string + new_string shape', () => {
    it('parses edit-old-new fixture', () => {
      const data = fixture('edit-old-new.json');
      const diff = parseEditResult(data);
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBeGreaterThan(0);
      expect(d.stats.removed).toBeGreaterThan(0);
      expect(d.hunks.length).toBeGreaterThan(0);
    });

    it('counts correctly for single-line change', () => {
      const diff = parseEditResult({
        arguments: { old_string: 'line1\nold\nline3', new_string: 'line1\nnew1\nnew2\nline3' }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.removed).toBe(1);
      expect(d.stats.added).toBe(2);
    });
  });

  describe('path + content shape (create/write)', () => {
    it('parses create-with-content fixture as all-add diff', () => {
      const data = fixture('create-with-content.json');
      const diff = parseEditResult(data);
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.removed).toBe(0);
      expect(d.stats.added).toBeGreaterThan(0);
      expect(d.hunks[0].removed).toEqual([]);
    });

    it('parses write-with-content fixture as all-add diff', () => {
      const data = fixture('write-with-content.json');
      const diff = parseEditResult(data);
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.removed).toBe(0);
      expect(d.stats.added).toBeGreaterThan(0);
    });

    it('3-line content → added=3, removed=0', () => {
      const diff = parseEditResult({
        arguments: { path: 'file.ts', content: 'a\nb\nc' }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(3);
      expect(d.stats.removed).toBe(0);
    });
  });

  describe('unified diff shape', () => {
    it('parses edit-unified-diff fixture', () => {
      const data = fixture('edit-unified-diff.json');
      const diff = parseEditResult(data);
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(2);
      expect(d.stats.removed).toBe(1);
    });

    it('drops context lines (lines with space prefix)', () => {
      const diff = parseEditResult({
        result: {
          content: '--- a/file\n+++ b/file\n@@ -1,3 +1,3 @@\n context\n-old\n+new\n context2'
        }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(1);
      expect(d.stats.removed).toBe(1);
      expect(d.hunks[0].added).toEqual(['new']);
      expect(d.hunks[0].removed).toEqual(['old']);
    });

    it('does not count +++ and --- lines in stats', () => {
      const diff = parseEditResult({
        result: {
          content: '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-rem\n+add'
        }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(1);
      expect(d.stats.removed).toBe(1);
    });

    it('multi-hunk: stats are totals', () => {
      const diff = parseEditResult({
        result: {
          content: '@@ -1,2 +1,2 @@\n-a\n+A\n@@ -5,2 +5,2 @@\n-b\n-c\n+B'
        }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.removed).toBe(3);
      expect(d.stats.added).toBe(2);
    });
  });

  describe('real Copilot SDK shape (detailedContent + telemetry)', () => {
    it('parses real edit fixture from result.detailedContent', () => {
      const data = fixture('real-edit-opus.json');
      const diff = parseEditResult(data);
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(1);
      expect(d.stats.removed).toBe(1);
      expect(d.hunks[0].added).toEqual(['A dangerous solution to any problem at all.']);
      expect(d.hunks[0].removed).toEqual(['A dangerous solution to almost any problem.']);
    });

    it('parses real create fixture as all-add', () => {
      const data = fixture('real-create-opus.json');
      const diff = parseEditResult(data);
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(10);
      expect(d.stats.removed).toBe(0);
      expect(d.hunks[0].added[0]).toBe('# Scratch fixture test');
    });

    it('prefers telemetry metrics for stats over diff-line count', () => {
      const diff = parseEditResult({
        result: {
          content: 'updated',
          detailedContent: '@@ -1,2 +1,2 @@\n context\n-old\n+new\n more context'
        },
        toolTelemetry: { metrics: { linesAdded: 1, linesRemoved: 1 } }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(1);
      expect(d.stats.removed).toBe(1);
    });

    it('falls back to diff-line count when telemetry metrics absent', () => {
      const diff = parseEditResult({
        result: { detailedContent: '@@ -1,1 +1,2 @@\n-old\n+new1\n+new2' }
      });
      expect(diff).not.toBeNull();
      const d = diff as EditDiff;
      expect(d.stats.added).toBe(2);
      expect(d.stats.removed).toBe(1);
    });

    it('status-only result.content with no detailedContent returns null', () => {
      const diff = parseEditResult({
        result: { content: 'File updated successfully.' }
      });
      expect(diff).toBeNull();
    });
  });

  describe('failed event fixture', () => {
    it('edit-failed fixture has success:false (parser is not called for failures)', () => {
      const data = fixture('edit-failed.json');
      expect(data.success).toBe(false);
      expect(typeof data.error).toBe('string');
    });
  });

  describe('unparseable fixture', () => {
    it('unparseable fixture returns null', () => {
      const data = fixture('unparseable.json');
      expect(parseEditResult(data)).toBeNull();
    });
  });
});
