/**
 * Tests for rate-aggregator.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RateAggregator } from '../../src/rate-aggregator.js';

describe('RateAggregator', () => {
  let aggregator: RateAggregator;
  const config = { maxCalls: 5, windowSeconds: 60 };

  beforeEach(() => {
    aggregator = new RateAggregator(config);
  });

  describe('isAllowed', () => {
    it('allows calls under limit', () => {
      const now = Date.now();
      expect(aggregator.isAllowed(now)).toBe(true);
    });

    it('rejects calls at limit', () => {
      const now = Date.now();
      
      // Record 5 calls (at limit)
      for (let i = 0; i < 5; i++) {
        aggregator.recordCall(now + i);
      }
      
      expect(aggregator.isAllowed(now + 5)).toBe(false);
    });

    it('allows calls after window expires', () => {
      const start = Date.now();
      
      // Record 5 calls
      for (let i = 0; i < 5; i++) {
        aggregator.recordCall(start + i);
      }
      
      expect(aggregator.isAllowed(start + 100)).toBe(false);
      
      // After window expires, should be allowed again
      const afterWindow = start + (61 * 1000);
      expect(aggregator.isAllowed(afterWindow)).toBe(true);
    });
  });

  describe('recordCall', () => {
    it('tracks calls correctly', () => {
      const now = Date.now();
      
      aggregator.recordCall(now);
      aggregator.recordCall(now + 1000);
      
      expect(aggregator.getCallCount(now + 2000)).toBe(2);
    });
  });

  describe('getCallCount', () => {
    it('returns count within window', () => {
      const now = Date.now();
      
      aggregator.recordCall(now);
      aggregator.recordCall(now + 1000);
      aggregator.recordCall(now + 2000);
      
      expect(aggregator.getCallCount(now + 3000)).toBe(3);
    });

    it('excludes calls outside window', () => {
      const start = Date.now();
      
      // Record call at start
      aggregator.recordCall(start);
      
      // Check count after window has passed
      const afterWindow = start + (61 * 1000);
      expect(aggregator.getCallCount(afterWindow)).toBe(0);
    });
  });

  describe('reset', () => {
    it('clears all recorded calls', () => {
      const now = Date.now();
      
      aggregator.recordCall(now);
      aggregator.recordCall(now + 1000);
      
      expect(aggregator.getCallCount(now + 2000)).toBe(2);
      
      aggregator.reset();
      
      expect(aggregator.getCallCount(now + 2000)).toBe(0);
    });
  });
});
