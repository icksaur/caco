import { describe, it, expect } from 'vitest';
import { estimateWorkflowSavings } from '../../src/workflow/savings-model.js';
import {
  WORKFLOW_AVG_TOOLCALL_TOKENS,
  WORKFLOW_MAX_VIRTUAL_TOOLCALLS_PER_RUN,
} from '../../src/config.js';
import { BYTES_PER_TOKEN } from '../../src/session-throughput.js';

describe('estimateWorkflowSavings — math oracle', () => {
  it('computes all terms for a typical fan-out run', () => {
    // 11 facade calls, 8000 observed bytes, 800 injected, 400 code bytes, 50k window.
    const b = estimateWorkflowSavings({
      observedBytes: 8000,
      injectedBytes: 800,
      commandCount: 11,
      codeBytes: 400,
      windowTokens: 50_000,
    });
    expect(b.virtualToolCallsAvoided).toBe(10);
    expect(b.roundTripsSaved).toBe(10);
    expect(b.freshInputTokensSaved).toBe(Math.round((8000 - 800) / BYTES_PER_TOKEN));
    // Window replay is the full count × the whole window (dominant cache term).
    expect(b.cacheReplayTokensSaved).toBe(10 * 50_000);
    expect(b.netOutputTokensSpent).toBe(Math.round(400 / BYTES_PER_TOKEN) - 10 * WORKFLOW_AVG_TOOLCALL_TOKENS);
  });

  it('round trips saved equals virtual tool calls avoided (full, no parallel discount)', () => {
    const b = estimateWorkflowSavings({ observedBytes: 0, injectedBytes: 0, commandCount: 51, codeBytes: 0, windowTokens: 1000 });
    expect(b.virtualToolCallsAvoided).toBe(50);
    expect(b.roundTripsSaved).toBe(50);
    expect(b.cacheReplayTokensSaved).toBe(50 * 1000);
  });

  it('discounts round trips by batchFactor: B=4, C=49 → ceil(49/4)-1 = 12', () => {
    const b = estimateWorkflowSavings({ observedBytes: 0, injectedBytes: 0, commandCount: 49, codeBytes: 0, windowTokens: 1000, batchFactor: 4 });
    expect(b.virtualToolCallsAvoided).toBe(48);
    expect(b.roundTripsSaved).toBe(12);
    expect(b.cacheReplayTokensSaved).toBe(12 * 1000);
  });

  it('saves 0 trips when the model could batch all calls in one turn (C ≤ B)', () => {
    const b = estimateWorkflowSavings({ observedBytes: 0, injectedBytes: 0, commandCount: 4, codeBytes: 0, windowTokens: 1000, batchFactor: 4 });
    expect(b.roundTripsSaved).toBe(0);
  });

  it('clamps batchFactor < 1 to full credit', () => {
    const b = estimateWorkflowSavings({ observedBytes: 0, injectedBytes: 0, commandCount: 11, codeBytes: 0, windowTokens: 100, batchFactor: 0.3 });
    expect(b.roundTripsSaved).toBe(10);
  });

  it('claims nothing for a 0- or 1-command workflow', () => {
    for (const c of [0, 1]) {
      const b = estimateWorkflowSavings({ observedBytes: 5000, injectedBytes: 100, commandCount: c, codeBytes: 200, windowTokens: 9000 });
      expect(b.virtualToolCallsAvoided).toBe(0);
      expect(b.roundTripsSaved).toBe(0);
      expect(b.cacheReplayTokensSaved).toBe(0);
      // fresh savings and output cost still apply (the output was kept out of context).
      expect(b.freshInputTokensSaved).toBe(Math.round((5000 - 100) / BYTES_PER_TOKEN));
    }
  });

  it('zeroes window replay when the window is unknown (W = 0)', () => {
    const b = estimateWorkflowSavings({ observedBytes: 4000, injectedBytes: 0, commandCount: 5, codeBytes: 0, windowTokens: 0 });
    expect(b.cacheReplayTokensSaved).toBe(0);
    expect(b.roundTripsSaved).toBeGreaterThan(0);
  });

  it('produces a negative net output when the script was cheaper than the calls it replaced', () => {
    // 6 calls -> 5 avoided -> 5*40 = 200 tokens of tool args avoided; tiny script.
    const b = estimateWorkflowSavings({ observedBytes: 0, injectedBytes: 0, commandCount: 6, codeBytes: 40, windowTokens: 0 });
    expect(b.netOutputTokensSpent).toBe(Math.round(40 / BYTES_PER_TOKEN) - 5 * WORKFLOW_AVG_TOOLCALL_TOKENS);
    expect(b.netOutputTokensSpent).toBeLessThan(0);
  });

  it('caps virtual tool calls at the sanity ceiling', () => {
    const b = estimateWorkflowSavings({
      observedBytes: 0,
      injectedBytes: 0,
      commandCount: WORKFLOW_MAX_VIRTUAL_TOOLCALLS_PER_RUN + 500,
      codeBytes: 0,
      windowTokens: 0,
    });
    expect(b.virtualToolCallsAvoided).toBe(WORKFLOW_MAX_VIRTUAL_TOOLCALLS_PER_RUN);
  });

  it('never lets injected exceed observed produce negative fresh savings', () => {
    const b = estimateWorkflowSavings({ observedBytes: 100, injectedBytes: 9000, commandCount: 3, codeBytes: 0, windowTokens: 0 });
    expect(b.freshInputTokensSaved).toBe(0);
  });
});
