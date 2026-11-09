import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWakeManager, type WakeConfig } from '../../src/wake-manager.js';
import type { SessionMeta } from '../../src/session-meta-store.js';
import { parseWakeWindow } from '../../src/wake-core.js';

const H = 60 * 60 * 1000;
const D = 24 * H;
const START = Date.parse('2026-11-09T16:00:00Z'); // Monday

function setup(over: Partial<WakeConfig> = {}) {
  let now = START;
  const metas = new Map<string, SessionMeta>();
  const busy = new Set<string>();
  const post = vi.fn(async (_id: string, _prompt: string) => 200);
  const markUnobserved = vi.fn();
  let disabled = false;
  const mgr = createWakeManager({
    now: () => now,
    listSessionIds: () => [...metas.keys()],
    getMeta: id => (metas.has(id) ? structuredClone(metas.get(id)!) : undefined),
    updateMeta: (id, mutate) => {
      const m = metas.get(id);
      if (!m) return false;
      const copy = structuredClone(m);
      mutate(copy);
      metas.set(id, JSON.parse(JSON.stringify(copy)));
      return true;
    },
    isBusy: id => busy.has(id),
    post,
    markUnobserved,
    toolDisabled: () => disabled,
    config: {
      minHours: 1, maxHours: 24, noteMax: 200, maxActive: 20, maxRunning: 2, maxFailures: 3,
      humanQuietMs: 30 * 60 * 1000, expireMs: 7 * D, turnTimeoutMs: 2 * H, window: null,
      archiveFolder: 'auto-archive', ...over,
    },
  });
  const addSession = (id: string, meta: Partial<SessionMeta> = {}) => {
    metas.set(id, { name: id, lastUsedAt: new Date(now - 2 * H).toISOString(), ...meta });
  };
  return {
    mgr, metas, busy, post, markUnobserved,
    addSession,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    disable: () => { disabled = true; },
    wake: (id: string) => metas.get(id)?.wake,
  };
}

describe('caco_wake set/clear (A1, A2, A13)', () => {
  it('set stores the wake; set again replaces it and keeps registeredAt', () => {
    const t = setup();
    t.addSession('a');
    expect(t.mgr.set('a', 4, 'waiting on PR')).toMatchObject({ ok: true });
    const first = t.wake('a')!;
    expect(first).toMatchObject({ everyMinutes: 240, note: 'waiting on PR', consecutiveFailures: 0 });
    expect(Date.parse(first.nextWakeAt)).toBe(START + 4 * H);
    t.advance(H);
    t.mgr.set('a', 2);
    const second = t.wake('a')!;
    expect(second.everyMinutes).toBe(120);
    expect(second.note).toBeUndefined();
    expect(second.registeredAt).toBe(first.registeredAt);
    expect(t.mgr.list()).toHaveLength(1);
  });

  it.each([0, 25, 1.5, '4'])('rejects everyHours=%s without writing', (h) => {
    const t = setup();
    t.addSession('a');
    const r = t.mgr.set('a', h);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('1 to 24');
    expect(t.wake('a')).toBeUndefined();
  });

  it('rejects a note over 200 characters', () => {
    const t = setup();
    t.addSession('a');
    expect(t.mgr.set('a', 2, 'x'.repeat(201))).toMatchObject({ ok: false });
  });

  it('enforces the global cap, not counting paused wakes or the caller', () => {
    const t = setup({ maxActive: 2 });
    for (const id of ['a', 'b', 'c', 'd']) t.addSession(id);
    expect(t.mgr.set('a', 1).ok).toBe(true);
    expect(t.mgr.set('b', 1).ok).toBe(true);
    expect(t.mgr.set('c', 1)).toMatchObject({ ok: false });
    expect(t.mgr.set('b', 3).ok).toBe(true); // replacing your own does not count
    t.metas.get('a')!.wake!.pausedReason = 'failures';
    t.mgr.refresh('a');
    expect(t.mgr.set('c', 1).ok).toBe(true);
  });

  it('clear removes the wake and reports whether one existed', () => {
    const t = setup();
    t.addSession('a');
    t.mgr.set('a', 1);
    expect(t.mgr.clear('a')).toBe(true);
    expect(t.wake('a')).toBeUndefined();
    expect(t.mgr.clear('a')).toBe(false);
  });
});

