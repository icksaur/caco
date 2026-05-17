import { describe, it, expect, vi } from 'vitest';
import { SessionStateTracker } from '../../public/ts/session-state-tracker.js';

function createTracker() {
  return new SessionStateTracker();
}

describe('SessionStateTracker', () => {
  describe('setBusy', () => {
    it('tracks busy state', () => {
      const t = createTracker();
      expect(t.isBusy('s1')).toBe(false);
      t.setBusy('s1', true);
      expect(t.isBusy('s1')).toBe(true);
      t.setBusy('s1', false);
      expect(t.isBusy('s1')).toBe(false);
    });

    it('notifies on change', () => {
      const t = createTracker();
      const cb = vi.fn();
      t.onChange(cb);
      t.setBusy('s1', true);
      expect(cb).toHaveBeenCalledWith('s1', expect.objectContaining({ busy: true, unobserved: false, intent: null }));
    });

    it('does not notify when value unchanged', () => {
      const t = createTracker();
      t.setBusy('s1', true);
      const cb = vi.fn();
      t.onChange(cb);
      t.setBusy('s1', true);
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('setUnobserved', () => {
    it('tracks unobserved state', () => {
      const t = createTracker();
      t.setUnobserved('s1', true);
      expect(t.get('s1')?.unobserved).toBe(true);
      t.setUnobserved('s1', false);
      expect(t.get('s1')?.unobserved).toBe(false);
    });
  });

  describe('setIntent', () => {
    it('tracks intent', () => {
      const t = createTracker();
      t.setIntent('s1', 'Exploring codebase');
      expect(t.get('s1')?.intent).toBe('Exploring codebase');
      t.setIntent('s1', null);
      expect(t.get('s1')?.intent).toBeNull();
    });
  });

  describe('syncFromList', () => {
    it('creates entries from list', () => {
      const t = createTracker();
      t.syncFromList([
        { sessionId: 's1', isBusy: true, isUnobserved: false },
        { sessionId: 's2', isBusy: false, isUnobserved: true, currentIntent: 'Testing' }
      ]);
      expect(t.isBusy('s1')).toBe(true);
      expect(t.get('s2')?.unobserved).toBe(true);
      expect(t.get('s2')?.intent).toBe('Testing');
    });

    it('removes sessions not in list', () => {
      const t = createTracker();
      t.setBusy('s1', true);
      t.setBusy('s2', true);
      t.syncFromList([{ sessionId: 's2', isBusy: true }]);
      expect(t.get('s1')).toBeUndefined();
      expect(t.isBusy('s2')).toBe(true);
    });

    it('notifies only on changes', () => {
      const t = createTracker();
      t.setBusy('s1', true);
      const cb = vi.fn();
      t.onChange(cb);
      t.syncFromList([{ sessionId: 's1', isBusy: true }]);
      expect(cb).not.toHaveBeenCalled();
      t.syncFromList([{ sessionId: 's1', isBusy: false }]);
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe('getBusyCount', () => {
    it('counts busy sessions', () => {
      const t = createTracker();
      t.setBusy('s1', true);
      t.setBusy('s2', true);
      t.setBusy('s3', false);
      expect(t.getBusyCount()).toBe(2);
    });

    it('excludes specified session', () => {
      const t = createTracker();
      t.setBusy('s1', true);
      t.setBusy('s2', true);
      expect(t.getBusyCount('s1')).toBe(1);
    });
  });

  describe('getUnobservedCount', () => {
    it('counts unobserved sessions', () => {
      const t = createTracker();
      t.setUnobserved('s1', true);
      t.setUnobserved('s2', true);
      t.setUnobserved('s3', false);
      expect(t.getUnobservedCount()).toBe(2);
    });
  });

  describe('onChange', () => {
    it('returns unsubscribe function', () => {
      const t = createTracker();
      const cb = vi.fn();
      const unsub = t.onChange(cb);
      t.setBusy('s1', true);
      expect(cb).toHaveBeenCalledOnce();
      unsub();
      t.setBusy('s1', false);
      expect(cb).toHaveBeenCalledOnce();
    });

    it('handles listener errors gracefully', () => {
      // The tracker logs the caught error via console.error; suppress that
      // output for this test (we're verifying the catch-and-continue path).
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const t = createTracker();
      const bad = vi.fn(() => { throw new Error('oops'); });
      const good = vi.fn();
      t.onChange(bad);
      t.onChange(good);
      t.setBusy('s1', true);
      expect(good).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});
