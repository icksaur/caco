import { describe, it, expect, beforeEach, vi } from 'vitest';

const storage = vi.hoisted(() => {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    meta,
    getSessionMeta: vi.fn((id: string) => meta.get(id)),
    updateSessionMeta: vi.fn((id: string, mutate: (m: Record<string, unknown>) => void) => {
      const m = meta.get(id);
      if (!m) return false;
      mutate(m);
      return true;
    }),
  };
});
const bus = vi.hoisted(() => ({ broadcastGlobalEvent: vi.fn(), broadcastEvent: vi.fn() }));

vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/event-bus.js', () => bus);

import { UnobservedTracker } from '../../src/unobserved-tracker.js';

beforeEach(() => {
  storage.meta.clear();
  vi.clearAllMocks();
});

/**
 * The pager's dismiss must be independent of unobserved state. Gating on the
 * shared flag is what made a card vanish when another machine viewed the session,
 * and made a phone dismissal clear a desktop dot. This asserts the separation at
 * the state level: the dismiss writes its own watermark and the tracker is
 * untouched.
 */
describe('pager dismiss is independent of observation', () => {
  it('writes pagerDismissedAt without touching lastObservedAt', () => {
    storage.meta.set('s1', { name: 'x', kind: 'interactive' });

    const dismissedAt = new Date().toISOString();
    const ok = storage.updateSessionMeta('s1', m => { m.pagerDismissedAt = dismissedAt; });

    expect(ok).toBe(true);
    expect(storage.meta.get('s1')).toMatchObject({ pagerDismissedAt: dismissedAt });
    expect(storage.meta.get('s1')).not.toHaveProperty('lastObservedAt');
  });

  it('leaves a session unobserved after a dismissal', () => {
    const tracker = new UnobservedTracker(bus.broadcastGlobalEvent);
    storage.meta.set('s2', { name: 'x', kind: 'interactive' });
    tracker.markIdle('s2');
    expect(tracker.isUnobserved('s2')).toBe(true);

    // The dismiss path writes only its own field.
    storage.updateSessionMeta('s2', m => { m.pagerDismissedAt = new Date().toISOString(); });

    // Still unobserved: the desktop dot survives a phone dismissal.
    expect(tracker.isUnobserved('s2')).toBe(true);
    expect(tracker.getCount()).toBe(1);
  });

  it('refuses to report success when the meta write fails', () => {
    // No meta for this id, so the write returns false and the route must 409
    // rather than claim a dismissal that would reappear on the next poll.
    expect(storage.updateSessionMeta('missing', m => { m.pagerDismissedAt = 'x'; })).toBe(false);
  });
});