describe('wake loop', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
    t.addSession('a');
    t.mgr.set('a', 1, 'waiting on PR');
  });

  it('does not fire before it is due', async () => {
    t.advance(30 * 60 * 1000);
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
  });

  it('fires a due wake with the wake prompt and marks it running (A4)', async () => {
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(1);
    const prompt = t.post.mock.calls[0][1];
    expect(prompt).toContain('Scheduled wake. Local time');
    expect(prompt).toContain('Registered 1h 0m ago.');
    expect(prompt).toContain('Note: waiting on PR');
    expect(prompt).toContain('action "clear"');
    const w = t.wake('a')!;
    expect(w.lastResult).toBe('running');
    expect(Date.parse(w.lastWakeAt!)).toBe(t.now());
    expect(Date.parse(w.nextWakeAt)).toBe(t.now() + H);
  });

  it('a busy or human-recent session defers without advancing nextWakeAt; fires once clear (A5)', async () => {
    t.advance(H);
    const due = t.wake('a')!.nextWakeAt;
    t.busy.add('a');
    await t.mgr.tick();
    t.busy.delete('a');
    t.metas.get('a')!.lastUsedAt = new Date(t.now() - 5 * 60 * 1000).toISOString();
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
    expect(t.wake('a')!.nextWakeAt).toBe(due);
    expect(t.wake('a')!.consecutiveFailures).toBe(0);
    t.advance(30 * 60 * 1000);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(1);
  });

  it('a 409 is a deferral: nothing advances and it is not a failure', async () => {
    t.advance(H);
    const before = t.wake('a')!;
    t.post.mockResolvedValueOnce(409);
    await t.mgr.tick();
    expect(t.wake('a')).toEqual(before);
  });

  it('settles at the real end of the turn, keyed by session (A9, A10)', async () => {
    t.advance(H);
    await t.mgr.tick();
    expect(t.wake('a')!.lastResult).toBe('running');
    t.mgr.settle('other', 'ok');
    expect(t.wake('a')!.lastResult).toBe('running');
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')!.lastResult).toBe('ok');
    t.mgr.settle('a', 'error', 'late'); // not running any more: ignored
    expect(t.wake('a')!.lastResult).toBe('ok');
  });

  it('a non-2xx POST is a failed wake', async () => {
    t.advance(H);
    t.post.mockResolvedValueOnce(500);
    await t.mgr.tick();
    expect(t.wake('a')).toMatchObject({ lastResult: 'error', lastError: 'HTTP 500', consecutiveFailures: 1 });
  });

  it('three consecutive failures pause the wake and mark the session unobserved (A11)', async () => {
    for (let i = 0; i < 3; i++) {
      t.advance(H);
      await t.mgr.tick();
      t.mgr.settle('a', 'error', 'session.error');
    }
    expect(t.wake('a')).toMatchObject({ pausedReason: 'failures', consecutiveFailures: 3 });
    expect(t.markUnobserved).toHaveBeenCalledWith('a');
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(3);
  });

  it('a success resets the failure count', async () => {
    t.advance(H); await t.mgr.tick(); t.mgr.settle('a', 'error');
    t.advance(H); await t.mgr.tick(); t.mgr.settle('a', 'ok');
    expect(t.wake('a')!.consecutiveFailures).toBe(0);
  });

  it("a user's Stop is recorded as cancelled and never counts toward the failure pause", async () => {
    t.advance(H); await t.mgr.tick(); t.mgr.settle('a', 'error', 'session.error');
    for (let i = 0; i < 3; i++) {
      t.advance(H); await t.mgr.tick();
      t.mgr.settle('a', 'cancelled', 'stopped by user');
      t.mgr.settle('a', 'error', 'session.error'); // the abort's own teardown: already settled
    }
    expect(t.wake('a')).toMatchObject({ lastResult: 'cancelled', consecutiveFailures: 1 });
    expect(t.wake('a')!.pausedReason).toBeUndefined();
    expect(t.markUnobserved).not.toHaveBeenCalled();
  });

  it('a running wake past the turn timeout is recorded as failed', async () => {
    t.advance(H);
    await t.mgr.tick();
    t.advance(2 * H + 1);
    t.busy.add('a'); // keep the now-due next wake from firing in the same tick
    await t.mgr.tick();
    expect(t.wake('a')).toMatchObject({ lastError: 'no idle within timeout', consecutiveFailures: 1 });
  });

  it('a session staged for archive has its wake cleared, not fired (A8)', async () => {
    t.metas.get('a')!.folder = 'auto-archive';
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
    expect(t.wake('a')).toBeUndefined();
    expect(t.mgr.list()).toHaveLength(0);
  });

  it('does nothing while caco_wake is hard-disabled', async () => {
    t.disable();
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
  });
});

describe('concurrency cap (D)', () => {
  it('fires at most maxRunning wakes; the rest wait for a settle without advancing', async () => {
    const t = setup();
    for (const id of ['a', 'b', 'c']) { t.addSession(id); t.mgr.set(id, 1); }
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(2);
    const waiting = ['a', 'b', 'c'].find(id => t.wake(id)!.lastResult !== 'running')!;
    const due = t.wake(waiting)!.nextWakeAt;
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(2);
    expect(t.wake(waiting)!.nextWakeAt).toBe(due);
    const fired = ['a', 'b', 'c'].find(id => t.wake(id)!.lastResult === 'running')!;
    t.mgr.settle(fired, 'ok');
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(3);
    expect(t.post.mock.calls[2][0]).toBe(waiting);
  });
});

