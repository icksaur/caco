/**
 * Tests for output-cache.ts - Output storage and language detection
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { storeOutput, getOutput, detectLanguage } from '../../src/output-cache.js';

describe('storeOutput and getOutput', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and retrieves content with metadata', () => {
    const id = storeOutput('test content', { type: 'test' });
    
    expect(id).toMatch(/^out_\d+_\w+$/);
    const entry = getOutput(id);
    expect(entry?.data).toBe('test content');
    expect(entry?.metadata.type).toBe('test');
  });

  it('returns undefined for non-existent IDs', () => {
    expect(getOutput('out_nonexistent_abc123')).toBeUndefined();
  });

  it('auto-cleans after 30 minute TTL', () => {
    const id = storeOutput('ephemeral content');
    expect(getOutput(id)).toBeDefined();
    
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(getOutput(id)).toBeUndefined();
  });
});

describe('detectLanguage', () => {
  it('maps file extensions to language identifiers', () => {
    const cases: [string, string][] = [
      ['app.js', 'javascript'],
      ['app.ts', 'typescript'],
      ['script.py', 'python'],
      ['main.go', 'go'],
      ['script.sh', 'bash'],
      ['data.json', 'json'],
      ['page.html', 'html'],
      ['README.md', 'markdown'],
    ];
    
    for (const [filename, expected] of cases) {
      expect(detectLanguage(filename)).toBe(expected);
    }
  });

  it('returns plaintext for unknown extensions', () => {
    expect(detectLanguage('file.xyz')).toBe('plaintext');
    expect(detectLanguage('README')).toBe('plaintext');
  });

  it('handles paths and is case-insensitive', () => {
    expect(detectLanguage('/src/app.ts')).toBe('typescript');
    expect(detectLanguage('file.PY')).toBe('python');
  });
});
