/**
 * idle-feed reference-impl oracle (spec-idle-notifications Plan 1).
 *
 * A scripted sequence of appends/reads is checked against an INDEPENDENTLY
 * computed expectation (a plain array + a hand-derived reset rule), not against
 * the feed's own internals — so a bug in the ring/cursor/reset logic cannot also
 * satisfy the oracle. Long-poll wake + timeout use fake timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  IdleFeed,
  IDLE_RING_CAP,
  IDLE_WAIT_CAP_MS,
  IDLE_RESPONSE_CAP,
  type IdleEvent,
} from '../../src/idle-feed.js';

/** Compare only the deterministic fields (idleAt is wall-clock). */
function shape(e: IdleEvent) {
  return {
    seq: e.seq,
    sessionId: e.sessionId,
    response: e.response,
    truncated: e.truncated,
    kind: e.kind,
    correlationId: e.correlationId,
  };
}

describe('IdleFeed', () => {
  let feed: IdleFeed;

  beforeEach(() => { feed = new IdleFeed(); });

  describe('append + monotonic seq', () => {
    it('assigns a monotonic global seq across sessions and records fields', () => {
      const a = feed.append('A', 'ra', 'interactive', 'corr-1');
      const b = feed.append('B', 'rb', 'interactive');
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(2);
      expect(shape(a)).toEqual({ seq: 1, sessionId: 'A', response: 'ra', truncated: false, kind: 'interactive', correlationId: 'corr-1' });
      expect(shape(b)).toEqual({ seq: 2, sessionId: 'B', response: 'rb', truncated: false, kind: 'interactive', correlationId: undefined });
    });

    it('caps the stored response and flags truncated', () => {
      const big = 'x'.repeat(IDLE_RESPONSE_CAP + 100);
      const e = feed.append('A', big, 'interactive');
      expect(e.truncated).toBe(true);
      expect(e.response.length).toBe(IDLE_RESPONSE_CAP);
    });
  });

  describe('read cursor semantics', () => {
    it('after absent starts at head (no history replay)', async () => {
      feed.append('A', 'r1', 'interactive');
      feed.append('A', 'r2', 'interactive');
      const r = await feed.read({ wait: 0 });
      expect(r.cursor).toBe(2);
      expect(r.events).toEqual([]);
      expect(r.reset).toBe(false);
    });

    it('after=0 replays all retained', async () => {
      feed.append('A', 'r1', 'interactive');
      feed.append('B', 'r2', 'interactive');
      const r = await feed.read({ after: 0, wait: 0 });
      expect(r.events.map(shape)).toEqual([
        { seq: 1, sessionId: 'A', response: 'r1', truncated: false, kind: 'interactive', correlationId: undefined },
        { seq: 2, sessionId: 'B', response: 'r2', truncated: false, kind: 'interactive', correlationId: undefined },
      ]);
      expect(r.cursor).toBe(2);
      expect(r.reset).toBe(false);
    });

    it('returns only events strictly after the cursor', async () => {
      feed.append('A', 'r1', 'interactive');
      feed.append('A', 'r2', 'interactive');
      feed.append('A', 'r3', 'interactive');
      const r = await feed.read({ after: 1, wait: 0 });
      expect(r.events.map(e => e.seq)).toEqual([2, 3]);
      expect(r.cursor).toBe(3);
    });

    it('a missed idle between reads returns immediately on the next read (no hang)', async () => {
      feed.append('A', 'r1', 'interactive');
      const first = await feed.read({ after: 0, wait: 0 });
      expect(first.cursor).toBe(1);
      // idle happens while the client is away
      feed.append('B', 'r2', 'interactive');
      const second = await feed.read({ after: first.cursor, wait: 30_000 });
      expect(second.events.map(e => e.seq)).toEqual([2]);
      expect(second.cursor).toBe(2);
    });
  });

  describe('session filter', () => {
    it('returns and counts only the filtered session, cursor still global', async () => {
      feed.append('A', 'a1', 'interactive');
      feed.append('B', 'b1', 'interactive');
      feed.append('A', 'a2', 'interactive');
      const r = await feed.read({ after: 0, session: 'A', wait: 0 });
      expect(r.events.map(e => [e.seq, e.sessionId])).toEqual([[1, 'A'], [3, 'A']]);
      expect(r.cursor).toBe(3);
    });
  });

  describe('reset (eviction + restart)', () => {
    it('unfiltered read below the retained window resets', async () => {
      // Overflow the ring so early seqs are evicted.
      for (let i = 0; i < IDLE_RING_CAP + 5; i++) feed.append('A', `r${i}`, 'interactive');
      const head = IDLE_RING_CAP + 5;
      const oldest = head - IDLE_RING_CAP + 1; // first retained seq
      // A cursor below the retained window has provably missed events.
      const r = await feed.read({ after: oldest - 2, wait: 0 });
      expect(r.reset).toBe(true);
    });

    it('a cursor beyond head (restart) resets', async () => {
      feed.append('A', 'r1', 'interactive');
      const r = await feed.read({ after: 99, wait: 0 });
      expect(r.reset).toBe(true);
    });

    it('noisy neighbor: a filtered reader caught up on its own session is NOT reset by another session evicting the window', async () => {
      // A idles once early, then B floods and evicts everything below the window.
      const aEvent = feed.append('A', 'a1', 'interactive'); // seq 1
      for (let i = 0; i < IDLE_RING_CAP + 5; i++) feed.append('B', `b${i}`, 'interactive');
      // A-observer is caught up on A (after === A's last seq), even though seq 1
      // is long evicted and after is far below the retained window.
      const r = await feed.read({ after: aEvent.seq, session: 'A', wait: 0 });
      expect(r.reset).toBe(false);
      expect(r.events).toEqual([]);
      expect(r.cursor).toBe(IDLE_RING_CAP + 6);
    });

    it('filtered reader that DID miss one of its own events resets', async () => {
      feed.append('A', 'a1', 'interactive');           // seq 1 (will be evicted)
      for (let i = 0; i < IDLE_RING_CAP + 5; i++) feed.append('B', `b${i}`, 'interactive');
      feed.append('A', 'a2', 'interactive');           // recent A event, retained
      // Observer's cursor (0) is below A's last seq AND below the retained window
      // → it may have missed A@1 → reset.
      const r = await feed.read({ after: 0, session: 'A', wait: 0 });
      expect(r.reset).toBe(true);
    });
  });

  describe('long-poll', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('parks when caught up, then wakes on a matching append', async () => {
      const p = feed.read({ after: 0, wait: 30_000 });
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      feed.append('A', 'r1', 'interactive');
      const r = await p;
      expect(r.events.map(e => e.seq)).toEqual([1]);
      expect(r.cursor).toBe(1);
    });

    it('a session-filtered waiter is NOT woken by an unrelated session', async () => {
      const p = feed.read({ after: 0, session: 'A', wait: 30_000 });
      let settled = false;
      void p.then(() => { settled = true; });
      feed.append('B', 'rb', 'interactive');
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      feed.append('A', 'ra', 'interactive');
      const r = await p;
      expect(r.events.map(e => e.sessionId)).toEqual(['A']);
    });

    it('resolves empty on timeout with an unchanged cursor', async () => {
      feed.append('A', 'r1', 'interactive');
      const p = feed.read({ after: 1, wait: 5_000 });
      await vi.advanceTimersByTimeAsync(5_000);
      const r = await p;
      expect(r.events).toEqual([]);
      expect(r.cursor).toBe(1);
    });

    it('caps the wait at IDLE_WAIT_CAP_MS', async () => {
      const p = feed.read({ after: 0, wait: 10 * 60 * 1000 });
      let settled = false;
      void p.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(IDLE_WAIT_CAP_MS);
      expect(settled).toBe(true);
    });
  });
});
