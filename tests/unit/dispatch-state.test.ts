/**
 * Tests for dispatch-state.ts
 * 
 * Verifies the consolidated dispatch state tracker that manages
 * both busy status and correlation context atomically.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

    it('getActiveCount tracks the number of in-flight dispatches', () => {
      expect(state.getActiveCount()).toBe(0);
      state.start('s1', 'c1');
      expect(state.getActiveCount()).toBe(1);
      state.start('s2', 'c2');
      expect(state.getActiveCount()).toBe(2);
      state.end('s1');
      expect(state.getActiveCount()).toBe(1);
      state.end('s2');
      expect(state.getActiveCount()).toBe(0);
      state.end('s2'); // idempotent
      expect(state.getActiveCount()).toBe(0);
    });

    it('rejects duplicate starts without overwriting correlation context', () => {
      state.start('s1', 'c1');

      expect(() => state.start('s1', 'c2')).toThrow('Session s1 is already dispatching');

      expect(state.getActiveCount()).toBe(1);
      expect(state.getCorrelationId('s1')).toBe('c1');
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

  describe('idle event emission', () => {
    it('emits idle event when dispatch ends', () => {
      const events: string[] = [];
      state.on('idle', (id: string) => events.push(id));

      state.start('session-1', 'corr-123');
      state.end('session-1');

      expect(events).toEqual(['session-1']);
    });

    it('emits idle on double-end', () => {
      const events: string[] = [];
      state.on('idle', (id: string) => events.push(id));

      state.start('session-1', 'corr-123');
      state.end('session-1');
      state.end('session-1');

      expect(events).toEqual(['session-1', 'session-1']);
    });

    it('does not interfere with other sessions', () => {
      const events: string[] = [];
      state.on('idle', (id: string) => events.push(id));

      state.start('session-1', 'corr-1');
      state.start('session-2', 'corr-2');
      state.end('session-1');

      expect(events).toEqual(['session-1']);
      expect(state.isBusy('session-2')).toBe(true);
    });
  });

  describe('waitForIdle', () => {
    it('resolves immediately when not busy', async () => {
      const result = await state.waitForIdle('session-1', 5000);
      expect(result).toBe('idle');
    });

    it('resolves when dispatch ends', async () => {
      state.start('session-1', 'corr-123');

      const promise = state.waitForIdle('session-1', 5000);
      state.end('session-1');

      const result = await promise;
      expect(result).toBe('idle');
    });

    it('resolves with timeout when dispatch never ends', async () => {
      state.start('session-1', 'corr-123');

      const result = await state.waitForIdle('session-1', 50);
      expect(result).toBe('timeout');
    });

    it('cleans up listener after resolution', async () => {
      state.start('session-1', 'corr-123');

      const promise = state.waitForIdle('session-1', 5000);
      state.end('session-1');
      await promise;

      expect(state.listenerCount('idle')).toBe(0);
    });
  });

  describe('notifyActivity', () => {
    it('emits an activity event carrying sessionId and eventType', () => {
      const seen: Array<{ sessionId: string; eventType: string }> = [];
      state.on('activity', (e: { sessionId: string; eventType: string }) => seen.push(e));

      state.notifyActivity('session-1', 'tool.execution_start');

      expect(seen).toEqual([{ sessionId: 'session-1', eventType: 'tool.execution_start' }]);
    });
  });

  describe('waitForActive', () => {
    const IDLE = 1000;
    const MAX = 10_000;

    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('resolves idle immediately when not busy', async () => {
      await expect(state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX })).resolves.toBe('idle');
    });

    it('resolves gone immediately when isGone is already true', async () => {
      state.start('s1', 'c1');
      await expect(
        state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX, isGone: () => true })
      ).resolves.toBe('gone');
    });

    it('resolves idle when the dispatch ends', async () => {
      state.start('s1', 'c1');
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX });
      state.end('s1');
      await expect(p).resolves.toBe('idle');
    });

    // ── suppressIdle (spec-idle-authority): a pending-continuation idle is not real ──

    it('suppressIdle gates the entry fast-path (not-busy + suppressed ⇒ waits, not idle)', async () => {
      // Not busy AND suppressed: must NOT resolve idle immediately; times out instead.
      const p = state.waitForActive('s1', {
        idleTimeoutMs: IDLE, maxTotalMs: MAX, suppressIdle: () => true,
      });
      await vi.advanceTimersByTimeAsync(MAX);
      await expect(p).resolves.toBe('timeout');
    });

    it('suppressIdle gates the idle listener: a suppressed end() does not resolve, a later real end() does', async () => {
      state.start('s1', 'c1');
      let suppressed = true;
      const p = state.waitForActive('s1', {
        idleTimeoutMs: IDLE, maxTotalMs: MAX, suppressIdle: () => suppressed,
      });
      // Reveal-dispatch ends while suppressed → ignored, keep waiting.
      state.end('s1');
      await vi.advanceTimersByTimeAsync(0);
      // Continuation runs then reaches a real idle (predicate now false).
      suppressed = false;
      state.start('s1', 'c2');
      state.end('s1');
      await expect(p).resolves.toBe('idle');
    });

    it('suppressIdle gates the post-arm re-check (ends in the arm window while suppressed)', async () => {
      // Busy at entry (arms listeners), then not-busy but suppressed at the
      // post-arm re-check → must not resolve; a later unsuppressed end() does.
      state.start('s1', 'c1');
      let suppressed = true;
      const p = state.waitForActive('s1', {
        idleTimeoutMs: IDLE, maxTotalMs: MAX, suppressIdle: () => suppressed,
      });
      state.end('s1');                 // suppressed → ignored by listener
      await vi.advanceTimersByTimeAsync(0);
      suppressed = false;
      state.start('s1', 'c2');
      state.end('s1');
      await expect(p).resolves.toBe('idle');
    });

    it('times out after the idle gap with no activity', async () => {
      state.start('s1', 'c1');
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX });
      await vi.advanceTimersByTimeAsync(IDLE);
      await expect(p).resolves.toBe('timeout');
    });

    it('activity resets the idle gap (no false timeout while working)', async () => {
      state.start('s1', 'c1');
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX });
      let settled = false;
      void p.then(() => { settled = true; });

      // Keep emitting activity just under the idle gap across several windows.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(IDLE - 1);
        state.notifyActivity('s1', 'assistant.message_delta');
      }
      expect(settled).toBe(false);

      // Then go silent — times out one idle gap later.
      await vi.advanceTimersByTimeAsync(IDLE);
      await expect(p).resolves.toBe('timeout');
    });

    it('the absolute cap fires even under continuous activity', async () => {
      state.start('s1', 'c1');
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX });
      const keep = setInterval(() => state.notifyActivity('s1', 'assistant.message_delta'), IDLE - 1);
      await vi.advanceTimersByTimeAsync(MAX);
      clearInterval(keep);
      await expect(p).resolves.toBe('timeout');
    });

    it('does not time out while a tool is executing (watchdog pause)', async () => {
      state.start('s1', 'c1');
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX });
      let settled = false;
      void p.then(() => { settled = true; });

      state.notifyActivity('s1', 'tool.execution_start');
      // Silence longer than the idle gap (but under the absolute cap).
      await vi.advanceTimersByTimeAsync(IDLE * 3);
      expect(settled).toBe(false);

      state.notifyActivity('s1', 'tool.execution_complete');
      state.end('s1');
      await expect(p).resolves.toBe('idle');
    });

    it('resolves gone when isGone trips during the wait', async () => {
      state.start('s1', 'c1');
      let gone = false;
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX, isGone: () => gone, gonePollMs: 100 });
      gone = true;
      await vi.advanceTimersByTimeAsync(100);
      await expect(p).resolves.toBe('gone');
    });

    it('removes its listeners on every exit path', async () => {
      state.start('s1', 'c1');
      const p = state.waitForActive('s1', { idleTimeoutMs: IDLE, maxTotalMs: MAX });
      await vi.advanceTimersByTimeAsync(IDLE);
      await p;
      expect(state.listenerCount('activity')).toBe(0);
      expect(state.listenerCount('idle')).toBe(0);
    });
  });
});
