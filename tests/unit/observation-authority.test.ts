import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The observation authority (spec-observation-authority).
 *
 * The bug this pins is NOT in `markIdle` — that is fully gated on
 * `needsObservation` and never runs for agent-sourced traffic. It is in the
 * effect the authority runs UNCONDITIONALLY (`herdOnSessionIdle` →
 * `markSessionIdle`), which stamps `lastIdleAt` for every idle including the
 * attended ones. `hydrate()` then reconstructs the set from those timestamps and
 * disagrees with the live set.
 *
 * So these tests drive `handleSessionIdle` — the real seam — and re-hydrate a
 * fresh tracker from the resulting metadata. Driving `markIdle` directly cannot
 * reproduce the divergence, because there the set and the timestamp move together.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'caco-obs-'));

/** Read a session's meta as the store actually persisted it. */
function meta(id: string): Record<string, unknown> {
  const p = join(TEST_ROOT, id, 'meta.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

vi.mock('../../src/storage-paths.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    // Redirect the meta store at the FILESYSTEM, not at its own functions: it
    // calls updateSessionMeta internally, and a partial module mock does not
    // intercept intra-module calls — which would leave the real write path
    // untested, the exact failure this spec exists to prevent.
    getSessionDir: (id: string) => join(TEST_ROOT, id),
  };
});
vi.mock('../../src/routes/websocket.js', () => ({ broadcastGlobalEvent: vi.fn() }));
vi.mock('../../src/event-bus.js', () => ({ broadcastGlobalEvent: vi.fn(), broadcastEvent: vi.fn() }));

import { handleSessionIdle } from '../../src/idle-authority.js';
import { UnobservedTracker } from '../../src/unobserved-tracker.js';
import { markSessionIdle, markSessionObserved, setSessionMeta } from '../../src/session-meta-store.js';

/** A tracker standing in for the live one, wired to the same metadata. */
function liveTracker(): UnobservedTracker {
  return new UnobservedTracker(vi.fn());
}

/**
 * Drive one real idle through the authority. `attended` is the spec's term for
 * an agent-requested idle — the authority sees it as `needsObservation: false`.
 */
async function idle(tracker: UnobservedTracker, sessionId: string, attended: boolean): Promise<void> {
  await handleSessionIdle(sessionId, { needsObservation: !attended }, {
    hasPendingAutoContinue: () => false,
    pendingToolCount: () => 0,
    runAutoContinue: () => Promise.resolve(false),
    markIdle: id => { tracker.markIdle(id); },
    // The unconditional effect. In production this is herd-runtime's
    // onSessionIdle, which calls markSessionIdle for EVERY idle — attended or
    // not — and that is the write that arms the badge. The stub takes the
    // authority's OWN `attended` argument rather than the test's local, so it
    // cannot implement the fix on the test side and pass before the code does.
    herdOnSessionIdle: (id, attendedByAuthority) => { markSessionIdle(id, attendedByAuthority); },
    pollQuota: () => {},
    signalDispatchIdle: () => {},
    notifyExternalIdle: () => {},
  });
}

/** What a restart would compute from the metadata this run produced. */
function rehydrated(ids: string[]): UnobservedTracker {
  const t = new UnobservedTracker(vi.fn());
  t.hydrate(ids);
  return t;
}

beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); });

describe('an attended idle does not arm the badge for a restart', () => {
  it('leaves a delegate target observed after re-hydrating', async () => {
    // The reported symptom: reviewer sessions that were delegated to show the
    // badge in a batch once the set is rebuilt from timestamps.
    const live = liveTracker();
    setSessionMeta('reviewer', { name: 'reviewer', kind: 'interactive' } as never);
    markSessionObserved('reviewer');

    await idle(live, 'reviewer', true);   // a delegate reply

    expect(live.isUnobserved('reviewer')).toBe(false);
    expect(rehydrated(['reviewer']).isUnobserved('reviewer')).toBe(false);
  });

  it('still arms for an idle the user is owed', async () => {
    const live = liveTracker();
    setSessionMeta('chat', { name: 'chat', kind: 'interactive' } as never);
    markSessionObserved('chat');

    await idle(live, 'chat', false);      // the user's own turn

    expect(live.isUnobserved('chat')).toBe(true);
    expect(rehydrated(['chat']).isUnobserved('chat')).toBe(true);
  });

  it('keeps stamping lastIdleAt on an attended idle', async () => {
    // Load-bearing: the archive reaper and rotation read lastIdleAt as a
    // COLDNESS signal, so skipping it would make an active delegate look idle
    // for hours and expose it to auto-archive.
    const live = liveTracker();
    setSessionMeta('reviewer', { name: 'reviewer', kind: 'interactive' } as never);

    await idle(live, 'reviewer', true);

    expect(meta('reviewer').lastIdleAt).toBeDefined();
  });
});

describe('the live set and a re-hydrated set agree', () => {
  it('converges over a mixed sequence of idles and observations', async () => {
    // The property that actually failed: each representation is individually
    // defensible, and they diverge only in combination.
    const live = liveTracker();
    for (const id of ['user-chat', 'reviewer', 'herd-child', 'swarm-child']) {
      setSessionMeta(id, { name: id, kind: id === 'swarm-child' ? 'swarm' : 'interactive' } as never);
    }

    await idle(live, 'user-chat', false);
    await idle(live, 'reviewer', true);
    markSessionObserved('reviewer');
    await idle(live, 'reviewer', true);     // delegated to again after being read
    await idle(live, 'herd-child', true);
    await idle(live, 'swarm-child', true);

    const ids = ['user-chat', 'reviewer', 'herd-child', 'swarm-child'];
    const after = rehydrated(ids);
    expect(ids.filter(id => after.isUnobserved(id)))
      .toEqual(ids.filter(id => live.isUnobserved(id)));
  });

  it('classifies a swarm session by its stamps, not its kind', async () => {
    // Kind cannot decide this: a delegate target is kind 'interactive'. Once
    // attendance follows the request source, an unattended swarm idle SHOULD arm
    // — proving no kind test survives on either path.
    const live = liveTracker();
    setSessionMeta('swarm-child', { name: 'swarm', kind: 'swarm' } as never);

    await idle(live, 'swarm-child', false);

    expect(live.isUnobserved('swarm-child')).toBe(true);
    expect(rehydrated(['swarm-child']).isUnobserved('swarm-child')).toBe(true);
  });
});

describe('metadata written before this change still behaves as it did', () => {
  it('treats a missing lastAttendedAt as no attendance', () => {
    setSessionMeta('old', { name: 'old', lastIdleAt: '2026-01-02T00:00:00.000Z', lastObservedAt: '2026-01-01T00:00:00.000Z' } as never);
    setSessionMeta('old-seen', { name: 'old', lastIdleAt: '2026-01-01T00:00:00.000Z', lastObservedAt: '2026-01-02T00:00:00.000Z' } as never);

    const t = rehydrated(['old', 'old-seen']);

    expect(t.isUnobserved('old')).toBe(true);
    expect(t.isUnobserved('old-seen')).toBe(false);
  });
});
