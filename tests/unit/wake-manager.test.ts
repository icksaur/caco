import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createWakeManager, wakeRetryDelayMs, type WakeConfig } from '../../src/wake-manager.js';
import type { SessionMeta } from '../../src/session-meta-store.js';
import { parseWakeWindow } from '../../src/wake-core.js';
import { appendRun, recordDefer, WAKE_HISTORY_MAX_BYTES } from '../../src/wake-history.js';

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
      minHours: 1, maxHours: 168, noteMax: 200, maxActive: 20, maxRunning: 2, maxFailures: 3,
      humanQuietMs: 30 * 60 * 1000, expireMs: 7 * D, turnTimeoutMs: 2 * H, window: null,
      archiveFolder: 'auto-archive', retryBaseMs: 10 * 60 * 1000, ...over,
    },
    random: () => 0.5,
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

  it('set with at fires first at that time, then every everyHours after it', async () => {
    const t = setup({ window: parseWakeWindow('Mon-Fri 07:00-19:00 UTC') });
    t.addSession('a');
    expect(t.mgr.set('a', 2, 'after standup', '18:00')).toMatchObject({ ok: true });
    expect(t.wake('a')!.nextWakeAt).toBe('2026-11-09T18:00:00.000Z');
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(1);
    expect(t.wake('a')!.nextWakeAt).toBe('2026-11-09T20:00:00.000Z');
  });

  it('set with a bad at fails and writes nothing', () => {
    const t = setup({ window: parseWakeWindow('Mon-Fri 07:00-19:00 UTC') });
    t.addSession('a');
    const r = t.mgr.set('a', 1, undefined, '21:00');
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toMatch(/outside the active wake window/);
    expect(t.mgr.set('a', 0, undefined, '17:00')).toMatchObject({ ok: false });
    expect(t.wake('a')).toBeUndefined();
  });

  it('accepts a weekly cadence', () => {
    const t = setup({ maxHours: 168 });
    t.addSession('a');
    expect(t.mgr.set('a', 168).ok).toBe(true);
    expect(Date.parse(t.wake('a')!.nextWakeAt)).toBe(START + 7 * D);
  });

  it.each([0, 169, 1.5, '4'])('rejects everyHours=%s without writing', (h) => {
    const t = setup();
    t.addSession('a');
    const r = t.mgr.set('a', h);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain('1 to 168');
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

  it('a failed wake retries with backoff, capped at the cadence', async () => {
    const s = setup();
    s.addSession('b');
    s.mgr.set('b', 4);
    s.advance(4 * H);
    await s.mgr.tick();
    s.mgr.settle('b', 'error', 'session.error');
    // random() = 0.5 is no jitter: 10 min after the first failure.
    expect(Date.parse(s.wake('b')!.nextWakeAt)).toBe(s.now() + 10 * 60_000);
    s.advance(10 * 60_000); await s.mgr.tick(); s.mgr.settle('b', 'error', 'session.error');
    expect(Date.parse(s.wake('b')!.nextWakeAt)).toBe(s.now() + 20 * 60_000);
    expect(wakeRetryDelayMs(6, 10 * 60_000, 4 * H, () => 0.5)).toBe(4 * H);
    expect(wakeRetryDelayMs(1, 10 * 60_000, 4 * H, () => 0)).toBe(8 * 60_000);
    expect(wakeRetryDelayMs(1, 10 * 60_000, 4 * H, () => 1)).toBe(12 * 60_000);
  });

  it('a POST that gives up while the turn is still dispatching stays running', async () => {
    t.advance(H);
    t.post.mockImplementationOnce(async () => { t.busy.add('a'); throw new Error('headers timeout'); });
    await t.mgr.tick();
    expect(t.wake('a')).toMatchObject({ lastResult: 'running', consecutiveFailures: 0 });
    t.busy.delete('a');
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')!.lastResult).toBe('ok');
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

  it('a session staged for archive keeps its wake but does not fire, and resumes when moved out (A8)', async () => {
    t.metas.get('a')!.folder = 'auto-archive';
    t.advance(H);
    await t.mgr.tick();
    expect(t.post).not.toHaveBeenCalled();
    expect(t.wake('a')).toBeDefined();
    expect(t.mgr.list()).toHaveLength(1);
    t.metas.get('a')!.folder = undefined;
    await t.mgr.tick();
    expect(t.post).toHaveBeenCalledTimes(1);
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

describe('wake history lifecycle (spec-session-overview O6)', () => {
  let t: ReturnType<typeof setup>;
  const fireOnce = async () => { t.advance(H); await t.mgr.tick(); };
  beforeEach(() => {
    t = setup();
    t.addSession('a');
    t.mgr.set('a', 1);
  });

  it('a fresh set starts empty counters and coverage', () => {
    expect(t.wake('a')).toMatchObject({ slotSeq: 0, counters: { fires: 0, ok: 0, errors: 0, firesSinceHuman: 0 }, historySince: new Date(START).toISOString() });
    expect(t.wake('a')!.history).toBeUndefined();
  });

  it('fire accepted opens a slot with the offer baseline and counts the fire', async () => {
    t.metas.get('a')!.responseOptionsAt = '2026-11-09T10:00:00.000Z';
    const due = t.wake('a')!.nextWakeAt;
    await fireOnce();
    const w = t.wake('a')!;
    expect(w.pendingRun).toEqual({ slot: 1, dueAt: due, firedAt: new Date(t.now()).toISOString(), offerBaseline: '2026-11-09T10:00:00.000Z' });
    expect(w.counters).toMatchObject({ fires: 1, firesSinceHuman: 1 });
    expect(w.history).toBeUndefined();
  });

  it('settle ok records exactly one run; a late second outcome adds nothing', async () => {
    await fireOnce();
    t.advance(60_000);
    t.mgr.settle('a', 'ok');
    t.mgr.settle('a', 'error', 'session.error');
    const w = t.wake('a')!;
    expect(w.history).toHaveLength(1);
    expect(w.history![0]).toMatchObject({ slot: 1, outcome: 'ok', settledAt: new Date(t.now()).toISOString() });
    expect(w.history![0].offered).toBeUndefined();
    expect(w.pendingRun).toBeUndefined();
    expect(w.counters).toMatchObject({ fires: 1, ok: 1, errors: 0, offered: 0 });
    expect(w.lastOkAt).toBe(new Date(t.now()).toISOString());
  });

  it('offered iff responseOptionsAt is newer than the baseline', async () => {
    t.metas.get('a')!.responseOptionsAt = '2026-11-09T10:00:00.000Z';
    await fireOnce();
    t.mgr.settle('a', 'ok'); // offer unchanged
    expect(t.wake('a')!.history![0].offered).toBeUndefined();
    await fireOnce();
    t.metas.get('a')!.responseOptionsAt = new Date(t.now() + 1000).toISOString();
    t.advance(2000);
    t.mgr.settle('a', 'ok');
    const w = t.wake('a')!;
    expect(w.history![1]).toMatchObject({ slot: 2, offered: true });
    expect(w.counters!.offered).toBe(1);
    expect(w.lastOfferedAt).toBe(new Date(t.now()).toISOString());
  });

  it('settle error and cancelled record their outcome and fixed reason', async () => {
    await fireOnce();
    t.mgr.settle('a', 'error', 'session.error');
    await fireOnce();
    t.mgr.settle('a', 'cancelled', 'stopped by user');
    t.mgr.settle('a', 'error', 'session.error'); // the abort's teardown: already settled
    const h = t.wake('a')!.history!;
    expect(h.map(r => [r.slot, r.outcome, r.reason])).toEqual([[1, 'error', 'session.error'], [2, 'cancelled', 'stopped by user']]);
    expect(t.wake('a')!.counters).toMatchObject({ fires: 2, errors: 1, cancelled: 1 });
  });

  it('a transient retry chain is recorded once, with the attempt count', async () => {
    await fireOnce();
    t.mgr.noteRetry('a', 1);
    t.mgr.noteRetry('a', 2);
    expect(t.wake('a')!.history).toBeUndefined();
    t.mgr.settle('a', 'error', 'retry failed');
    const h = t.wake('a')!.history!;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ outcome: 'error', reason: 'retry failed', retries: 2 });
    t.mgr.noteRetry('a', 3); // not running: ignored
    expect(t.wake('a')!.pendingRun).toBeUndefined();
  });

  it('a non-2xx POST records one rejected run', async () => {
    t.post.mockResolvedValueOnce(500);
    await fireOnce();
    const w = t.wake('a')!;
    expect(w.history).toEqual([expect.objectContaining({ slot: 1, outcome: 'rejected', reason: 'HTTP 500' })]);
    expect(w).toMatchObject({ lastResult: 'error', lastError: 'HTTP 500', consecutiveFailures: 1, counters: { fires: 1, errors: 1 } });
    expect(w.pendingRun).toBeUndefined();
  });

  it('a POST that throws while not busy records one rejected network error', async () => {
    t.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await fireOnce();
    expect(t.wake('a')!.history).toEqual([expect.objectContaining({ outcome: 'rejected', reason: 'network error' })]);
  });

  it('a 409 restores only scheduling fields, undoes the slot and keeps history', async () => {
    await fireOnce();
    t.mgr.settle('a', 'ok');
    t.advance(H);
    const before = t.wake('a')!;
    t.post.mockResolvedValueOnce(409);
    await t.mgr.tick();
    const w = t.wake('a')!;
    expect(w).toEqual(before);
    expect(w.history).toHaveLength(1);
    expect(w).toMatchObject({ slotSeq: 1, counters: { fires: 1, ok: 1 } });
    await t.mgr.tick();
    expect(t.wake('a')!.pendingRun!.slot).toBe(2);
  });

  it('a 409 keeps history added while the POST was in flight', async () => {
    await fireOnce();
    t.mgr.settle('a', 'ok');
    t.advance(H);
    t.post.mockImplementationOnce(async () => {
      // Something else (e.g. an import validation or defer) touched history meanwhile.
      t.metas.get('a')!.wake!.lastOfferedAt = '2026-11-09T19:00:00.000Z';
      return 409;
    });
    await t.mgr.tick();
    expect(t.wake('a')!.lastOfferedAt).toBe('2026-11-09T19:00:00.000Z');
    expect(t.wake('a')!.lastResult).toBe('ok');
  });

  it('a human turn outcome during a POST that then gets 409 does not settle the wake slot', async () => {
    await fireOnce();
    t.mgr.settle('a', 'ok');
    t.advance(H);
    const before = t.wake('a')!;
    t.post.mockImplementationOnce(async () => {
      t.mgr.settle('a', 'ok'); // the human turn that won the race ends first
      return 409;
    });
    await t.mgr.tick();
    expect(t.wake('a')).toEqual(before);
    expect(t.wake('a')!.history).toHaveLength(1);
  });

  it("the wake's own fast turn ending before the POST returns settles once after acceptance", async () => {
    t.post.mockImplementationOnce(async () => {
      t.mgr.settle('a', 'error', 'session.error');
      t.mgr.settle('a', 'ok'); // later outcomes ignored: first wins
      return 200;
    });
    await fireOnce();
    const w = t.wake('a')!;
    expect(w.history).toEqual([expect.objectContaining({ slot: 1, outcome: 'error', reason: 'session.error' })]);
    expect(w.pendingRun).toBeUndefined();
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')!.history).toHaveLength(1);
  });

  it('a non-fixed reason is recorded as "error"', async () => {
    await fireOnce();
    t.mgr.settle('a', 'error', 'some exception text with a@b.com');
    expect(t.wake('a')!.history![0].reason).toBe('error');
  });

  it('a POST that times out while the turn dispatches stays pending, then settles once', async () => {
    t.post.mockImplementationOnce(async () => { t.busy.add('a'); throw new Error('headers timeout'); });
    await fireOnce();
    expect(t.wake('a')!.pendingRun).toBeDefined();
    expect(t.wake('a')!.history).toBeUndefined();
    t.busy.delete('a');
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')!.history).toEqual([expect.objectContaining({ slot: 1, outcome: 'ok' })]);
  });

  it('a turn timeout records one error run', async () => {
    await fireOnce();
    t.advance(2 * H + 1);
    t.busy.add('a');
    await t.mgr.tick();
    t.mgr.settle('a', 'ok'); // late real end: ignored
    expect(t.wake('a')!.history).toEqual([expect.objectContaining({ outcome: 'error', reason: 'no idle within timeout' })]);
  });

  it('boot with a pending run records one interrupted run', async () => {
    await fireOnce();
    t.mgr.rebuild();
    t.mgr.rebuild();
    const w = t.wake('a')!;
    expect(w.history).toEqual([expect.objectContaining({ slot: 1, outcome: 'interrupted', reason: 'restart' })]);
    expect(w).toMatchObject({ lastResult: 'error', lastError: 'interrupted by restart', consecutiveFailures: 0, counters: { interrupted: 1 } });
    expect(w.pendingRun).toBeUndefined();
  });

  it.each([false, true])('import (migrated=%s) with a pending run records one interrupted run', async (migrated) => {
    await fireOnce();
    t.mgr.applyImport('a', migrated);
    t.mgr.applyImport('a', migrated);
    const w = t.wake('a')!;
    expect(w.history).toEqual([expect.objectContaining({ outcome: 'interrupted', reason: 'import' })]);
    expect(w.lastError).toBe('interrupted by transfer');
    expect(w.pendingRun).toBeUndefined();
  });

  it('set during a pending run keeps the pending run, history and counters', async () => {
    await fireOnce();
    t.mgr.settle('a', 'ok');
    await fireOnce();
    const pending = t.wake('a')!.pendingRun;
    t.mgr.set('a', 2, 'new note');
    const w = t.wake('a')!;
    expect(w.pendingRun).toEqual(pending);
    expect(w.history).toHaveLength(1);
    expect(w.counters).toMatchObject({ fires: 2, ok: 1 });
    t.mgr.settle('a', 'ok');
    expect(t.wake('a')!.history!.map(r => r.slot)).toEqual([1, 2]);
  });

  it('set while idle keeps history; clear drops it with the wake', async () => {
    await fireOnce();
    t.mgr.settle('a', 'ok');
    t.mgr.set('a', 3);
    expect(t.wake('a')!.history).toHaveLength(1);
    t.mgr.clear('a');
    expect(t.wake('a')).toBeUndefined();
    t.mgr.set('a', 1);
    expect(t.wake('a')).toMatchObject({ slotSeq: 0, counters: { fires: 0 } });
    expect(t.wake('a')!.history).toBeUndefined();
  });

  it('firesSinceHuman counts fires and resets when lastUsedAt moves past the anchor', async () => {
    for (let i = 0; i < 3; i++) { await fireOnce(); t.mgr.settle('a', 'ok'); }
    expect(t.wake('a')!.counters!.firesSinceHuman).toBe(3);
    t.metas.get('a')!.lastUsedAt = new Date(t.now() - 31 * 60_000).toISOString();
    await fireOnce();
    expect(t.wake('a')!.counters).toMatchObject({ fires: 4, firesSinceHuman: 1, humanAnchor: t.metas.get('a')!.lastUsedAt });
  });

  it('a final fire marks its run final', async () => {
    const s = setup();
    s.addSession('b');
    s.mgr.set('b', 24);
    s.advance(7 * D);
    await s.mgr.tick();
    s.mgr.settle('b', 'ok');
    expect(s.wake('b')!.history![0]).toMatchObject({ final: true, outcome: 'ok' });
  });
});

describe('wake history caps, defers and import validation (spec-session-overview O7)', () => {
  it('keeps at most 20 runs; historySince follows the oldest kept run', async () => {
    const t = setup();
    t.addSession('a');
    t.mgr.set('a', 1);
    for (let i = 0; i < 25; i++) { t.advance(H); await t.mgr.tick(); t.mgr.settle('a', 'ok'); }
    const w = t.wake('a')!;
    expect(w.history).toHaveLength(20);
    expect(w.history![0].slot).toBe(6);
    expect(w.historySince).toBe(w.history![0].dueAt);
    expect(w.counters).toMatchObject({ fires: 25, ok: 25 });
  });

  it('caps the serialized history at 8 KiB', () => {
    let w = { everyMinutes: 60, registeredAt: 'x', nextWakeAt: 'y', consecutiveFailures: 0 } as Parameters<typeof appendRun>[0];
    for (let i = 1; i <= 20; i++) {
      w = appendRun(w, { slot: i, dueAt: new Date(START + i * H).toISOString(), outcome: 'error', reason: 'r'.repeat(600) });
    }
    expect(Buffer.byteLength(JSON.stringify(w.history))).toBeLessThanOrEqual(WAKE_HISTORY_MAX_BYTES);
    expect(w.history!.length).toBeLessThan(20);
    expect(w.history!.at(-1)!.slot).toBe(20);
    expect(w.historySince).toBe(w.history![0].dueAt);
  });

  it('dedupes defers by dueAt, persists repeats at most hourly, and keeps 5', async () => {
    const t = setup();
    t.addSession('a');
    t.mgr.set('a', 1);
    t.advance(H);
    const due = t.wake('a')!.nextWakeAt;
    t.busy.add('a');
    await t.mgr.tick();
    expect(t.wake('a')!.defers).toEqual([{ dueAt: due, kind: 'busy', first: new Date(t.now()).toISOString(), last: new Date(t.now()).toISOString(), count: 1 }]);
    for (let i = 0; i < 11; i++) { t.advance(5 * 60_000); await t.mgr.tick(); }
    expect(t.wake('a')!.defers![0].count).toBe(1); // buffered
    t.advance(5 * 60_000);
    await t.mgr.tick();
    expect(t.wake('a')!.defers).toHaveLength(1);
    expect(t.wake('a')!.defers![0]).toMatchObject({ count: 13, last: new Date(t.now()).toISOString() });
    t.busy.delete('a');
    t.metas.get('a')!.lastUsedAt = new Date(t.now()).toISOString();
    await t.mgr.tick(); // kind change persists at once
    expect(t.wake('a')!.defers![0]).toMatchObject({ kind: 'human', count: 14 });
    expect(t.wake('a')!.nextWakeAt).toBe(due);

    let w = t.wake('a')!;
    for (let i = 0; i < 7; i++) w = recordDefer(w, { dueAt: new Date(START + i * D).toISOString(), kind: 'window', nowMs: t.now(), count: 1 });
    expect(w.defers).toHaveLength(5);
  });

  it('an archived due wake records an archived defer', async () => {
    const t = setup();
    t.addSession('a', { folder: 'auto-archive' });
    t.mgr.set('a', 1);
    t.advance(H);
    await t.mgr.tick();
    expect(t.wake('a')!.defers).toEqual([expect.objectContaining({ kind: 'archived', count: 1 })]);
    expect(t.post).not.toHaveBeenCalled();
  });

  it('a window defer records a window defer and moves nextWakeAt', async () => {
    const t = setup({ window: parseWakeWindow('Mon-Fri 07:00-19:00 UTC') });
    t.advance(-2 * D - 4 * H);
    t.addSession('a');
    t.mgr.set('a', 1);
    const due = t.wake('a')!.nextWakeAt;
    t.advance(H);
    await t.mgr.tick();
    expect(t.wake('a')!.defers).toEqual([expect.objectContaining({ dueAt: due, kind: 'window', count: 1 })]);
  });

  describe('import validation', () => {
    const base = { everyMinutes: 60, registeredAt: '2026-11-01T00:00:00.000Z', nextWakeAt: new Date(START).toISOString(), consecutiveFailures: 0 };
    const run = (slot: number) => ({ slot, dueAt: '2026-11-08T00:00:00.000Z', outcome: 'ok' });
    const importWith = (extra: Record<string, unknown>) => {
      const t = setup();
      t.addSession('a', { wake: { ...base, ...extra } as SessionMeta['wake'] });
      t.mgr.applyImport('a', true);
      return t.wake('a')!;
    };

    it('keeps valid history and strips unknown keys', () => {
      const w = importWith({ slotSeq: 2, history: [{ ...run(1), junk: 'x' }, run(2)], historySince: '2026-11-08T00:00:00.000Z' });
      expect(w.history).toEqual([run(1), run(2)]);
      expect(w.historySince).toBe('2026-11-08T00:00:00.000Z');
      expect(w.slotSeq).toBe(2);
    });

    it.each([
      ['bad outcome', [{ ...run(1), outcome: 'weird' }]],
      ['bad slot', [{ ...run(1), slot: -1 }]],
      ['bad date', [{ ...run(1), dueAt: 'nope' }]],
      ['long reason', [{ ...run(1), reason: 'x'.repeat(500) }]],
      ['free-text reason', [{ ...run(1), reason: 'Error: token abc123 at C:\\x' }]],
      ['zero slot', [{ ...run(1), slot: 0 }]],
      ['duplicate slots', [run(1), run(1)]],
      ['too many runs', Array.from({ length: 21 }, (_, i) => run(i + 1))],
      ['not an array', 'x'],
    ])('drops malformed history (%s)', (_label, history) => {
      const w = importWith({ history, historySince: '2026-11-08T00:00:00.000Z' });
      expect(w.history).toBeUndefined();
      expect(w.historySince).toBeUndefined();
      expect(w.everyMinutes).toBe(60);
    });

    it('drops malformed counters, defers and timestamps; raises slotSeq to the max slot', () => {
      const w = importWith({
        slotSeq: 1, history: [run(4)],
        counters: { fires: 'many' },
        defers: Array.from({ length: 6 }, () => ({ dueAt: base.nextWakeAt, kind: 'busy', first: base.nextWakeAt, last: base.nextWakeAt, count: 1 })),
        lastOkAt: 42,
      });
      expect(w.counters).toBeUndefined();
      expect(w.defers).toBeUndefined();
      expect(w.lastOkAt).toBeUndefined();
      expect(w.slotSeq).toBe(4);
    });

    it('keeps fixed and HTTP reasons', () => {
      const w = importWith({ history: [{ ...run(1), outcome: 'rejected', reason: 'HTTP 503' }, { ...run(2), outcome: 'error', reason: 'session.error' }] });
      expect(w.history!.map(r => r.reason)).toEqual(['HTTP 503', 'session.error']);
    });

    it('a pending slot already in history is dropped and never recorded twice', () => {
      const w = importWith({
        lastResult: 'running', slotSeq: 3, history: [run(3)],
        pendingRun: { slot: 3, dueAt: base.nextWakeAt, firedAt: base.nextWakeAt, offerBaseline: null },
      });
      expect(w.pendingRun).toBeUndefined();
      expect(w.history).toEqual([run(3)]);
    });

    it('a malformed pending run is dropped; a running wake still becomes an error', () => {
      const w = importWith({ lastResult: 'running', pendingRun: { slot: 'x' } });
      expect(w.pendingRun).toBeUndefined();
      expect(w.history).toBeUndefined();
      expect(w.lastError).toBe('interrupted by transfer');
    });
  });
});
