/**
 * Tests for dispatch-state.ts
 * 
 * Verifies the consolidated dispatch state tracker that manages
 * both busy status and correlation context atomically.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DispatchState } from '../../src/dispatch-state.js';

describe('DispatchState', () => {
  let state: DispatchState;

  beforeEach(() => {
    state = new DispatchState();
  });

  describe('start/end lifecycle', () => {
    it('marks session as busy after start', () => {
      expect(state.isBusy('session-1')).toBe(false);
      state.start('session-1', 'corr-123');
      expect(state.isBusy('session-1')).toBe(true);
    });

    it('clears busy after end', () => {
      state.start('session-1', 'corr-123');
      state.end('session-1');
      expect(state.isBusy('session-1')).toBe(false);
    });

    it('tracks multiple sessions independently', () => {
      state.start('session-1', 'corr-1');
      state.start('session-2', 'corr-2');
      
      expect(state.isBusy('session-1')).toBe(true);
      expect(state.isBusy('session-2')).toBe(true);
      
      state.end('session-1');
      
      expect(state.isBusy('session-1')).toBe(false);
      expect(state.isBusy('session-2')).toBe(true);
    });

    it('end is idempotent - double end does not error', () => {
      state.start('session-1', 'corr-123');
      state.end('session-1');
      state.end('session-1'); // Should not throw
      expect(state.isBusy('session-1')).toBe(false);
    });

    it('end on non-existent session does not error', () => {
      state.end('never-started'); // Should not throw
      expect(state.isBusy('never-started')).toBe(false);
    });
  });

  describe('correlationId tracking', () => {
    it('returns correlationId during active dispatch', () => {
      state.start('session-1', 'corr-123');
      expect(state.getCorrelationId('session-1')).toBe('corr-123');
    });

    it('returns undefined when not dispatching', () => {
      expect(state.getCorrelationId('session-1')).toBeUndefined();
    });

    it('returns undefined after dispatch ends', () => {
      state.start('session-1', 'corr-123');
      state.end('session-1');
      expect(state.getCorrelationId('session-1')).toBeUndefined();
    });

    it('tracks different correlationIds per session', () => {
      state.start('session-1', 'corr-aaa');
      state.start('session-2', 'corr-bbb');
      
      expect(state.getCorrelationId('session-1')).toBe('corr-aaa');
      expect(state.getCorrelationId('session-2')).toBe('corr-bbb');
    });
  });

  describe('atomic guarantee - busy and correlationId in sync', () => {
    it('correlationId exists if and only if busy', () => {
      // Before start: neither busy nor has correlationId
      expect(state.isBusy('session-1')).toBe(false);
      expect(state.getCorrelationId('session-1')).toBeUndefined();

      // After start: both busy and has correlationId
      state.start('session-1', 'corr-123');
      expect(state.isBusy('session-1')).toBe(true);
      expect(state.getCorrelationId('session-1')).toBe('corr-123');

      // After end: neither busy nor has correlationId
      state.end('session-1');
      expect(state.isBusy('session-1')).toBe(false);
      expect(state.getCorrelationId('session-1')).toBeUndefined();
    });
  });

  describe('getDispatch metadata', () => {
    it('returns full dispatch info including startedAt', () => {
      const before = Date.now();
      state.start('session-1', 'corr-123');
      const after = Date.now();

      const dispatch = state.getDispatch('session-1');
      expect(dispatch).toBeDefined();
      expect(dispatch!.correlationId).toBe('corr-123');
      expect(dispatch!.startedAt).toBeGreaterThanOrEqual(before);
      expect(dispatch!.startedAt).toBeLessThanOrEqual(after);
    });

    it('returns undefined when not dispatching', () => {
      expect(state.getDispatch('session-1')).toBeUndefined();
    });
  });
});
