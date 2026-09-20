/**
 * intent-runtime + setSessionIntent write-frequency oracles (spec-intent-in-memory).
 *
 * The whole point of moving currentIntent/intentHistory off disk is that a
 * chatty session no longer writes meta.json on every emit. These tests pin the
 * two properties that make the refactor worthwhile:
 *   1. Runtime state is what the read paths see (not meta.json).
 *   2. After the first-intent autoName latch has fired, further setSessionIntent
 *      calls perform ZERO disk writes.
 *
 * Legacy meta.json files that carry `currentIntent`/`intentHistory` (i.e.,
 * sessions created before this refactor, or restored from an archive) are
 * seeded into the runtime map on first read so the sidebar sub-line still
 * shows a value until the session emits again.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testStorageRoot = mkdtempSync(join(tmpdir(), 'caco-intent-runtime-'));
process.env.CACO_HOME = testStorageRoot;

const { setSessionIntent } = await import('../../src/session-meta-store.js');
const {
  getCurrentIntent, getIntentHistory, forgetIntent, _resetIntentRuntimeForTests,
} = await import('../../src/intent-runtime.js');

const SESSION_DIR = join(testStorageRoot, 'sessions');

function makeSession(id: string, extra: Record<string, unknown> = {}): void {
  const dir = join(SESSION_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ name: '', ...extra }, null, 2));
}

function metaMtimeMs(id: string): number {
  return statSync(join(SESSION_DIR, id, 'meta.json')).mtimeMs;
}

beforeEach(() => {
  try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* first run */ }
  mkdirSync(SESSION_DIR, { recursive: true });
  _resetIntentRuntimeForTests();
});

