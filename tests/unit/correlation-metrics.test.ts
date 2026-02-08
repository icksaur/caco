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

    it('allows calls within depth limit', () => {
      metrics.recordCall('session-1');
      const result = metrics.isAllowed('session-2');
      expect(result.allowed).toBe(true);
    });

    it('rejects call exceeding depth limit', () => {
      // Default maxDepth is 2, so chain of 3 should be rejected
      metrics.recordCall('session-1');
      metrics.recordCall('session-2');
      
      const result = metrics.isAllowed('session-3');
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain('depth');
      }
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
        maxDepth: 100,
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
        expect(result.reason).toContain('Rate limit');
      }
    });
  });

  describe('expiration', () => {
    it('detects expired correlation', () => {
      const shortRules: CorrelationRules = {
        maxDepth: 10,
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
