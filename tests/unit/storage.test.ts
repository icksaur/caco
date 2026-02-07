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
  parseOutputMarkers,
  ensureSessionMeta,
  getSessionMeta,
  setSessionMeta,
  markSessionObserved,
  markSessionIdle,
  setSessionIntent,
  isSessionUnobserved
} from '../../src/storage.js';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Test session ID for metadata tests (uses real filesystem)
const TEST_SESSION_ID = 'test-session-meta-' + Date.now();
const TEST_META_DIR = join(homedir(), '.caco', 'sessions', TEST_SESSION_ID);

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

describe('session metadata (ensureSessionMeta, getSessionMeta, setSessionMeta)', () => {
  afterEach(() => {
    // Clean up test session directory
    if (existsSync(TEST_META_DIR)) {
      rmSync(TEST_META_DIR, { recursive: true });
    }
  });

  it('ensureSessionMeta creates meta.json with empty name', () => {
    expect(existsSync(TEST_META_DIR)).toBe(false);
    
    ensureSessionMeta(TEST_SESSION_ID);
    
    expect(existsSync(join(TEST_META_DIR, 'meta.json'))).toBe(true);
    const meta = getSessionMeta(TEST_SESSION_ID);
    expect(meta).toEqual({ name: '' });
  });

  it('ensureSessionMeta does not overwrite existing meta.json', () => {
    // Create with custom name first
    setSessionMeta(TEST_SESSION_ID, { name: 'My Custom Name' });
    
    // ensureSessionMeta should not overwrite
    ensureSessionMeta(TEST_SESSION_ID);
    
    const meta = getSessionMeta(TEST_SESSION_ID);
    expect(meta?.name).toBe('My Custom Name');
  });

  it('getSessionMeta returns undefined for non-existent session', () => {
    expect(getSessionMeta('nonexistent-session-id')).toBeUndefined();
  });

  it('setSessionMeta creates directory and writes meta.json', () => {
    expect(existsSync(TEST_META_DIR)).toBe(false);
    
    setSessionMeta(TEST_SESSION_ID, { name: 'Test Session' });
    
    expect(existsSync(TEST_META_DIR)).toBe(true);
    const meta = getSessionMeta(TEST_SESSION_ID);
    expect(meta).toEqual({ name: 'Test Session' });
  });

  it('setSessionMeta overwrites existing name', () => {
    setSessionMeta(TEST_SESSION_ID, { name: 'First' });
    setSessionMeta(TEST_SESSION_ID, { name: 'Second' });
    
    expect(getSessionMeta(TEST_SESSION_ID)?.name).toBe('Second');
  });

  it('setSessionMeta handles empty name', () => {
    setSessionMeta(TEST_SESSION_ID, { name: 'Something' });
    setSessionMeta(TEST_SESSION_ID, { name: '' });
    
    expect(getSessionMeta(TEST_SESSION_ID)?.name).toBe('');
  });
});

describe('session observation tracking (markSessionObserved, markSessionIdle, isSessionUnobserved)', () => {
  const TEST_SESSION_ID = 'test-observe-session';
  const TEST_META_DIR = join(homedir(), '.caco', 'sessions', TEST_SESSION_ID);
  
  beforeEach(() => {
    // Clean up test directory before each test
    if (existsSync(TEST_META_DIR)) {
      rmSync(TEST_META_DIR, { recursive: true, force: true });
    }
  });
  
  afterEach(() => {
    // Clean up after test
    if (existsSync(TEST_META_DIR)) {
      rmSync(TEST_META_DIR, { recursive: true, force: true });
    }
  });
  
  it('new session is not unobserved (never went idle)', () => {
    ensureSessionMeta(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(false);
  });
  
  it('session becomes unobserved after idle', () => {
    ensureSessionMeta(TEST_SESSION_ID);
    markSessionIdle(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(true);
  });
  
  it('session becomes observed after markSessionObserved', () => {
    ensureSessionMeta(TEST_SESSION_ID);
    markSessionIdle(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(true);
    
    markSessionObserved(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(false);
  });
  
  it('session becomes unobserved again after new idle', async () => {
    ensureSessionMeta(TEST_SESSION_ID);
    markSessionIdle(TEST_SESSION_ID);
    markSessionObserved(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(false);
    
    // Wait a tiny bit to ensure timestamp difference
    await new Promise(r => setTimeout(r, 10));
    
    markSessionIdle(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(true);
  });
  
  it('setSessionIntent stores intent', () => {
    ensureSessionMeta(TEST_SESSION_ID);
    setSessionIntent(TEST_SESSION_ID, 'Analyzing code');
    
    const meta = getSessionMeta(TEST_SESSION_ID);
    expect(meta?.currentIntent).toBe('Analyzing code');
  });
  
  it('setSessionIntent preserves other meta fields', () => {
    setSessionMeta(TEST_SESSION_ID, { name: 'My Session' });
    setSessionIntent(TEST_SESSION_ID, 'Working on task');
    
    const meta = getSessionMeta(TEST_SESSION_ID);
    expect(meta?.name).toBe('My Session');
    expect(meta?.currentIntent).toBe('Working on task');
  });
});
