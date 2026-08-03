import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ActivityVersion,
  PAGER_WAIT_CAP_MS,
  PAGER_WAITER_CAP,
  PAGER_COALESCE_MS,
} from '../../src/activity-version.js';

let av: ActivityVersion;

beforeEach(() => {
  av = new ActivityVersion();
});

describe('ActivityVersion.read — immediate vs parked', () => {
  it('answers immediately when the caller is behind', async () => {
    av.bump();
    await vi.waitFor(() => expect(av.version).toBe(1));
    const start = Date.now();
    const r = await av.read({ since: 0, wait: 5000 });
    expect(r.version).toBe(1);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('answers immediately when since is absent', async () => {
    const start = Date.now();
    await av.read({ wait: 5000 });
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('answers immediately when wait is 0 even if caught up', async () => {
    const start = Date.now();
    const r = await av.read({ since: av.version, wait: 0 });
    expect(r.version).toBe(av.version);
    expect(Date.now() - start).toBeLessThan(200);
  });

  it('parks when caught up and resolves on the next bump', async () => {
    const pending = av.read({ since: av.version, wait: 5000 });
    let settled = false;
    void pending.then(() => { settled = true; });

    await new Promise(r => setTimeout(r, 50));
    expect(settled).toBe(false); // proves it actually parked

    av.bump();
    const r = await pending;
    expect(r.version).toBe(1);
  });

  it('resolves a parked read on timeout with the unchanged version', async () => {
    const r = await av.read({ since: av.version, wait: 120 });
    expect(r.version).toBe(av.version);
  });

  // The counter restarts at 0 when the server restarts, so a client holding a
  // pre-restart version must not hang for the full cap waiting for a version
  // that will not come back.
  it('answers immediately when since is ahead of the counter (restart)', async () => {
    const start = Date.now();
    const r = await av.read({ since: 9999, wait: 5000 });
    expect(r.version).toBe(0);
    expect(Date.now() - start).toBeLessThan(200);
  });
});

describe('ActivityVersion.read — bounds', () => {
  it('caps the hold at PAGER_WAIT_CAP_MS', async () => {
    // Asserted through the clamp seam rather than by waiting 10s.
    expect(av.clampWait(60_000)).toBe(PAGER_WAIT_CAP_MS);
    expect(av.clampWait(PAGER_WAIT_CAP_MS + 1)).toBe(PAGER_WAIT_CAP_MS);
    expect(av.clampWait(500)).toBe(500);
    expect(av.clampWait(0)).toBe(0);
    expect(av.clampWait(-5)).toBe(0);
    expect(av.clampWait(undefined)).toBe(0);
  });

  it('answers immediately past the waiter cap instead of accumulating waiters', async () => {
    const parked = Array.from({ length: PAGER_WAITER_CAP }, () => av.read({ since: av.version, wait: 5000 }));
    expect(av.waiterCount).toBe(PAGER_WAITER_CAP);

    const start = Date.now();
    await av.read({ since: av.version, wait: 5000 }); // the (cap+1)th
    expect(Date.now() - start).toBeLessThan(200);

    av.bump();
    await Promise.all(parked);
    expect(av.waiterCount).toBe(0);
  });
});

describe('ActivityVersion.read — abort', () => {
  it('settles a parked read when the signal aborts, leaving no waiter or timer', async () => {
    const controller = new AbortController();
    const pending = av.read({ since: av.version, wait: 5000, signal: controller.signal });
    expect(av.waiterCount).toBe(1);

    controller.abort();
    const r = await pending;

    expect(r.version).toBe(av.version);
    expect(av.waiterCount).toBe(0);
    expect(av.pendingTimerCount).toBe(0);
  });

  it('answers immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await av.read({ since: av.version, wait: 5000, signal: controller.signal });
    expect(Date.now() - start).toBeLessThan(200);
    expect(av.waiterCount).toBe(0);
  });
});

describe('ActivityVersion.bump — coalescing', () => {
  it('settles parked readers once for a burst inside the coalesce window', async () => {
    let wakes = 0;
    const pending = av.read({ since: av.version, wait: 5000 }).then(r => { wakes++; return r; });

    for (let i = 0; i < 25; i++) av.bump();

    const r = await pending;
    expect(wakes).toBe(1);
    // Every bump still counts — coalescing delays the WAKE, it does not drop
    // versions, or a reader could be handed a version it had already seen.
    expect(r.version).toBe(25);
    expect(av.version).toBe(25);
  });

  it('wakes again for a bump after the window has elapsed', async () => {
    const first = av.read({ since: av.version, wait: 5000 });
    av.bump();
    const a = await first;

    const second = av.read({ since: a.version, wait: 5000 });
    await new Promise(r => setTimeout(r, PAGER_COALESCE_MS + 40));
    av.bump();
    const b = await second;

    expect(b.version).toBeGreaterThan(a.version);
  });

  it('does not delay a reader that is already behind', async () => {
    av.bump();
    const start = Date.now();
    await av.read({ since: 0, wait: 5000 });
    // A behind reader is served from the scan, never through the coalesce timer.
    expect(Date.now() - start).toBeLessThan(PAGER_COALESCE_MS);
  });
});
