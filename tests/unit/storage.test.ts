/**
 * Tests for storage.ts - Persistent output storage and language detection
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { 
  storeOutput, 
  getOutput, 
  detectLanguage,
  ensureSessionMeta,
  getSessionMeta,
  setSessionMeta,
  markSessionObserved,
  markSessionIdle,
  setSessionIntent,
  isSessionUnobserved
, updateSessionMeta } from '../../src/storage.js';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Test session ID for metadata tests (uses real filesystem)
const TEST_SESSION_ID = 'test-session-meta-' + Date.now();
const TEST_META_DIR = join(homedir(), '.caco', 'sessions', TEST_SESSION_ID);

// Disk-backed output store: keyed by sessionId, sessionCwd is informational.
const OUT_SESSION_A = 'test-output-session-a-' + Date.now();
const OUT_SESSION_B = 'test-output-session-b-' + Date.now();
const SHARED_CWD = '/test/workspace';
const outDir = (id: string) => join(homedir(), '.caco', 'sessions', id);

describe('storeOutput and getOutput (disk, sessionId-keyed)', () => {
  afterEach(() => {
    for (const id of [OUT_SESSION_A, OUT_SESSION_B]) {
      rmSync(outDir(id), { recursive: true, force: true });
    }
  });

  it('stores and retrieves content with metadata', () => {
    const id = storeOutput(OUT_SESSION_A, SHARED_CWD, 'test content', { type: 'file' });

    expect(id).toMatch(/^out_\d+_\w+$/);
    const entry = getOutput(id);
    expect(entry?.data.toString()).toBe('test content');
    expect(entry?.metadata.type).toBe('file');
    expect(entry?.metadata.sessionId).toBe(OUT_SESSION_A);
    expect(entry?.metadata.sessionCwd).toBe(SHARED_CWD);
    expect(entry?.metadata.createdAt).toBeDefined();
  });

  it('returns null for non-existent IDs', () => {
    expect(getOutput('out_nonexistent_abc123')).toBeNull();
  });

  it('survives memory-cache TTL via disk persistence', () => {
    vi.useFakeTimers();
    try {
      const id = storeOutput(OUT_SESSION_A, SHARED_CWD, 'durable content', { type: 'terminal' });
      expect(getOutput(id)).not.toBeNull();
      vi.advanceTimersByTime(31 * 60 * 1000);
      // Cache entry expired, but disk copy remains retrievable.
      expect(getOutput(id)?.data.toString()).toBe('durable content');
    } finally {
      vi.useRealTimers();
    }
  });

  it('two sessions in the same cwd store independently (no sibling overwrite)', () => {
    const idA = storeOutput(OUT_SESSION_A, SHARED_CWD, 'output A', { type: 'raw' });
    const idB = storeOutput(OUT_SESSION_B, SHARED_CWD, 'output B', { type: 'raw' });

    expect(getOutput(idA)?.data.toString()).toBe('output A');
    expect(getOutput(idB)?.data.toString()).toBe('output B');
    expect(getOutput(idA)?.metadata.sessionId).toBe(OUT_SESSION_A);
    expect(getOutput(idB)?.metadata.sessionId).toBe(OUT_SESSION_B);
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
    expect(meta).toMatchObject({ name: '', kind: 'interactive' });
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
    expect(meta).toMatchObject({ name: 'Test Session', kind: 'interactive' });
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

  it('persists an orchestratedBy herd bond that survives a fresh read (restart-equivalent)', () => {
    // spec-session-orchestration A1: the herd bond is the only durable herd state;
    // it must round-trip through disk so a parent is re-derivable after restart.
    setSessionMeta(TEST_SESSION_ID, { name: 'child', orchestratedBy: 'parent-abcdef' });
    expect(getSessionMeta(TEST_SESSION_ID)?.orchestratedBy).toBe('parent-abcdef');
  });

  it('clears orchestratedBy on disown (round-trips to undefined)', () => {
    setSessionMeta(TEST_SESSION_ID, { name: 'child', orchestratedBy: 'parent-abcdef' });
    const meta = getSessionMeta(TEST_SESSION_ID) ?? { name: '' };
    setSessionMeta(TEST_SESSION_ID, { ...meta, orchestratedBy: undefined });
    expect(getSessionMeta(TEST_SESSION_ID)?.orchestratedBy).toBeUndefined();
  });

  it('persists a cwd override that survives a fresh read (restart-equivalent)', () => {
    // Regression: /session-cwd changes were lost on restart because the cwd
    // override was never persisted to meta. _discoverSessions now prefers
    // meta.cwd over the immutable session.start cwd.
    setSessionMeta(TEST_SESSION_ID, { name: 'S', cwd: '/home/user/repo/hull' });
    // A fresh getSessionMeta reads from disk, simulating post-restart rebuild.
    expect(getSessionMeta(TEST_SESSION_ID)?.cwd).toBe('/home/user/repo/hull');
  });

  it('cwd override is preserved when other fields are updated', () => {
    setSessionMeta(TEST_SESSION_ID, { name: 'S', cwd: '/home/user/repo/hull' });
    const meta = getSessionMeta(TEST_SESSION_ID) ?? { name: '' };
    setSessionMeta(TEST_SESSION_ID, { ...meta, model: 'claude-opus-4.8' });
    const after = getSessionMeta(TEST_SESSION_ID);
    expect(after?.cwd).toBe('/home/user/repo/hull');
    expect(after?.model).toBe('claude-opus-4.8');
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
  
  it('a bare idle stamp does NOT arm the badge', () => {
    // markSessionIdle is the COLDNESS signal (archive reaper, rotation), not the
    // observation verdict. It runs for every real idle including agent-requested
    // ones, so letting it arm the badge is precisely what made delegate targets
    // light up in a batch (spec-observation-authority).
    ensureSessionMeta(TEST_SESSION_ID);
    markSessionIdle(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(false);
  });

  it('reads back the verdict the tracker persisted', () => {
    ensureSessionMeta(TEST_SESSION_ID);
    updateSessionMeta(TEST_SESSION_ID, m => { m.unobserved = true; });
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(true);

    markSessionObserved(TEST_SESSION_ID);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(false);
  });

  it('falls back to timestamps for metadata written before the verdict existed', () => {
    // Legacy meta: no `unobserved` field at all.
    setSessionMeta(TEST_SESSION_ID, {
      name: '', lastIdleAt: '2026-02-06T12:00:01Z', lastObservedAt: '2026-02-06T12:00:00Z',
    } as never);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(true);

    setSessionMeta(TEST_SESSION_ID, {
      name: '', lastIdleAt: '2026-02-06T12:00:00Z', lastObservedAt: '2026-02-06T12:00:01Z',
    } as never);
    expect(isSessionUnobserved(TEST_SESSION_ID)).toBe(false);
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
