import { describe, it, expect, beforeEach } from 'vitest';
import { RunawayRulesEngine, DEFAULT_LIMITS, type FlowMetrics } from '../../src/rules-engine.js';

describe('RunawayRulesEngine', () => {
  let engine: RunawayRulesEngine;
  const now = Date.now();

  beforeEach(() => {
    engine = new RunawayRulesEngine();
  });

  describe('age rule', () => {
    it('allows flow within time limit', () => {
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: [now, now + 60000] // 1 minute
      };
      const result = engine.checkCall(metrics, now + 120000); // 2 minutes total
      expect(result.allowed).toBe(true);
    });

    it('allows flow at exactly max duration', () => {
      const maxDuration = DEFAULT_LIMITS.maxDuration * 1000; // Convert to ms
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: [now, now + 60000]
      };
      const result = engine.checkCall(metrics, now + maxDuration);
      expect(result.allowed).toBe(true);
    });

    it('rejects flow exceeding max duration', () => {
      const maxDuration = DEFAULT_LIMITS.maxDuration * 1000; // Convert to ms
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: [now, now + 60000]
      };
      const result = engine.checkCall(metrics, now + maxDuration + 1000);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('timeout');
      }
    });

    it('handles custom duration limit', () => {
      engine.setLimits({ maxDuration: 60 }); // 1 minute
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: [now, now + 30000]
      };
      const result = engine.checkCall(metrics, now + 61000);
      expect(result.allowed).toBe(false);
    });
  });

  describe('rate rule', () => {
    it('allows calls within rate limit', () => {
      const timestamps = Array.from({ length: 10 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, now + 11000);
      expect(result.allowed).toBe(true);
    });

    it('allows exactly max calls per window', () => {
      const timestamps = Array.from({ length: 19 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, now + 20000);
      expect(result.allowed).toBe(true);
    });

    it('rejects calls exceeding rate limit', () => {
      const timestamps = Array.from({ length: 20 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, now + 21000);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('rate');
      }
    });

    it('only counts calls within time window', () => {
      // 25 calls total, but only 15 in last minute
      const oldTimestamps = Array.from({ length: 10 }, (_, i) => now + i * 1000);
      const recentTimestamps = Array.from({ length: 15 }, (_, i) => now + 120000 + i * 1000);
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: [...oldTimestamps, ...recentTimestamps]
      };
      const result = engine.checkCall(metrics, now + 180000);
      expect(result.allowed).toBe(true);
    });

    it('handles custom rate limit', () => {
      engine.setLimits({ maxCallsPerWindow: 5, rateWindow: 30 });
      const timestamps = Array.from({ length: 5 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, now + 6000);
      expect(result.allowed).toBe(false);
    });
  });

  describe('configuration', () => {
    it('returns current limits', () => {
      const limits = engine.getLimits();
      expect(limits).toEqual(DEFAULT_LIMITS);
    });

    it('updates limits partially', () => {
      engine.setLimits({ maxCallsPerWindow: 10 });
      const limits = engine.getLimits();
      expect(limits.maxCallsPerWindow).toBe(10);
      expect(limits.maxDuration).toBe(DEFAULT_LIMITS.maxDuration);
    });

    it('updates multiple limits', () => {
      engine.setLimits({ maxCallsPerWindow: 10, maxDuration: 600 });
      const limits = engine.getLimits();
      expect(limits.maxCallsPerWindow).toBe(10);
      expect(limits.maxDuration).toBe(600);
    });
  });
});
