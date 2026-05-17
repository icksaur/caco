/**
 * Tests for src/watch-store.ts
 *
 * Uses real fs.watch against tmpdir files. Coalesce + TTL paths use fake timers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createWatchStore, type ChangeEvent, type WatchStore } from '../../src/watch-store.js';

function captureBroadcaster() {
  const events: ChangeEvent[] = [];
  const waiters: Array<{ filter: (e: ChangeEvent) => boolean; resolve: () => void }> = [];
  return {
    events,
    broadcast: (ev: ChangeEvent) => {
      events.push(ev);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].filter(ev)) {
          waiters[i].resolve();
          waiters.splice(i, 1);
        }
      }
    },
    /** Wait until at least one event matching `filter` arrives. Times out
     *  after `timeoutMs` to keep tests from hanging on real failures. */
    waitFor: (filter: (e: ChangeEvent) => boolean, timeoutMs = 1000): Promise<void> => {
      // Already there?
      if (events.some(filter)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry = { filter, resolve };
        waiters.push(entry);
        setTimeout(() => {
          const i = waiters.indexOf(entry);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`waitFor timeout after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      });
    },
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('createWatchStore', () => {
  let tmp: string;
  let store: WatchStore | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'caco-watch-test-'));
  });

  afterEach(() => {
    if (store) {
      store.shutdown();
      store = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('acquire', () => {
    it('acquires a lease on an existing file', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p = join(tmp, 'a.txt');
      writeFileSync(p, 'hello');

      const result = store.acquireLease('sess-1', p);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.scope).toBe('file');
      expect(result.leaseId).toMatch(/^lease-/);
      expect(result.path).toBe(p);
    });

    it('infers dir scope for a directory', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const result = store.acquireLease('sess-1', tmp);
      if (!result.ok) throw new Error('expected ok');
      expect(result.scope).toBe('dir');
    });

    it('honors explicit scope override', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p = join(tmp, 'b.txt');
      writeFileSync(p, '');
      const result = store.acquireLease('sess-1', p, 'file');
      if (!result.ok) throw new Error('expected ok');
      expect(result.scope).toBe('file');
    });

    it('returns path-not-found for a missing path', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const result = store.acquireLease('sess-1', join(tmp, 'nope.txt'));
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('path-not-found');
    });

    it('returns lease-cap when the process cap is exceeded', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0, leaseCap: 2 });
      const p1 = join(tmp, 'c1.txt'); writeFileSync(p1, '');
      const p2 = join(tmp, 'c2.txt'); writeFileSync(p2, '');
      const p3 = join(tmp, 'c3.txt'); writeFileSync(p3, '');

      expect(store.acquireLease('s', p1).ok).toBe(true);
      expect(store.acquireLease('s', p2).ok).toBe(true);
      const third = store.acquireLease('s', p3);
      expect(third.ok).toBe(false);
      if (third.ok) throw new Error('unreachable');
      expect(third.reason).toBe('lease-cap');
    });

    it('shares a single watcher when two leases target the same path', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p = join(tmp, 'shared.txt'); writeFileSync(p, '');

      const a = store.acquireLease('s1', p);
      const b = store.acquireLease('s2', p);
      expect(a.ok && b.ok).toBe(true);
      // Internal: one path entry, two leases attached.
      expect(store._state.paths.size).toBe(1);
      expect(store._state.leases.size).toBe(2);
      const entry = store._state.paths.values().next().value;
      expect(entry?.leases.size).toBe(2);
    });

    it('canonicalizes paths so symlink and target share a watcher', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const target = join(tmp, 'real.txt'); writeFileSync(target, '');
      const link = join(tmp, 'link.txt');
      // symlinkSync may fail without permission on some systems; skip if so.
      try {
        const { symlinkSync } = require('fs') as typeof import('fs');
        symlinkSync(target, link);
      } catch {
        return; // platform doesn't allow symlinks unprivileged; ignore.
      }

      const a = store.acquireLease('s', target);
      const b = store.acquireLease('s', link);
      expect(a.ok && b.ok).toBe(true);
      expect(store._state.paths.size).toBe(1); // shared watcher
    });
  });

  describe('release', () => {
    it('release of last lease closes the watcher', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p = join(tmp, 'r.txt'); writeFileSync(p, '');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      store.releaseLease(a.leaseId);
      expect(store._state.leases.size).toBe(0);
      expect(store._state.paths.size).toBe(0);
    });

    it('release of one lease keeps watcher alive for the other', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p = join(tmp, 'r2.txt'); writeFileSync(p, '');
      const a = store.acquireLease('s', p);
      const b = store.acquireLease('s', p);
      if (!a.ok || !b.ok) throw new Error('expected ok');

      store.releaseLease(a.leaseId);
      expect(store._state.paths.size).toBe(1);
      expect(store._state.leases.size).toBe(1);
    });

    it('releaseSession drops all of a session\'s leases', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p1 = join(tmp, 'rs1.txt'); writeFileSync(p1, '');
      const p2 = join(tmp, 'rs2.txt'); writeFileSync(p2, '');

      store.acquireLease('sess-a', p1);
      store.acquireLease('sess-a', p2);
      store.acquireLease('sess-b', p1);
      expect(store._state.leases.size).toBe(3);

      store.releaseSession('sess-a');
      expect(store._state.leases.size).toBe(1);
      // p2 was only held by sess-a — watcher closed. p1 still held by sess-b.
      expect(store._state.paths.size).toBe(1);
    });

    it('releaseLease is idempotent', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      store.releaseLease('lease-nonexistent');
      expect(store._state.leases.size).toBe(0);
    });
  });

  describe('renew', () => {
    it('renewing extends the TTL', () => {
      const { broadcast } = captureBroadcaster();
      let t = 1_000_000;
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0, now: () => t, ttlMs: 5000 });
      const p = join(tmp, 'rn.txt'); writeFileSync(p, '');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      const before = store._state.leases.get(a.leaseId)!.expiresAt;
      t += 1000;
      const r = store.renewLease(a.leaseId);
      expect(r.ok).toBe(true);
      const after = store._state.leases.get(a.leaseId)!.expiresAt;
      expect(after).toBeGreaterThan(before);
    });

    it('returns unknown-lease for missing leaseId', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const r = store.renewLease('lease-bogus');
      expect(r.ok).toBe(false);
    });
  });

  describe('expireDue', () => {
    it('expires leases past their TTL and closes their watchers', () => {
      const { broadcast } = captureBroadcaster();
      let t = 1_000_000;
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0, now: () => t, ttlMs: 1000 });
      const p = join(tmp, 'e.txt'); writeFileSync(p, '');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      t += 500;
      expect(store.expireDue()).toBe(0);
      expect(store._state.leases.size).toBe(1);

      t += 600; // total elapsed: 1100ms, past 1000ms ttl
      expect(store.expireDue()).toBe(1);
      expect(store._state.leases.size).toBe(0);
      expect(store._state.paths.size).toBe(0);
    });
  });

  describe('listLeases', () => {
    it('lists only the given session\'s leases', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p1 = join(tmp, 'l1.txt'); writeFileSync(p1, '');
      const p2 = join(tmp, 'l2.txt'); writeFileSync(p2, '');
      store.acquireLease('sess-a', p1);
      store.acquireLease('sess-b', p2);

      expect(store.listLeases('sess-a').length).toBe(1);
      expect(store.listLeases('sess-b').length).toBe(1);
      expect(store.listLeases('sess-a')[0].path).toBe(p1);
    });
  });

  describe('events', () => {
    it('broadcasts a change event when a watched file is written', async () => {
      const cap = captureBroadcaster();
      store = createWatchStore({ broadcast: cap.broadcast, expiryScanIntervalMs: 0, coalesceMs: 20 });
      const p = join(tmp, 'w.txt'); writeFileSync(p, 'a');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      writeFileSync(p, 'b');
      await cap.waitFor(e => e.leaseId === a.leaseId);

      expect(cap.events[0].leaseId).toBe(a.leaseId);
      expect(cap.events[0].path).toBe(p);
      expect(cap.events[0].eventType === 'change' || cap.events[0].eventType === 'rename').toBe(true);
    });

    it('coalesces rapid writes into one broadcast per leaseId', async () => {
      const cap = captureBroadcaster();
      store = createWatchStore({ broadcast: cap.broadcast, expiryScanIntervalMs: 0, coalesceMs: 30 });
      const p = join(tmp, 'cc.txt'); writeFileSync(p, '');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      writeFileSync(p, '1');
      writeFileSync(p, '2');
      writeFileSync(p, '3');
      await cap.waitFor(e => e.leaseId === a.leaseId);
      // Drain any straggler events that arrive within the coalesce window
      // after the first broadcast (separate write bursts can fire again).
      await sleep(50);

      expect(cap.events.filter(e => e.leaseId === a.leaseId).length).toBeLessThanOrEqual(2);
    });
  });

  describe('save-and-replace re-attach', () => {
    it('re-attaches the watcher and emits change when the file is renamed-over', async () => {
      const cap = captureBroadcaster();
      store = createWatchStore({
        broadcast: cap.broadcast,
        expiryScanIntervalMs: 0,
        coalesceMs: 15,
        reattachDelayMs: 15,
      });
      const p = join(tmp, 'sar.txt'); writeFileSync(p, 'v1');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      // Simulate vim-style: write temp, rename over original.
      const tmpFile = join(tmp, '.sar.swp');
      writeFileSync(tmpFile, 'v2');
      renameSync(tmpFile, p);

      // Wait for the re-attach to emit its single change event.
      await cap.waitFor(e => e.leaseId === a.leaseId);

      // Trigger a write on the re-attached watcher; if re-attach worked we get
      // a fresh event.
      cap.events.length = 0;
      writeFileSync(p, 'v3');
      await cap.waitFor(e => e.leaseId === a.leaseId);

      expect(cap.events[0].leaseId).toBe(a.leaseId);
    });

    it('emits rename if the file is genuinely deleted (no re-attach target)', async () => {
      const cap = captureBroadcaster();
      store = createWatchStore({
        broadcast: cap.broadcast,
        expiryScanIntervalMs: 0,
        coalesceMs: 15,
        reattachDelayMs: 15,
      });
      const p = join(tmp, 'del.txt'); writeFileSync(p, '');
      const a = store.acquireLease('s', p);
      if (!a.ok) throw new Error('expected ok');

      unlinkSync(p);
      // Wait for a rename event (the re-attach branch confirms the file is
      // gone and emits it).
      await cap.waitFor(e => e.leaseId === a.leaseId && e.eventType === 'rename');

      const ours = cap.events.filter(e => e.leaseId === a.leaseId);
      expect(ours.length).toBeGreaterThan(0);
      expect(ours.some(e => e.eventType === 'rename')).toBe(true);
    });
  });

  describe('dir scope', () => {
    it('broadcasts on child create/delete in the watched directory', async () => {
      const cap = captureBroadcaster();
      store = createWatchStore({ broadcast: cap.broadcast, expiryScanIntervalMs: 0, coalesceMs: 20 });
      const sub = join(tmp, 'sub'); mkdirSync(sub);
      const a = store.acquireLease('s', sub);
      if (!a.ok) throw new Error('expected ok');
      expect(a.scope).toBe('dir');

      writeFileSync(join(sub, 'new.txt'), '');
      await cap.waitFor(e => e.leaseId === a.leaseId);
    });
  });

  describe('shutdown', () => {
    it('closes all watchers and clears state', () => {
      const { broadcast } = captureBroadcaster();
      store = createWatchStore({ broadcast, expiryScanIntervalMs: 0 });
      const p1 = join(tmp, 's1.txt'); writeFileSync(p1, '');
      const p2 = join(tmp, 's2.txt'); writeFileSync(p2, '');
      store.acquireLease('s', p1);
      store.acquireLease('s', p2);
      expect(store._state.leases.size).toBe(2);

      store.shutdown();
      expect(store._state.leases.size).toBe(0);
      expect(store._state.paths.size).toBe(0);
      // Setting store=null in afterEach is now a no-op shutdown.
      store = null;
    });
  });
});

// Unused-variable suppression for the vi import
void vi;
