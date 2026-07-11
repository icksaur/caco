/**
 * Idle route tests (spec-idle-notifications Plan 4).
 *
 * parseIdleQuery is pure; the route behaviors (immediate hit, empty-timeout,
 * reset, session filter, long-poll wake, disconnect cancel) are exercised against
 * the real IdleFeed since the route is a thin adapter over it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseIdleQuery } from '../../src/routes/idle.js';
import { IdleFeed } from '../../src/idle-feed.js';

describe('parseIdleQuery', () => {
  it('absent after ⇒ undefined; valid after parsed; wait coerced', () => {
    expect(parseIdleQuery({})).toEqual({ after: undefined, session: undefined, wait: 0 });
    expect(parseIdleQuery({ after: '0' })).toEqual({ after: 0, session: undefined, wait: 0 });
    expect(parseIdleQuery({ after: '7', session: 'S', wait: '5000' })).toEqual({ after: 7, session: 'S', wait: 5000 });
  });

  it('garbage after/wait ⇒ safe defaults', () => {
    expect(parseIdleQuery({ after: 'abc', wait: '-3' })).toEqual({ after: undefined, session: undefined, wait: 0 });
  });
});

describe('idle route behaviors (over the real feed)', () => {
  let feed: IdleFeed;
  beforeEach(() => { feed = new IdleFeed(); });

  it('immediate hit: after < head returns events without waiting', async () => {
    feed.append('A', 'r1', 'interactive');
    feed.append('A', 'r2', 'interactive');
    const r = await feed.read({ after: 0, wait: 30_000 });
    expect(r.events.map(e => e.seq)).toEqual([1, 2]);
  });

  it('session filter narrows returned events', async () => {
    feed.append('A', 'a', 'interactive');
    feed.append('B', 'b', 'interactive');
    const r = await feed.read({ after: 0, session: 'B', wait: 0 });
    expect(r.events.map(e => e.sessionId)).toEqual(['B']);
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('empty-timeout: parks then resolves empty with the same cursor', async () => {
      feed.append('A', 'r1', 'interactive');
      const p = feed.read({ after: 1, wait: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await p).toMatchObject({ events: [], cursor: 1, reset: false });
    });

    it('long-poll wake: a concurrent append resolves the parked read', async () => {
      const p = feed.read({ after: 0, wait: 30_000 });
      feed.append('A', 'r1', 'interactive');
      expect((await p).events.map(e => e.seq)).toEqual([1]);
    });

    it('disconnect cancel: aborting the signal resolves early and drops the waiter', async () => {
      const ac = new AbortController();
      const p = feed.read({ after: 0, wait: 30_000, signal: ac.signal });
      ac.abort();
      const r = await p;
      expect(r.events).toEqual([]);
      // A later append must not try to resolve the (already-settled) waiter.
      expect(() => feed.append('A', 'r', 'interactive')).not.toThrow();
    });
  });
});
