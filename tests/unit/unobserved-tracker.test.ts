import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockMeta = new Map<string, Record<string, unknown>>();

vi.mock('../../src/storage.js', () => ({
  getSessionMeta: vi.fn((sessionId: string) => mockMeta.get(sessionId)),
  setSessionMeta: vi.fn((sessionId: string, meta: Record<string, unknown>) => {
    mockMeta.set(sessionId, meta);
  }),
  updateSessionMeta: vi.fn((sessionId: string, mutate: (m: Record<string, unknown>) => void, opts?: { createIfMissing?: boolean }) => {
    const existing = mockMeta.get(sessionId);
    if (!existing && opts?.createIfMissing === false) return false;
    const meta = existing ?? { name: '' };
    mutate(meta);
    mockMeta.set(sessionId, meta);
    return true;
  }),
}));

vi.mock('../../src/routes/websocket.js', () => ({
  broadcastGlobalEvent: vi.fn(),
}));

import { unobservedTracker, UnobservedTracker } from '../../src/unobserved-tracker.js';

describe('UnobservedTracker', () => {
  beforeEach(() => {
    mockMeta.clear();
    (unobservedTracker as any).unobservedSet.clear();
    (unobservedTracker as any).initialized = false;
  });

  describe('markIdle', () => {
    it('adds session to unobserved set', () => {
      expect(unobservedTracker.getCount()).toBe(0);
      
      unobservedTracker.markIdle('session1');
      
      expect(unobservedTracker.getCount()).toBe(1);
      expect(unobservedTracker.isUnobserved('session1')).toBe(true);
    });

    it('persists lastIdleAt to meta', () => {
      unobservedTracker.markIdle('session1');
      
      const meta = mockMeta.get('session1');
      expect(meta?.lastIdleAt).toBeDefined();
      expect(new Date(meta!.lastIdleAt as string)).toBeInstanceOf(Date);
    });

    it('is idempotent - double markIdle does not increment count', () => {
      unobservedTracker.markIdle('session1');
      unobservedTracker.markIdle('session1');
      
      expect(unobservedTracker.getCount()).toBe(1);
    });

    it('returns true only when newly added', () => {
      const first = unobservedTracker.markIdle('session1');
      const second = unobservedTracker.markIdle('session1');
      
      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });

  describe('markObserved', () => {
    it('removes session from unobserved set', () => {
      unobservedTracker.markIdle('session1');
      expect(unobservedTracker.getCount()).toBe(1);
      
      unobservedTracker.markObserved('session1');
      
      expect(unobservedTracker.getCount()).toBe(0);
      expect(unobservedTracker.isUnobserved('session1')).toBe(false);
    });

    it('persists lastObservedAt to meta', () => {
      unobservedTracker.markIdle('session1');
      unobservedTracker.markObserved('session1');
      
      const meta = mockMeta.get('session1');
      expect(meta?.lastObservedAt).toBeDefined();
      expect(new Date(meta!.lastObservedAt as string)).toBeInstanceOf(Date);
    });

    it('returns true only when actually was unobserved', () => {
      unobservedTracker.markIdle('session1');
      
      const first = unobservedTracker.markObserved('session1');
      const second = unobservedTracker.markObserved('session1');
      
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('returns false for never-unobserved session', () => {
      const result = unobservedTracker.markObserved('nonexistent');
      
      expect(result).toBe(false);
    });
  });

  describe('getCount', () => {
    it('returns 0 initially', () => {
      expect(unobservedTracker.getCount()).toBe(0);
    });

    it('tracks multiple sessions', () => {
      unobservedTracker.markIdle('session1');
      unobservedTracker.markIdle('session2');
      unobservedTracker.markIdle('session3');
      
      expect(unobservedTracker.getCount()).toBe(3);
      
      unobservedTracker.markObserved('session2');
      
      expect(unobservedTracker.getCount()).toBe(2);
    });
  });

  describe('isUnobserved', () => {
    it('returns false for unknown session', () => {
      expect(unobservedTracker.isUnobserved('unknown')).toBe(false);
    });

    it('returns true for idle session', () => {
      unobservedTracker.markIdle('session1');
      expect(unobservedTracker.isUnobserved('session1')).toBe(true);
    });

    it('returns false for observed session', () => {
      unobservedTracker.markIdle('session1');
      unobservedTracker.markObserved('session1');
      expect(unobservedTracker.isUnobserved('session1')).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes session from tracking', () => {
      unobservedTracker.markIdle('session1');
      expect(unobservedTracker.getCount()).toBe(1);
      
      unobservedTracker.remove('session1');
      
      expect(unobservedTracker.getCount()).toBe(0);
      expect(unobservedTracker.isUnobserved('session1')).toBe(false);
    });

    it('is safe to call for non-existent session', () => {
      unobservedTracker.remove('nonexistent');
      expect(unobservedTracker.getCount()).toBe(0);
    });
  });

  describe('hydrate', () => {
    it('loads unobserved sessions from meta', () => {
      // Setup: session1 has idle > observed (unobserved)
      // session2 has observed > idle (observed)
      // session3 has only idle (unobserved, never observed)
      mockMeta.set('session1', {
        name: '',
        lastIdleAt: '2026-02-06T12:00:00Z',
        lastObservedAt: '2026-02-06T11:00:00Z'
      });
      mockMeta.set('session2', {
        name: '',
        lastIdleAt: '2026-02-06T10:00:00Z',
        lastObservedAt: '2026-02-06T11:00:00Z'
      });
      mockMeta.set('session3', {
        name: '',
        lastIdleAt: '2026-02-06T12:00:00Z'
        // no lastObservedAt
      });
      
      unobservedTracker.hydrate(['session1', 'session2', 'session3']);
      
      expect(unobservedTracker.isUnobserved('session1')).toBe(true);
      expect(unobservedTracker.isUnobserved('session2')).toBe(false);
      expect(unobservedTracker.isUnobserved('session3')).toBe(true);
      expect(unobservedTracker.getCount()).toBe(2);
    });

    it('skips sessions without lastIdleAt', () => {
      mockMeta.set('session1', { name: '' });
      
      unobservedTracker.hydrate(['session1']);
      
      expect(unobservedTracker.getCount()).toBe(0);
    });

    it('only hydrates once', () => {
      mockMeta.set('session1', {
        name: '',
        lastIdleAt: '2026-02-06T12:00:00Z'
      });
      
      unobservedTracker.hydrate(['session1']);
      expect(unobservedTracker.getCount()).toBe(1);
      
      // Second hydrate should be no-op
      mockMeta.set('session2', {
        name: '',
        lastIdleAt: '2026-02-06T12:00:00Z'
      });
      unobservedTracker.hydrate(['session1', 'session2']);
      
      expect(unobservedTracker.getCount()).toBe(1); // Still 1, not 2
    });
  });

  describe('sub-sessions', () => {
    it('markIdle skips swarm sessions', () => {
      mockMeta.set('child1', { name: '', kind: 'swarm' });

      const result = unobservedTracker.markIdle('child1');

      expect(result).toBe(false);
      expect(unobservedTracker.isUnobserved('child1')).toBe(false);
      expect(unobservedTracker.getCount()).toBe(0);
    });

    it('markIdle still persists lastIdleAt for swarm sessions', () => {
      mockMeta.set('child1', { name: '', kind: 'swarm' });

      unobservedTracker.markIdle('child1');

      const meta = mockMeta.get('child1');
      expect(meta?.lastIdleAt).toBeDefined();
    });

    it('hydrate skips swarm sessions', () => {
      mockMeta.set('child1', {
        name: '',
        kind: 'swarm',
        lastIdleAt: '2026-02-06T12:00:00Z'
      });
      mockMeta.set('normal1', {
        name: '',
        lastIdleAt: '2026-02-06T12:00:00Z'
      });

      unobservedTracker.hydrate(['child1', 'normal1']);

      expect(unobservedTracker.isUnobserved('child1')).toBe(false);
      expect(unobservedTracker.isUnobserved('normal1')).toBe(true);
      expect(unobservedTracker.getCount()).toBe(1);
    });

    it('does not broadcast for swarm session markIdle', () => {
      const broadcastFn = vi.fn();
      const tracker = new UnobservedTracker(broadcastFn);
      mockMeta.set('child1', { name: '', kind: 'swarm' });

      tracker.markIdle('child1');

      expect(broadcastFn).not.toHaveBeenCalled();
    });
  });

  describe('broadcast', () => {
    it('calls broadcast function with sessionId and count', () => {
      const broadcastFn = vi.fn();
      const tracker = new UnobservedTracker(broadcastFn);
      
      tracker.markIdle('session1');
      
      expect(broadcastFn).toHaveBeenCalledWith({
        type: 'session.listChanged',
        data: { reason: 'idle', sessionId: 'session1', unobservedCount: 1 }
      });
    });

    it('broadcasts on markObserved', () => {
      const broadcastFn = vi.fn();
      const tracker = new UnobservedTracker(broadcastFn);
      
      tracker.markIdle('session1');
      broadcastFn.mockClear();
      
      tracker.markObserved('session1');
      
      expect(broadcastFn).toHaveBeenCalledWith({
        type: 'session.listChanged',
        data: { reason: 'observed', sessionId: 'session1', unobservedCount: 0 }
      });
    });
  });
});
