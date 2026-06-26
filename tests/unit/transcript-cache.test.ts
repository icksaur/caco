import { describe, it, expect, beforeEach } from 'vitest';
import {
  versionsEqual,
  getCachedTranscript,
  putCachedTranscript,
  dropCachedTranscript,
  clearTranscriptCache,
} from '../../public/ts/transcript-cache.js';
import type { SessionEvent } from '../../public/ts/types.js';

function ev(id: string): SessionEvent {
  return { type: 'assistant.message', data: { id } } as unknown as SessionEvent;
}
const V = { size: 10, mtimeMs: 5 };

describe('transcript-cache', () => {
  beforeEach(() => clearTranscriptCache());

  describe('versionsEqual', () => {
    it('true for identical size+mtime', () => {
      expect(versionsEqual({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 })).toBe(true);
    });
    it('false when size or mtime differ', () => {
      expect(versionsEqual({ size: 1, mtimeMs: 2 }, { size: 9, mtimeMs: 2 })).toBe(false);
      expect(versionsEqual({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 9 })).toBe(false);
    });
    it('false when either is null/undefined', () => {
      expect(versionsEqual(null, V)).toBe(false);
      expect(versionsEqual(V, undefined)).toBe(false);
    });
  });

  it('stores and retrieves an entry', () => {
    putCachedTranscript('s1', { events: [ev('a')], version: V, connectionId: 1 });
    const e = getCachedTranscript('s1');
    expect(e?.version).toEqual(V);
    expect(e?.events).toEqual([ev('a')]);
  });

  it('drops an entry', () => {
    putCachedTranscript('s1', { events: [], version: V, connectionId: 1 });
    dropCachedTranscript('s1');
    expect(getCachedTranscript('s1')).toBeUndefined();
  });

  it('caps at 3 entries, evicting the least-recently-used', () => {
    putCachedTranscript('s1', { events: [], version: V, connectionId: 1 });
    putCachedTranscript('s2', { events: [], version: V, connectionId: 1 });
    putCachedTranscript('s3', { events: [], version: V, connectionId: 1 });
    // Touch s1 so s2 becomes the LRU.
    getCachedTranscript('s1');
    putCachedTranscript('s4', { events: [], version: V, connectionId: 1 });

    expect(getCachedTranscript('s2')).toBeUndefined(); // evicted
    expect(getCachedTranscript('s1')).toBeDefined();
    expect(getCachedTranscript('s3')).toBeDefined();
    expect(getCachedTranscript('s4')).toBeDefined();
  });
});
