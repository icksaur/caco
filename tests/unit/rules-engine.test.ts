import { describe, it, expect, beforeEach } from 'vitest';
import { RunawayRulesEngine, DEFAULT_LIMITS, type FlowMetrics } from '../../src/rules-engine.js';

describe('RunawayRulesEngine', () => {
  let engine: RunawayRulesEngine;
  const now = Date.now();

  beforeEach(() => {
    engine = new RunawayRulesEngine();
  });

  describe('depth rule', () => {
    it('allows simple delegation (depth 1)', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2'],
        startTime: now,
        callTimestamps: [now, now + 1000]
      };
      const result = engine.checkCall(metrics, '1', now + 2000);
      expect(result.allowed).toBe(true);
    });

    it('allows oscillation (depth 1)', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2', '1', '2'],
        startTime: now,
        callTimestamps: [now, now + 1000, now + 2000, now + 3000]
      };
      const result = engine.checkCall(metrics, '1', now + 4000);
      expect(result.allowed).toBe(true);
    });

    it('allows chain at max depth (5)', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2', '3', '4'],
        startTime: now,
        callTimestamps: [now, now + 1000, now + 2000, now + 3000]
      };
      const result = engine.checkCall(metrics, '5', now + 4000);
      expect(result.allowed).toBe(true);
    });

    it('rejects chain exceeding max depth', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2', '3', '4', '5'],
        startTime: now,
        callTimestamps: [now, now + 1000, now + 2000, now + 3000, now + 4000]
      };
      const result = engine.checkCall(metrics, '6', now + 5000);
      expect(result.allowed).toBe(false);
      expect(result).toHaveProperty('reason');
      if (!result.allowed) {
        expect(result.reason).toContain('depth');
        expect(result.reason).toContain('6');
      }
    });

    it('handles custom depth limit', () => {
      engine.setLimits({ maxDepth: 3 });
      const metrics: FlowMetrics = {
        chain: ['1', '2', '3'],
        startTime: now,
        callTimestamps: [now, now + 1000, now + 2000]
      };
      const result = engine.checkCall(metrics, '4', now + 3000);
      expect(result.allowed).toBe(false);
    });
  });

  describe('age rule', () => {
    it('allows flow within time limit', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2'],
        startTime: now,
        callTimestamps: [now, now + 60000] // 1 minute
      };
      const result = engine.checkCall(metrics, '3', now + 120000); // 2 minutes total
      expect(result.allowed).toBe(true);
    });

    it('allows flow at exactly max duration', () => {
      const maxDuration = DEFAULT_LIMITS.maxDuration * 1000; // Convert to ms
      const metrics: FlowMetrics = {
        chain: ['1', '2'],
        startTime: now,
        callTimestamps: [now, now + 60000]
      };
      const result = engine.checkCall(metrics, '3', now + maxDuration);
      expect(result.allowed).toBe(true);
    });

    it('rejects flow exceeding max duration', () => {
      const maxDuration = DEFAULT_LIMITS.maxDuration * 1000; // Convert to ms
      const metrics: FlowMetrics = {
        chain: ['1', '2'],
        startTime: now,
        callTimestamps: [now, now + 60000]
      };
      const result = engine.checkCall(metrics, '3', now + maxDuration + 1000);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('timeout');
      }
    });

    it('handles custom duration limit', () => {
      engine.setLimits({ maxDuration: 60 }); // 1 minute
      const metrics: FlowMetrics = {
        chain: ['1', '2'],
        startTime: now,
        callTimestamps: [now, now + 30000]
      };
      const result = engine.checkCall(metrics, '3', now + 61000);
      expect(result.allowed).toBe(false);
    });
  });

  describe('rate rule', () => {
    it('allows calls within rate limit', () => {
      const timestamps = Array.from({ length: 10 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        chain: Array(10).fill('1'),
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, '2', now + 11000);
      expect(result.allowed).toBe(true);
    });

    it('allows exactly max calls per window', () => {
      const timestamps = Array.from({ length: 19 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        chain: Array(19).fill('1'),
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, '2', now + 20000);
      expect(result.allowed).toBe(true);
    });

    it('rejects calls exceeding rate limit', () => {
      const timestamps = Array.from({ length: 20 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        chain: Array(20).fill('1'),
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, '2', now + 21000);
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
        chain: Array(25).fill('1'),
        startTime: now,
        callTimestamps: [...oldTimestamps, ...recentTimestamps]
      };
      const result = engine.checkCall(metrics, '2', now + 180000);
      expect(result.allowed).toBe(true);
    });

    it('handles custom rate limit', () => {
      engine.setLimits({ maxCallsPerWindow: 5, rateWindow: 30 });
      const timestamps = Array.from({ length: 5 }, (_, i) => now + i * 1000);
      const metrics: FlowMetrics = {
        chain: Array(5).fill('1'),
        startTime: now,
        callTimestamps: timestamps
      };
      const result = engine.checkCall(metrics, '2', now + 6000);
      expect(result.allowed).toBe(false);
    });
  });

  describe('combined rules', () => {
    it('rejects if any rule fails (depth)', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2', '3', '4', '5'],
        startTime: now,
        callTimestamps: [now, now + 1000, now + 2000, now + 3000, now + 4000]
      };
      const result = engine.checkCall(metrics, '6', now + 5000);
      expect(result.allowed).toBe(false);
    });

    it('allows if all rules pass', () => {
      const metrics: FlowMetrics = {
        chain: ['1', '2', '1', '2'],
        startTime: now,
        callTimestamps: [now, now + 5000, now + 10000, now + 15000]
      };
      const result = engine.checkCall(metrics, '1', now + 20000);
      expect(result.allowed).toBe(true);
    });
  });

  describe('configuration', () => {
    it('returns current limits', () => {
      const limits = engine.getLimits();
      expect(limits).toEqual(DEFAULT_LIMITS);
    });

    it('updates limits partially', () => {
      engine.setLimits({ maxDepth: 10 });
      const limits = engine.getLimits();
      expect(limits.maxDepth).toBe(10);
      expect(limits.maxDuration).toBe(DEFAULT_LIMITS.maxDuration);
    });

    it('updates multiple limits', () => {
      engine.setLimits({ maxDepth: 10, maxDuration: 600 });
      const limits = engine.getLimits();
      expect(limits.maxDepth).toBe(10);
      expect(limits.maxDuration).toBe(600);
    });
  });
});
