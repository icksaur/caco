/**
 * Tests for storage.ts - Persistent output storage and language detection
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { 
  storeOutput, 
  getOutput, 
  detectLanguage,
  registerSession,
  unregisterSession,
  parseOutputMarkers
} from '../../src/storage.js';

// For tests without session registration, outputs go to in-memory fallback
const TEST_CWD = '/test/workspace';

describe('storeOutput and getOutput (in-memory fallback)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stores and retrieves content with metadata', () => {
    const id = storeOutput(TEST_CWD, 'test content', { type: 'file' });
    
    expect(id).toMatch(/^out_\d+_\w+$/);
    const entry = getOutput(id);
    expect(entry?.data.toString()).toBe('test content');
    expect(entry?.metadata.type).toBe('file');
    expect(entry?.metadata.sessionCwd).toBe(TEST_CWD);
    expect(entry?.metadata.createdAt).toBeDefined();
  });

  it('returns null for non-existent IDs', () => {
    expect(getOutput('out_nonexistent_abc123')).toBeNull();
  });

  it('auto-cleans after 30 minute TTL', () => {
    const id = storeOutput(TEST_CWD, 'ephemeral content', { type: 'terminal' });
    expect(getOutput(id)).not.toBeNull();
    
    vi.advanceTimersByTime(31 * 60 * 1000);
    expect(getOutput(id)).toBeNull();
  });
});

describe('registerSession and unregisterSession', () => {
  it('registers and unregisters session mappings', () => {
    const cwd = '/project/test';
    const sessionId = 'session-123';
    
    // Before registration, no sessionId lookup possible (uses fallback)
    // Just verify the functions don't throw
    registerSession(cwd, sessionId);
    unregisterSession(cwd);
  });
});

describe('parseOutputMarkers', () => {
  it('extracts output IDs from text', () => {
    const text = '[output:out_123_abc] Displayed file.\n[output:out_456_def] Command output.';
    const ids = parseOutputMarkers(text);
    expect(ids).toEqual(['out_123_abc', 'out_456_def']);
  });

  it('returns empty array when no markers', () => {
    expect(parseOutputMarkers('No outputs here')).toEqual([]);
  });

  it('handles multiple markers on same line', () => {
    const text = 'Results: [output:a] and [output:b]';
    expect(parseOutputMarkers(text)).toEqual(['a', 'b']);
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
