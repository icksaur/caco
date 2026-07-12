/**
 * Tests for correlation-metrics.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CorrelationMetrics, type CorrelationRules } from '../../src/correlation-metrics.js';

describe('CorrelationMetrics', () => {
  let metrics: CorrelationMetrics;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('with default rules', () => {
    beforeEach(() => {
      metrics = new CorrelationMetrics('test-correlation');
    });

    it('allows first call', () => {
      const result = metrics.isAllowed('session-1');
      expect(result.allowed).toBe(true);
    });

    it('allows many calls to distinct targets (depth is no longer a chain rule)', () => {
      // Fan-out that would have tripped the old collapseChain depth rule now stays
      // allowed here — depth is enforced at the route as a per-dispatch hop-count.
      metrics.recordCall('session-1');
      metrics.recordCall('session-2');
      metrics.recordCall('session-3');
      expect(metrics.isAllowed('session-4').allowed).toBe(true);
    });

    it('tracks call count', () => {
      metrics.recordCall('session-1');
      metrics.recordCall('session-2');
      
      const metricsData = metrics.getMetrics();
      expect(metricsData.chainLength).toBe(2);
    });
  });

  describe('rate limiting', () => {
    it('enforces rate limit', () => {
      const strictRules: CorrelationRules = {
        maxAgeSeconds: 3600,
        rateLimit: { maxCalls: 3, windowSeconds: 60 }
      };
      metrics = new CorrelationMetrics('test', strictRules);
      
      // Record 3 calls (at the limit)
      metrics.recordCall('session-1');
      metrics.recordCall('session-2');
      metrics.recordCall('session-3');
      
      // Next call should be rejected
      const result = metrics.isAllowed('session-4');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason.toLowerCase()).toContain('rate limit');
      }
    });

    it('slides the window on real recorded timestamps', () => {
      const strictRules: CorrelationRules = {
        maxAgeSeconds: 3600,
        rateLimit: { maxCalls: 2, windowSeconds: 60 }
      };
      metrics = new CorrelationMetrics('test', strictRules);

      metrics.recordCall('session-1');
      metrics.recordCall('session-2');

      // At the limit now: a third call is rejected.
      expect(metrics.isAllowed('session-3').allowed).toBe(false);

      // Advance past the window: the two earlier calls fall out, so a new call
      // is allowed again. Under the old synthetic-timestamp behavior all prior
      // calls were counted as "now" and this would stay rejected.
      vi.advanceTimersByTime(61 * 1000);
      expect(metrics.isAllowed('session-3').allowed).toBe(true);
      expect(metrics.getMetrics().callCount).toBe(0);
    });
  });

  describe('expiration', () => {
    it('detects expired correlation', () => {
      const shortRules: CorrelationRules = {
        maxAgeSeconds: 60,
        rateLimit: { maxCalls: 100, windowSeconds: 60 }
      };
      metrics = new CorrelationMetrics('test', shortRules);
      
      expect(metrics.isExpired()).toBe(false);
      
      // Advance time past expiration
      vi.advanceTimersByTime(61 * 1000);
      
      expect(metrics.isExpired()).toBe(true);
    });
  });

  describe('getMetrics', () => {
    it('returns current metrics', () => {
      metrics = new CorrelationMetrics('test-id');
      metrics.recordCall('session-1');
      
      const data = metrics.getMetrics();
      expect(data.correlationId).toBe('test-id');
      expect(data.chainLength).toBe(1);
      expect(data.chain).toEqual(['session-1']);
      expect(data.ageSeconds).toBeGreaterThanOrEqual(0);
    });
  });
});
