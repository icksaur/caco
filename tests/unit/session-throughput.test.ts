import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage,
  recordRateLimit,
  recordWorkflowSavingsV2,
  recordShapingSavings,
  recordToolCall,
  recordToolUse,
  getToolsUsed,
  recordWorkflowCode,
  markRequestComplete,
  resetRequest,
  getThroughput,
  snapshot,
  clearSession,
} from '../../src/session-throughput.js';
import { toolKey } from '../../src/tool-key.js';

const SID = 'test-session-abc';

beforeEach(() => {
  clearSession(SID);
});

describe('recordToolUse / getToolsUsed — per-session used-key set', () => {
  it('records keys and dedupes; unknown session is empty', () => {
    expect(getToolsUsed('nope').size).toBe(0);
    const k1 = toolKey({ origin: 'mcp', serverName: 'github', toolName: 'list_issues' });
    const k2 = toolKey({ origin: 'builtin', name: 'view' });
    recordToolUse(SID, k1);
    recordToolUse(SID, k2);
    recordToolUse(SID, k1); // dupe
    const used = getToolsUsed(SID);
    expect(used.size).toBe(2);
    expect(used.has(k1)).toBe(true);
    expect(used.has(k2)).toBe(true);
  });

  it('clearSession drops the used set (no stale carryover on session end)', () => {
    recordToolUse(SID, toolKey({ origin: 'caco', name: 'caco_docs' }));
    expect(getToolsUsed(SID).size).toBe(1);
    clearSession(SID);
    expect(getToolsUsed(SID).size).toBe(0);
  });
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

  it('captures cacheWriteTokens: request + total accumulate, last = most recent turn', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 1200 });
    recordUsage(SID, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 5 });
    const t = getThroughput(SID)!;
    // cache-bust oracle: a reveal turn shows a cacheWrite spike; steady turns are small.
    expect(t.requestCacheWrite).toBe(1205);
    expect(t.totalCacheWrite).toBe(1205);
    expect(t.lastCacheWriteTokens).toBe(5); // most recent turn only
  });

  it('cacheWriteTokens defaults to 0 when absent (no NaN)', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 10 });
    const t = getThroughput(SID)!;
    expect(t.requestCacheWrite).toBe(0);
    expect(t.lastCacheWriteTokens).toBe(0);
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

describe('recordWorkflowSavingsV2', () => {
  const bd = (fresh: number) => ({
    virtualToolCallsAvoided: 0,
    roundTripsSaved: 0,
    freshInputTokensSaved: fresh,
    cacheReplayTokensSaved: 0,
    netOutputTokensSpent: 0,
  });

  it('accumulates saved tokens and run count across calls', () => {
    recordWorkflowSavingsV2(SID, bd(1200));
    recordWorkflowSavingsV2(SID, bd(800));
    const t = getThroughput(SID)!;
    expect(t.workflowSavedTokens).toBe(2000);
    expect(t.workflowRuns).toBe(2);
  });

  it('counts a run with zero fresh savings but adds no saved tokens', () => {
    recordWorkflowSavingsV2(SID, bd(0));
    const t = getThroughput(SID)!;
    expect(t.workflowSavedTokens).toBe(0);
    expect(t.workflowRuns).toBe(1);
  });

  it('is preserved across resetRequest (session-lifetime, not request-scoped)', () => {
    recordWorkflowSavingsV2(SID, bd(500));
    resetRequest(SID);
    expect(getThroughput(SID)!.workflowSavedTokens).toBe(500);
    expect(getThroughput(SID)!.workflowRuns).toBe(1);
  });

  it('surfaces in snapshot', () => {
    recordWorkflowSavingsV2(SID, bd(333));
    const s = snapshot(SID);
    expect(s.workflowSavedTokens).toBe(333);
    expect(s.workflowRuns).toBe(1);
  });
});

