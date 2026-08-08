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
    it('loads sessions carrying an unobserved VERDICT, ignoring timestamps', () => {
      // The verdict is the only input (spec-observation-verdict-completeness).
      // session1/2 carry contradictory timestamps to prove they are not read:
      // session1 was observed AFTER it went idle yet is still owed, and session2
      // went idle after being observed yet is not.
      mockMeta.set('session1', {
        name: '',
        unobserved: true,
        lastIdleAt: '2026-02-06T10:00:00Z',
        lastObservedAt: '2026-02-06T11:00:00Z'
      });
      mockMeta.set('session2', {
        name: '',
        unobserved: false,
        lastIdleAt: '2026-02-06T12:00:00Z',
        lastObservedAt: '2026-02-06T11:00:00Z'
      });
      // No verdict: a delegate target whose meta predates the field. Formerly
      // hydrated as unobserved from the timestamps alone — the reported bug.
      mockMeta.set('session3', {
        name: '',
        lastIdleAt: '2026-02-06T12:00:00Z'
      });
      
      unobservedTracker.hydrate(['session1', 'session2', 'session3']);
      
      expect(unobservedTracker.isUnobserved('session1')).toBe(true);
      expect(unobservedTracker.isUnobserved('session2')).toBe(false);
      expect(unobservedTracker.isUnobserved('session3')).toBe(false);
      expect(unobservedTracker.getCount()).toBe(1);
    });

    it('skips sessions with no verdict', () => {
      mockMeta.set('session1', { name: '' });
      
      unobservedTracker.hydrate(['session1']);
      
      expect(unobservedTracker.getCount()).toBe(0);
    });

    it('only hydrates once', () => {
      mockMeta.set('session1', {
        name: '',
        unobserved: true
      });
      
      unobservedTracker.hydrate(['session1']);
      expect(unobservedTracker.getCount()).toBe(1);
      
      // Second hydrate should be no-op
      mockMeta.set('session2', {
        name: '',
        unobserved: true
      });
      unobservedTracker.hydrate(['session1', 'session2']);
      
      expect(unobservedTracker.getCount()).toBe(1); // Still 1, not 2
    });
  });

  describe('the persisted verdict', () => {
    it('is written by markIdle and cleared by markObserved', () => {
      // The /observe route goes through the tracker, not the meta store, so it
      // needs its own clear — otherwise a session the user just read re-arms on
      // the next restart (spec-observation-authority).
      unobservedTracker.markIdle('session1');
      expect(mockMeta.get('session1')?.unobserved).toBe(true);

      unobservedTracker.markObserved('session1');
      expect(mockMeta.get('session1')?.unobserved).toBe(false);
    });

    it('survives a rebuild: hydrate reads back what the live set held', () => {
      unobservedTracker.markIdle('session1');
      unobservedTracker.markIdle('session2');
      unobservedTracker.markObserved('session2');
      const live = ['session1', 'session2'].filter(id => unobservedTracker.isUnobserved(id));

      const fresh = new UnobservedTracker(vi.fn());
      fresh.hydrate(['session1', 'session2']);

      expect(['session1', 'session2'].filter(id => fresh.isUnobserved(id))).toEqual(live);
    });
  });

  describe('sub-sessions are suppressed by attendance, not by kind', () => {
    // The kind test was a stand-in for "an agent is watching this", true of swarm
    // children but ALSO of delegate targets — which are ordinary interactive
    // sessions, so no kind could ever classify them. The request source now
    // answers it for every kind, recorded as lastAttendedAt on the authority's
    // unconditional path (spec-observation-authority).

    it('marks a swarm session whose idle was NOT attended', () => {
      mockMeta.set('child1', { name: '', kind: 'swarm' });

      const result = unobservedTracker.markIdle('child1');

      expect(result).toBe(true);
      expect(unobservedTracker.isUnobserved('child1')).toBe(true);
    });

    it('markIdle still persists lastIdleAt', () => {
      mockMeta.set('child1', { name: '', kind: 'swarm' });

      unobservedTracker.markIdle('child1');

      expect(mockMeta.get('child1')?.lastIdleAt).toBeDefined();
    });

    it('hydrate reads the persisted verdict regardless of kind', () => {
      // A swarm child and an interactive delegate target, both attended: neither
      // may arm. The interactive one is the case the old kind check missed.
      mockMeta.set('child1', { name: '', kind: 'swarm', lastIdleAt: '2026-02-06T12:00:00Z', unobserved: false });
      mockMeta.set('reviewer', { name: '', kind: 'interactive', lastIdleAt: '2026-02-06T12:00:00Z', unobserved: false });
      mockMeta.set('normal1', { name: '', lastIdleAt: '2026-02-06T12:00:00Z', unobserved: true });

      unobservedTracker.hydrate(['child1', 'reviewer', 'normal1']);

      expect(unobservedTracker.isUnobserved('child1')).toBe(false);
      expect(unobservedTracker.isUnobserved('reviewer')).toBe(false);
      expect(unobservedTracker.isUnobserved('normal1')).toBe(true);
      expect(unobservedTracker.getCount()).toBe(1);
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