afterEach(() => {
  try { rmSync(SESSION_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('intent-runtime — read path (spec-intent-in-memory)', () => {
  it('returns undefined for a fresh session', () => {
    makeSession('s1');
    expect(getCurrentIntent('s1')).toBeUndefined();
    expect(getIntentHistory('s1')).toEqual([]);
  });

  it('records intent via setSessionIntent and surfaces it in the runtime map', () => {
    makeSession('s1');
    setSessionIntent('s1', 'first thing');
    setSessionIntent('s1', 'second thing');

    expect(getCurrentIntent('s1')).toBe('second thing');
    expect(getIntentHistory('s1').map(h => h.text)).toEqual(['first thing', 'second thing']);
  });

  it('is bounded at INTENT_HISTORY_LIMIT (5) via front-eviction', () => {
    makeSession('s1');
    for (let i = 1; i <= 7; i++) setSessionIntent('s1', `intent-${i}`);

    const history = getIntentHistory('s1');
    expect(history).toHaveLength(5);
    // Oldest evicted from the front; last written is at the tail.
    expect(history.map(h => h.text)).toEqual(['intent-3', 'intent-4', 'intent-5', 'intent-6', 'intent-7']);
    expect(getCurrentIntent('s1')).toBe('intent-7');
  });

  it('forgetIntent drops state on session removal', () => {
    makeSession('s1');
    setSessionIntent('s1', 'work');
    expect(getCurrentIntent('s1')).toBe('work');

    forgetIntent('s1');
    // State is truly discarded; a fresh read (no seed hint) returns undefined.
    expect(getCurrentIntent('s1')).toBeUndefined();
  });
});

describe('intent-runtime — legacy seed (backward compat)', () => {
  it('lazily seeds currentIntent from a caller-supplied meta hint when the runtime map is empty', () => {
    // Pretend this is a session written before the refactor: meta carries
    // the runtime fields on disk. Callers pass meta as a seed hint on read.
    const meta = {
      currentIntent: 'planning the API',
      intentHistory: [{ text: 'planning the API', ts: 1_700_000_000_000 }],
    };

    // No setSessionIntent yet; a bare read WITH hint must see the persisted
    // value so the sidebar sub-line doesn't blank out for pre-refactor sessions.
    expect(getCurrentIntent('s1', meta)).toBe('planning the API');
    expect(getIntentHistory('s1', meta).map(h => h.text)).toEqual(['planning the API']);
  });

  it('does not write the seeded values back to meta.json (seed is one-way)', () => {
    makeSession('s1', {
      currentIntent: 'legacy intent',
      intentHistory: [{ text: 'legacy intent', ts: 1_700_000_000_000 }],
    });
    const originalMeta = readFileSync(join(SESSION_DIR, 's1', 'meta.json'), 'utf-8');

    // Reads should not mutate on-disk state (byte-for-byte identity check).
    getCurrentIntent('s1', { currentIntent: 'legacy intent', intentHistory: [{ text: 'legacy intent', ts: 1_700_000_000_000 }] });
    getIntentHistory('s1');

    const afterMeta = readFileSync(join(SESSION_DIR, 's1', 'meta.json'), 'utf-8');
    expect(afterMeta).toBe(originalMeta);
  });
});

describe('setSessionIntent — write-frequency (the cost-saving property)', () => {
  it('writes meta.json ONCE across a chain of intents on a fresh session', async () => {
    makeSession('s1');
    // First valid intent: expected to write meta (autoName latch).
    setSessionIntent('s1', 'first');
    const afterFirst = metaMtimeMs('s1');
    // Sleep briefly so any subsequent write would be observably different.
    await new Promise(resolve => setTimeout(resolve, 30));

    // Subsequent intents: pure in-memory. If setSessionIntent regresses to
    // updateSessionMeta on every call, mtime would advance and this fails.
    setSessionIntent('s1', 'second');
    setSessionIntent('s1', 'third');
    setSessionIntent('s1', 'fourth');

    const afterMany = metaMtimeMs('s1');
    expect(afterMany).toBe(afterFirst);
    // But the runtime map still reflects every call.
    expect(getCurrentIntent('s1')).toBe('fourth');
    expect(getIntentHistory('s1').map(h => h.text)).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('writes meta.json ZERO times when autoName is already latched at process start', async () => {
    // Simulates the common case: session already exists on disk with autoName
    // set (from a previous process). No writes at all should happen.
    makeSession('s1', { autoName: 'already latched' });
    const start = metaMtimeMs('s1');
    await new Promise(resolve => setTimeout(resolve, 30));

    setSessionIntent('s1', 'one');
    setSessionIntent('s1', 'two');
    setSessionIntent('s1', 'three');

    expect(metaMtimeMs('s1')).toBe(start);
    expect(getCurrentIntent('s1')).toBe('three');
  });

  it('does NOT persist currentIntent/intentHistory even on the latch write', () => {
    makeSession('s1');
    setSessionIntent('s1', 'plan the migration');

    const meta = JSON.parse(readFileSync(join(SESSION_DIR, 's1', 'meta.json'), 'utf-8'));
    // Latch DID write autoName — that field is the persistent title fallback.
    expect(meta.autoName).toBe('plan the migration');
    // But currentIntent/intentHistory stay OUT of the on-disk file, even in
    // the same write that landed autoName. Their runtime home is the map.
    expect(meta.currentIntent).toBeUndefined();
    expect(meta.intentHistory).toBeUndefined();
  });

  it('skips the disk touch entirely on empty/whitespace intents', async () => {
    makeSession('s1');
    const start = metaMtimeMs('s1');
    await new Promise(resolve => setTimeout(resolve, 30));

    setSessionIntent('s1', '');
    setSessionIntent('s1', '   \t\n');

    // No latch, no runtime write worth persisting, no disk touch.
    expect(metaMtimeMs('s1')).toBe(start);
    // But empty strings DO enter the runtime history (matches the pre-refactor
    // shape — the ceiling is 5 entries regardless of content quality).
    expect(getIntentHistory('s1')).toHaveLength(2);
  });
});

