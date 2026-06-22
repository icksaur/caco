import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordUsage,
  recordWorkflowSavingsV2,
  currentWindowTokens,
  markRequestComplete,
  resetRequest,
  snapshot,
  clearSession,
} from '../../src/session-throughput.js';

const SID = 'savings-throughput-test';

function run(fresh: number) {
  recordWorkflowSavingsV2(SID, {
    virtualToolCallsAvoided: 4,
    roundTripsSaved: 2,
    freshInputTokensSaved: fresh,
    cacheReplayTokensSaved: 100,
    netOutputTokensSpent: 10,
  });
}

function usage(input = 1000) {
  recordUsage(SID, { inputTokens: input, outputTokens: 50, cacheReadTokens: input - 100 });
}

function coldUsage(input = 1000) {
  recordUsage(SID, { inputTokens: input, outputTokens: 50, cacheReadTokens: 0 });
}

beforeEach(() => clearSession(SID));

describe('workflow compounding — deferred one turn (no double-count)', () => {
  it('does not compound on the first later turn, then accrues linearly', () => {
    run(500);
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(0);

    usage(); // first later round trip — promotes pending, compounds 0
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(0);

    usage(); // second — now 500 compounds
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(500);

    usage(); // third — +500
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(1000);
  });

  it('after N later usages compound equals (N-1) * freshSaved', () => {
    run(300);
    for (let i = 0; i < 5; i++) usage();
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(4 * 300);
  });

  it('does not accrue compounding on a cold-cache turn, but the deferral still advances', () => {
    run(500);
    coldUsage();  // first downstream turn, cold: no increment (avoided still 0), promotes pending
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(0);
    coldUsage();  // second turn, cold: avoided=500 but cache=0 → still no accrual
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(0);
    usage();      // third turn, warm: now 500 compounds
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(500);
  });

  it('a cold first turn does not lose the deferral — compounding starts on the first warm turn after', () => {
    run(200);
    coldUsage();  // deferral turn (cold) — promotes pending→avoided
    usage();      // first warm turn after deferral → 200 compounds
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(200);
  });
});

describe('workflow savings — accumulation and back-compat', () => {
  it('keeps workflowSavedTokens = cumulative freshInputTokensSaved', () => {
    run(200);
    run(300);
    const s = snapshot(SID);
    expect(s.workflowSavedTokens).toBe(500);
    expect(s.workflowRuns).toBe(2);
    expect(s.workflowVirtualCallsAvoided).toBe(8);
    expect(s.workflowRoundTripsSaved).toBe(4);
    expect(s.workflowCacheReplaySaved).toBe(200);
    expect(s.workflowOutputDelta).toBe(20);
  });
});

describe('window proxy W', () => {
  it('is 0 before any round trip and tracks the latest prompt after', () => {
    expect(currentWindowTokens(SID)).toBe(0);
    usage(12_345);
    expect(currentWindowTokens(SID)).toBe(12_345);
  });

  it('is cleared on a fresh send (resetRequest), not priced against the prior request', () => {
    usage(9000);
    expect(currentWindowTokens(SID)).toBe(9000);
    resetRequest(SID);
    expect(currentWindowTokens(SID)).toBe(0);
  });

  it('drops an un-promoted pending bucket on a fresh send', () => {
    run(400); // pending = 400, never promoted
    resetRequest(SID);
    usage();
    usage();
    expect(snapshot(SID).workflowCacheCompoundSaved).toBe(0);
  });
});

describe('time saved inputs', () => {
  it('accumulates totalWallMs across completed requests', () => {
    resetRequest(SID);
    usage();
    markRequestComplete(SID);
    const s = snapshot(SID);
    expect(s.totalWallMs).toBeGreaterThanOrEqual(0);
    expect(s.totalTurns).toBe(1);
  });
});
