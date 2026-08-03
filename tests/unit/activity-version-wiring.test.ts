import { describe, it, expect, beforeEach, vi } from 'vitest';

// Storage is faked so the tracker's meta writes do not touch disk; the real
// activityVersion singleton is used, because the point of this file is to prove
// the PRODUCTION wiring bumps it.
const storage = vi.hoisted(() => ({
  getSessionMeta: vi.fn(() => ({ name: 'x', kind: 'interactive' })),
  updateSessionMeta: vi.fn((_id: string, mutate: (m: Record<string, unknown>) => void) => { mutate({}); return true; }),
}));
const bus = vi.hoisted(() => ({ broadcastGlobalEvent: vi.fn(), broadcastEvent: vi.fn() }));

vi.mock('../../src/storage.js', () => storage);
vi.mock('../../src/event-bus.js', () => bus);

import { activityVersion } from '../../src/activity-version.js';
import { dispatchState } from '../../src/dispatch-state.js';
import { UnobservedTracker } from '../../src/unobserved-tracker.js';

beforeEach(() => {
  activityVersion._resetForTest();
  vi.clearAllMocks();
  storage.getSessionMeta.mockReturnValue({ name: 'x', kind: 'interactive' });
});

/** The version after running `fn`, minus the version before. */
function delta(fn: () => void): number {
  const before = activityVersion.version;
  fn();
  return activityVersion.version - before;
}

describe('activity version wiring', () => {
  it('bumps when a dispatch starts and again when it ends', () => {
    const id = `wire-${Date.now()}-a`;
    expect(delta(() => dispatchState.start(id, 'corr-1'))).toBeGreaterThan(0);
    expect(delta(() => dispatchState.end(id))).toBeGreaterThan(0);
  });

  // The board no longer depends on unobserved state, so waking every parked
  // poller for it would be pure churn (spec-pager).
  it('does NOT bump when a session becomes unobserved', () => {
    const tracker = new UnobservedTracker(bus.broadcastGlobalEvent);
    expect(delta(() => { tracker.markIdle('wire-b'); })).toBe(0);
  });

  it('does NOT bump when a session is observed', () => {
    const tracker = new UnobservedTracker(bus.broadcastGlobalEvent);
    tracker.markIdle('wire-c');
    expect(delta(() => { tracker.markObserved('wire-c'); })).toBe(0);
  });

  it('does not bump when marking an already-observed session (no state change)', () => {
    const tracker = new UnobservedTracker(bus.broadcastGlobalEvent);
    expect(delta(() => { tracker.markObserved('never-idle'); })).toBe(0);
  });

  it('does not bump for a swarm session going idle (it never becomes unobserved)', () => {
    storage.getSessionMeta.mockReturnValue({ name: 'x', kind: 'swarm' });
    storage.updateSessionMeta.mockImplementation((_id: string, mutate: (m: Record<string, unknown>) => void) => {
      mutate({ kind: 'swarm' }); return true;
    });
    const tracker = new UnobservedTracker(bus.broadcastGlobalEvent);
    expect(delta(() => { tracker.markIdle('wire-swarm'); })).toBe(0);
  });
});

describe('activity version wiring — responseOptions', () => {
  it('bumps when an assistant message carries a caco-actions block', async () => {
    const { applyDispatchEventEffects } = await import('../../src/dispatch-events.js');
    const before = activityVersion.version;
    applyDispatchEventEffects('wire-d', {
      type: 'assistant.message',
      data: { content: 'done\n\n```caco-actions\nDo the next thing\n```' },
    } as never, {} as never);
    expect(activityVersion.version).toBeGreaterThan(before);
  });

  it('does not bump for an assistant message with no block', async () => {
    const { applyDispatchEventEffects } = await import('../../src/dispatch-events.js');
    expect(delta(() => {
      applyDispatchEventEffects('wire-e', {
        type: 'assistant.message',
        data: { content: 'just prose, no actions' },
      } as never, {} as never);
    })).toBe(0);
  });
});