describe('recordShapingSavings', () => {
  it('accumulates saved tokens and shape count across calls', () => {
    recordShapingSavings(SID, 600);
    recordShapingSavings(SID, 400);
    const t = getThroughput(SID)!;
    expect(t.shapingSavedTokens).toBe(1000);
    expect(t.shapingShapeCount).toBe(2);
  });

  it('ignores non-positive / invalid savings without counting a shape', () => {
    recordShapingSavings(SID, 0);
    recordShapingSavings(SID, -50);
    recordShapingSavings(SID, NaN as unknown as number);
    expect(getThroughput(SID)).toBeUndefined();
  });

  it('is preserved across resetRequest (session-lifetime, not request-scoped)', () => {
    recordShapingSavings(SID, 700);
    resetRequest(SID);
    expect(getThroughput(SID)!.shapingSavedTokens).toBe(700);
    expect(getThroughput(SID)!.shapingShapeCount).toBe(1);
  });

  it('accumulates independently of workflow savings', () => {
    recordWorkflowSavingsV2(SID, {
      virtualToolCallsAvoided: 0, roundTripsSaved: 0, freshInputTokensSaved: 100, cacheReplayTokensSaved: 0, netOutputTokensSpent: 0,
    });
    recordShapingSavings(SID, 250);
    const t = getThroughput(SID)!;
    expect(t.workflowSavedTokens).toBe(100);
    expect(t.workflowRuns).toBe(1);
    expect(t.shapingSavedTokens).toBe(250);
    expect(t.shapingShapeCount).toBe(1);
  });

  it('surfaces in snapshot', () => {
    recordShapingSavings(SID, 321);
    const s = snapshot(SID);
    expect(s.shapingSavedTokens).toBe(321);
    expect(s.shapingShapeCount).toBe(1);
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

describe('request round-trip metrics', () => {
  it('counts one turn and accumulates reasoning per usage event', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 50, reasoningTokens: 30 });
    recordUsage(SID, { inputTokens: 80, outputTokens: 40, reasoningTokens: 20 });
    const t = getThroughput(SID)!;
    expect(t.requestTurns).toBe(2);
    expect(t.totalTurns).toBe(2);
    expect(t.requestReasoning).toBe(50);
    expect(t.totalReasoning).toBe(50);
  });

  it('treats missing reasoningTokens as zero but still counts the turn', () => {
    recordUsage(SID, { inputTokens: 100, outputTokens: 50 });
    const t = getThroughput(SID)!;
    expect(t.requestTurns).toBe(1);
    expect(t.requestReasoning).toBe(0);
  });

  it('counts tool calls and failures', () => {
    recordToolCall(SID, false);
    recordToolCall(SID, true);
    recordToolCall(SID, false);
    const t = getThroughput(SID)!;
    expect(t.requestToolCalls).toBe(3);
    expect(t.totalToolCalls).toBe(3);
    expect(t.requestToolFailures).toBe(1);
    expect(t.totalToolFailures).toBe(1);
  });

  it('accumulates workflow code bytes', () => {
    recordWorkflowCode(SID, 400);
    recordWorkflowCode(SID, 600);
    expect(getThroughput(SID)!.requestWorkflowCodeBytes).toBe(1000);
  });

  it('markRequestComplete sets a non-negative wall-clock duration', () => {
    resetRequest(SID);
    recordUsage(SID, { inputTokens: 10, outputTokens: 5 });
    const row = markRequestComplete(SID);
    expect(row).not.toBeNull();
    expect(row!.requestWallMs).toBeGreaterThanOrEqual(0);
    expect(getThroughput(SID)!.requestWallMs).toBe(row!.requestWallMs);
    expect(row!.requestTurns).toBe(1);
  });

  it('markRequestComplete returns null for an unknown session', () => {
    expect(markRequestComplete('no-such')).toBeNull();
  });

  it('resetRequest zeroes request round-trip counters but preserves totals', () => {
    recordUsage(SID, { inputTokens: 10, outputTokens: 5, reasoningTokens: 7 });
    recordToolCall(SID, true);
    recordWorkflowCode(SID, 100);
    resetRequest(SID);
    const t = getThroughput(SID)!;
    expect(t.requestTurns).toBe(0);
    expect(t.requestReasoning).toBe(0);
    expect(t.requestToolCalls).toBe(0);
    expect(t.requestToolFailures).toBe(0);
    expect(t.requestWorkflowCodeBytes).toBe(0);
    // session-lifetime totals survive
    expect(t.totalTurns).toBe(1);
    expect(t.totalReasoning).toBe(7);
    expect(t.totalToolCalls).toBe(1);
    expect(t.totalToolFailures).toBe(1);
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