describe('active hours (A7)', () => {
  it('a wake due on Saturday fires once at Monday window start', async () => {
    const t = setup({ window: parseWakeWindow('Mon-Fri 07:00-19:00 UTC') });
    t.advance(-2 * D - 4 * H); // Saturday 2026-11-07 12:00Z
    t.addSession('a');
    t.mgr.set('a', 1);
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
    expect(t.wake('a')!.nextWakeAt).toBe('2026-11-09T07:00:00.000Z');
    t.advance(D); // Sunday: still closed, not yet due anyway
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
    while (t.now() < Date.parse('2026-11-09T07:00:00Z')) { t.advance(5 * 60 * 1000); await t.mgr.tick(); }
    expect(t.post).toHaveBeenCalledTimes(1);
  });
});

describe('expiry with a final wake (B, C, A12)', () => {
  it('fires one final wake, then pauses expired and marks the session unobserved', async () => {
    const t = setup();
    t.addSession('a');
    t.mgr.set('a', 24);
    t.advance(7 * D);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(1);
    expect(t.post.mock.calls[0][1]).toContain('FINAL wake');
    expect(t.wake('a')!.finalWakeAt).toBeDefined();
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')).toMatchObject({ pausedReason: 'expired', lastResult: 'ok' });
    expect(t.markUnobserved).toHaveBeenCalledWith('a');
    t.advance(D);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(1);
  });

  it('the agent re-arming during its final wake does not cancel the pause (B)', async () => {
    const t = setup();
    t.addSession('a');
    t.mgr.set('a', 24);
    t.advance(7 * D);
    await t.mgr.tick();
    t.mgr.set('a', 24, 'refreshed note');
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')).toMatchObject({ pausedReason: 'expired', note: 'refreshed note' });
  });

  it('an agent-only re-arm does not reset expiry: the next due wake is final again', async () => {
    const t = setup();
    t.addSession('a', { lastUsedAt: new Date(START - 8 * D).toISOString() });
    t.mgr.set('a', 1);
    t.advance(H);
    await t.mgr.tick();
    expect(t.post.mock.calls[0][1]).toContain('FINAL wake');
  });

  it('a human renewal (fresh lastUsedAt) plus set re-arms the paused wake', async () => {
    const t = setup();
    t.addSession('a');
    t.mgr.set('a', 24);
    t.advance(7 * D);
    await t.mgr.tick();
    t.mgr.settle('a', 'ok');
    t.metas.get('a')!.lastUsedAt = new Date(t.now()).toISOString();
    t.mgr.set('a', 24);
    expect(t.wake('a')!.pausedReason).toBeUndefined();
    expect(t.wake('a')!.finalWakeAt).toBeUndefined();
    t.advance(D);
    await t.mgr.tick();
    expect(t.post.mock.calls[1][1]).not.toContain('FINAL');
  });
});

describe('boot and import (A14, F)', () => {
  it('rebuild indexes every wake and records a running wake as interrupted', () => {
    const t = setup();
    t.addSession('a', { wake: { everyMinutes: 60, registeredAt: 'x', nextWakeAt: new Date(START).toISOString(), consecutiveFailures: 1, lastResult: 'running' } });
    t.addSession('b', { wake: { everyMinutes: 60, registeredAt: 'x', nextWakeAt: new Date(START).toISOString(), consecutiveFailures: 0 } });
    t.addSession('c');
    t.mgr.rebuild();
    expect(t.mgr.list().map(e => e.sessionId).sort()).toEqual(['a', 'b']);
    expect(t.wake('a')).toMatchObject({ lastResult: 'error', lastError: 'interrupted by restart', consecutiveFailures: 1 });
    expect(t.mgr.runningCount()).toBe(0);
  });

  it('a plain copy import arrives paused; a migration keeps the wake armed', () => {
    const t = setup();
    const w = { everyMinutes: 60, registeredAt: 'x', nextWakeAt: new Date(START).toISOString(), consecutiveFailures: 0 };
    t.addSession('copy', { wake: { ...w } });
    t.addSession('moved', { wake: { ...w, lastResult: 'running' } });
    t.mgr.applyImport('copy', false);
    t.mgr.applyImport('moved', true);
    expect(t.wake('copy')!.pausedReason).toBe('imported');
    expect(t.wake('moved')!.pausedReason).toBeUndefined();
    expect(t.wake('moved')!.lastResult).toBe('error');
    expect(t.mgr.list()).toHaveLength(2);
  });
});
