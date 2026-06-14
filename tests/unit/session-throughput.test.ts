import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage,
  recordRateLimit,
  resetRequest,
  getThroughput,
  snapshot,
  clearSession,
} from '../../src/session-throughput.js';

const SID = 'test-session-abc';

beforeEach(() => {
  clearSession(SID);
});

describe('recordUsage', () => {
  it('splits input into fresh (in) and cached, accumulates request + total', () => {
    // inputTokens is the TOTAL prompt; cacheReadTokens is a subset.
    // fresh = input - cacheRead.
    recordUsage(SID, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 });
    recordUsage(SID, { inputTokens: 200, outputTokens: 75, cacheReadTokens: 180 });
    const t = getThroughput(SID)!;
    expect(t.requestIn).toBe(70 + 20);      // (100-30) + (200-180)
    expect(t.requestCache).toBe(30 + 180);
    expect(t.requestOut).toBe(125);
    expect(t.totalIn).toBe(90);
    expect(t.totalCache).toBe(210);
    expect(t.totalOut).toBe(125);
  });

  it('treats all input as fresh when no cacheReadTokens', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 50 });
    const t = getThroughput(SID)!;
    expect(t.requestIn).toBe(100);
    expect(t.requestCache).toBe(0);
  });

  it('clamps fresh to 0 if cacheRead exceeds input', () => {
    recordUsage(SID, { inputTokens: 50, outputTokens: 0, cacheReadTokens: 80 });
    const t = getThroughput(SID)!;
    expect(t.requestIn).toBe(0);     // max(0, 50-80)
    expect(t.requestCache).toBe(80);
  });

  it('coerces missing fields to 0 (no NaN)', () => {
    recordUsage(SID, {});
    const t = getThroughput(SID)!;
    expect(t.requestIn).toBe(0);
    expect(t.requestCache).toBe(0);
    expect(t.requestOut).toBe(0);
    expect(Number.isNaN(t.requestIn)).toBe(false);
  });

  it('coerces non-number / NaN / Infinity / negative to 0', () => {
    recordUsage(SID, {
      inputTokens: 'abc' as unknown as number,
      outputTokens: NaN,
      cacheReadTokens: -5,
    });
    const t = getThroughput(SID)!;
    expect(t.requestIn).toBe(0);
    expect(t.requestCache).toBe(0);
    expect(t.requestOut).toBe(0);
  });

  it('sets updatedAt', () => {
    recordUsage(SID, { inputTokens: 10, outputTokens: 5 });
    expect(getThroughput(SID)!.updatedAt).toBeTruthy();
  });
});

describe('recordRateLimit', () => {
  it('increments rateLimitCount', () => {
    recordRateLimit(SID);
    recordRateLimit(SID);
    expect(getThroughput(SID)!.rateLimitCount).toBe(2);
  });

  it('sets lastRateLimitAt as ISO string', () => {
    recordRateLimit(SID);
    const ts = getThroughput(SID)!.lastRateLimitAt;
    expect(ts).toBeDefined();
    expect(new Date(ts!).getTime()).not.toBeNaN();
  });
});

describe('resetRequest', () => {
  it('zeroes request counters + 429 count but preserves session totals', () => {
    recordUsage(SID, { inputTokens: 500, outputTokens: 200, cacheReadTokens: 100 });
    recordRateLimit(SID);
    resetRequest(SID);
    const t = getThroughput(SID)!;
    expect(t.requestIn).toBe(0);
    expect(t.requestCache).toBe(0);
    expect(t.requestOut).toBe(0);
    expect(t.totalIn).toBe(400);
    expect(t.totalCache).toBe(100);
    expect(t.totalOut).toBe(200);
    expect(t.rateLimitCount).toBe(0);
  });

  it('clears lastRateLimitAt on reset', () => {
    recordRateLimit(SID);
    expect(getThroughput(SID)!.lastRateLimitAt).toBeTruthy();
    resetRequest(SID);
    expect(getThroughput(SID)!.lastRateLimitAt).toBeUndefined();
  });
});

describe('snapshot', () => {
  it('returns known:true with correct values for an existing session', () => {
    recordUsage(SID, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4 });
    const s = snapshot(SID);
    expect(s.known).toBe(true);
    expect(s.totalIn).toBe(6);
    expect(s.totalCache).toBe(4);
    expect(s.totalOut).toBe(5);
  });

  it('returns zeroed default with known:false for unknown session', () => {
    const s = snapshot('no-such-session');
    expect(s.known).toBe(false);
    expect(s.requestIn).toBe(0);
    expect(s.requestCache).toBe(0);
    expect(s.requestOut).toBe(0);
    expect(s.totalIn).toBe(0);
    expect(s.rateLimitCount).toBe(0);
    expect(s.updatedAt).toBeTruthy();
  });

  it('snapshot is a copy — mutations do not affect internal state', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 50 });
    const s = snapshot(SID);
    s.totalIn = 9999;
    expect(getThroughput(SID)!.totalIn).toBe(100);
  });
});

describe('clearSession', () => {
  it('removes the session entry from the map', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 50 });
    clearSession(SID);
    expect(getThroughput(SID)).toBeUndefined();
  });

  it('snapshot returns known:false after clearSession', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 50 });
    clearSession(SID);
    expect(snapshot(SID).known).toBe(false);
  });

  it('is idempotent on unknown session', () => {
    expect(() => clearSession('not-here')).not.toThrow();
  });
});
