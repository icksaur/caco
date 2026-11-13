import { describe, it, expect, vi } from 'vitest';
import {
  isTransientTurnError, transientRetryDelayMs, isModelOutputEvent,
  scheduleTransientRetry, cancelTransientRetry, hasPendingTransientRetry,
} from '../../src/transient-retry.js';

describe('transient retry policy (spec-transient-retry)', () => {
  it('classifies network failures as transient', () => {
    expect(isTransientTurnError("Execution failed: Unable to discover model capabilities for 'm'. Check authentication and connectivity, then retry: GenericFailure, {\"kind\":\"network\",\"message\":\"Model catalog request timed out\"}")).toBe(true);
    for (const m of ['fetch failed', 'read ECONNRESET', 'getaddrinfo ENOTFOUND api', 'HTTP 503', 'request timeout']) {
      expect(isTransientTurnError(m)).toBe(true);
    }
    for (const m of ['Model refused the request', 'Session expired', '', undefined, 42]) {
      expect(isTransientTurnError(m)).toBe(false);
    }
  });

  it('backs off progressively with +/-20% jitter', () => {
    expect([1, 2, 3, 4, 5, 6].map(a => transientRetryDelayMs(a, () => 0.5))).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(transientRetryDelayMs(1, () => 0)).toBe(12_000);
    expect(transientRetryDelayMs(1, () => 1)).toBe(18_000);
  });

  it('counts only real model output as output', () => {
    for (const t of ['assistant.message', 'assistant.message_delta', 'tool.execution_start']) expect(isModelOutputEvent(t)).toBe(true);
    for (const t of ['assistant.turn_start', 'assistant.turn_end', 'assistant.usage', 'session.error', 'user.message']) expect(isModelOutputEvent(t)).toBe(false);
  });

  it('keeps one pending retry per session and cancels it', () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      scheduleTransientRetry('s', 1000, run);
      scheduleTransientRetry('s', 1000, run);
      expect(hasPendingTransientRetry('s')).toBe(true);
      expect(cancelTransientRetry('s')).toBe(true);
      expect(cancelTransientRetry('s')).toBe(false);
      vi.advanceTimersByTime(2000);
      expect(run).not.toHaveBeenCalled();
      scheduleTransientRetry('s', 1000, run);
      vi.advanceTimersByTime(1000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(hasPendingTransientRetry('s')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
