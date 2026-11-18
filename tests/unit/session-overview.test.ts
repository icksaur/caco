import { describe, it, expect } from 'vitest';
import {
  buildSessionOverview, compareEntries, datedNote, overviewThresholdsFromEnv, DEFAULT_OVERVIEW_THRESHOLDS,
  type OverviewSessionInput, type OverviewInputs, type OverviewOptions, type SessionOverview, type OverviewEntry,
} from '../../src/session-overview.js';
import type { LastContext, AskVerdict, TailResult } from '../../src/sdk-session-tail.js';
import type { WakeState } from '../../src/session-meta-store.js';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const NOW = Date.parse('2026-11-17T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function tail(over: Partial<LastContext> = {}, ask: AskVerdict = { matched: null }): TailResult {
  return {
    context: {
      status: 'ok', windowCoversTurn: true,
      lastUser: { at: ago(3 * H), source: 'user', text: 'please do it' },
      lastAssistant: { at: ago(3 * H - MIN), text: 'Done.' },
      lastEventType: 'assistant.turn_end', lastEventAt: ago(3 * H - MIN),
      ...over,
    },
    ask,
  };
}

type Meta = NonNullable<OverviewSessionInput['meta']>;
function s(id: string, meta: Partial<Meta> = {}, over: Partial<OverviewSessionInput> = {}): OverviewSessionInput {
  return { sessionId: id, cwd: null, meta: { name: id, lastUsedAt: ago(3 * H), ...meta }, tail: tail(), ...over };
}

function build(sessions: OverviewSessionInput[], opts: OverviewOptions = {}, extra: Partial<OverviewInputs> = {}): SessionOverview {
  return buildSessionOverview({
    instance: { id: 'inst', name: 'laptop' }, sessions, archiveFolder: 'auto-archive',
    wakeLoopEnabled: true, contextRead: true, timeZone: 'UTC', ...extra,
  }, NOW, opts);
}
const one = (input: OverviewSessionInput, extra: Partial<OverviewInputs> = {}) => build([input], {}, extra).entries[0];
const codes = (e: OverviewEntry) => e.flags.map(f => `${f.code}:${f.confidence}`);
const has = (e: OverviewEntry, code: string) => e.flags.some(f => f.code === code);

function wake(over: Partial<WakeState> = {}): WakeState {
  return {
    everyMinutes: 60, registeredAt: ago(2 * D), nextWakeAt: new Date(NOW + 30 * MIN).toISOString(),
    consecutiveFailures: 0, slotSeq: 0, counters: { fires: 0, ok: 0, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: 0 },
    historySince: ago(2 * D), ...over,
  };
}

describe('basics (O1)', () => {
  it('a quiet idle session with a human-driven last turn is a compact row with no waits and no flags', () => {
    const e = one(s('a'));
    expect(e).toMatchObject({ key: 'inst:a', instance: { id: 'inst', name: 'laptop' }, tier: 'compact', activity: 'idle', waits: [], flags: [], title: 'a', titleSource: 'name' });
    expect(e.primaryFlag).toBeUndefined();
  });

  it('title ladder: name, workspace summary, autoName, none', () => {
    expect(one(s('a', { name: '' }, { workspace: { summary: 'Sum' } }))).toMatchObject({ title: 'Sum', titleSource: 'workspace-summary' });
    expect(one(s('a', { name: '', autoName: 'Auto' }))).toMatchObject({ title: 'Auto', titleSource: 'auto-name' });
    expect(one(s('a', { name: '' }))).toMatchObject({ title: 'No summary', titleSource: 'none' });
  });

  it('auto-archive sessions are excluded and counted', () => {
    const ov = build([s('a'), s('b', { folder: 'auto-archive' }), s('c', { folder: 'work' })]);
    expect(ov.entries.map(e => e.sessionId).sort()).toEqual(['a', 'c']);
    expect(ov.counts).toMatchObject({ total: 2, archivedExcluded: 1, shown: 2, omitted: 0 });
    expect(ov.entries.find(e => e.sessionId === 'c')!.folder).toBe('work');
  });

  it('agent, swarm and herd children are included and marked', () => {
    const ov = build([s('p'), s('ag', { kind: 'agent' }), s('sw', { kind: 'swarm' }), s('ch', { orchestratedBy: 'p' })]);
    const by = (id: string) => ov.entries.find(e => e.sessionId === id)!;
    expect(by('ag').hidden).toBe('agent');
    expect(by('sw').hidden).toBe('swarm');
    expect(by('ch').hidden).toBe('herd-child');
    expect(by('p').hidden).toBeUndefined();
  });

  it('human-recent is info only and never makes a row full', () => {
    const e = one(s('a', { lastUsedAt: ago(10 * MIN) }));
    expect(codes(e)).toEqual(['human-recent:info']);
    expect(e.tier).toBe('compact');
    expect(e.primaryFlag).toBeUndefined();
    expect(codes(one(s('a', { lastUsedAt: ago(30 * MIN) })))).toEqual([]);
  });
});

describe('busy and retry (O1)', () => {
  it('busy: turn-running wait, busy facts; busy-long only past 1 h', () => {
    const e = one(s('a', {}, { busySince: NOW - H, pendingTools: 2, currentIntent: 'fixing' }));
    expect(e.activity).toBe('busy');
    expect(e.waits).toEqual([{ kind: 'turn-running' }]);
    expect(e.busy).toEqual({ since: ago(H), pendingTools: 2, currentIntent: 'fixing' });
    expect(has(e, 'busy-long')).toBe(false);
    const long = one(s('a', {}, { busySince: NOW - H - 1 }));
    expect(codes(long)).toEqual(['busy-long:high']);
    expect(long.tier).toBe('full');
  });

  it('retry-pending is a wait; retry-exhausting from attempt 5', () => {
    const e4 = one(s('a', {}, { retryAttempt: 4 }));
    expect(e4.waits).toEqual([{ kind: 'retry-pending', attempt: 4 }]);
    expect(e4.flags).toEqual([]);
    expect(codes(one(s('a', {}, { retryAttempt: 5 })))).toEqual(['retry-exhausting:high']);
    expect(codes(one(s('a', {}, { retryAttempt: 6 })))).toEqual(['retry-exhausting:high']);
  });
});

describe('offers (O1)', () => {
  const offer = (at: string, extra: Partial<Meta> = {}) => ({ responseOptions: ['Ship it', 'Wait'], responseOptionsAt: at, ...extra });

  it('a fresh undismissed offer is a user-offer wait, full row, on the pager', () => {
    const e = one(s('a', offer(ago(H))));
    expect(e.waits).toEqual([{ kind: 'user-offer' }]);
    expect(e.offer).toEqual({ options: ['Ship it', 'Wait'], at: ago(H), dismissed: false, ageMs: H, onPager: true });
    expect(e.tier).toBe('full');
    expect(e.flags).toEqual([]);
  });

  it('offer-stale starts after 2 days', () => {
    expect(has(one(s('a', offer(ago(2 * D)))), 'offer-stale')).toBe(false);
    expect(has(one(s('a', offer(ago(2 * D + 1)))), 'offer-stale')).toBe(true);
  });

  it('a 10-day offer is off the pager but reported and flagged', () => {
    const e = one(s('a', offer(ago(10 * D))));
    expect(e.offer).toMatchObject({ onPager: false, dismissed: false, ageMs: 10 * D });
    expect(e.waits).toEqual([]);
    expect(codes(e)).toEqual(['offer-stale:high']);
    expect(e.flags[0].detail).toContain('off the pager');
  });

  it('a dismissed offer with nothing driving is offer-dismissed-no-driver (low); a wake removes it', () => {
    const e = one(s('a', offer(ago(H), { pagerDismissedAt: ago(30 * MIN) })));
    expect(e.offer).toMatchObject({ dismissed: true, onPager: false });
    expect(codes(e)).toEqual(['offer-dismissed-no-driver:low']);
    const w = one(s('a', offer(ago(H), { pagerDismissedAt: ago(30 * MIN), wake: wake() })));
    expect(has(w, 'offer-dismissed-no-driver')).toBe(false);
  });

  it('pager facts follow needsTriage: a herd child offer is a fact but not on the pager', () => {
    const ov = build([s('p'), s('c', { orchestratedBy: 'p', ...offer(ago(H)) })]);
    expect(ov.entries.find(e => e.sessionId === 'c')!.offer!.onPager).toBe(false);
  });

  it('an agent-created session offer is on the pager; a swarm session offer is not', () => {
    expect(one(s('a', { kind: 'agent', ...offer(ago(H)) })).offer!.onPager).toBe(true);
    expect(one(s('w', { kind: 'swarm', ...offer(ago(H)) })).offer!.onPager).toBe(false);
  });
});

describe('wakes (O1)', () => {
  it('an armed wake is a wait and exposes history and counters', () => {
    const w = wake({
      slotSeq: 3, counters: { fires: 3, ok: 2, errors: 1, cancelled: 0, interrupted: 0, offered: 1, firesSinceHuman: 2 },
      history: [{ slot: 3, dueAt: ago(2 * H), outcome: 'ok' }], lastOkAt: ago(H), lastOfferedAt: ago(H),
      defers: [{ dueAt: ago(3 * H), kind: 'busy', first: ago(3 * H), last: ago(3 * H), count: 1 }],
    });
    const e = one(s('a', { wake: w }));
    expect(e.waits).toEqual([{ kind: 'wake', nextAt: w.nextWakeAt }]);
    expect(e.wake).toMatchObject({ everyHours: 1, slotSeq: 3, counters: { fires: 3, offered: 1 }, history: [{ slot: 3 }], lastOkAt: ago(H), defers: [{ kind: 'busy' }] });
    expect(e.tier).toBe('compact');
  });

  it('a running wake is wake-running; a paused wake is not a wait', () => {
    expect(one(s('a', { wake: wake({ lastResult: 'running' }) })).waits).toEqual([{ kind: 'wake-running' }]);
    const p = one(s('a', { wake: wake({ pausedReason: 'expired' }) }));
    expect(p.waits).toEqual([]);
    expect(has(p, 'wake-paused')).toBe(true);
    expect(has(one(s('a', { wake: wake({ pausedReason: 'imported' }) })), 'wake-paused')).toBe(true);
  });

  it('with the wake loop disabled an armed wake is not a wait, so driver flags apply', () => {
    const off = { wakeLoopEnabled: false };
    const asking = one(s('a', { wake: wake() }, { tail: tail({}, { matched: 'should i' }) }), off);
    expect(asking.waits).toEqual([]);
    expect(codes(asking).sort()).toEqual(['awaiting-user-no-offer:low', 'wake-loop-disabled:info']);
    expect(asking.tier).toBe('full');
    const unattended = one(s('a', { wake: wake() }, { tail: tail({ lastUser: { at: ago(3 * H), source: 'scheduler', text: 'x' } }) }), off);
    expect(codes(unattended)).toContain('no-driver:low');
    const errored = one(s('a', { wake: wake() }, { tail: tail({ lastError: { at: ago(MIN), text: 'x' } }) }), off);
    expect(codes(errored)).toContain('no-driver:high');
    // A running wake turn still settles on its own.
    expect(one(s('a', { wake: wake({ lastResult: 'running' }) }), off).waits).toEqual([{ kind: 'wake-running' }]);
    // A wake that cannot fire cannot be overdue or about to be final.
    const stale = one(s('a', { lastUsedAt: ago(8 * D), wake: wake({ nextWakeAt: ago(3 * H) }) }), off);
    expect(has(stale, 'wake-overdue')).toBe(false);
    expect(has(stale, 'wake-expiring')).toBe(false);
    // A disabled flag alone never makes a row full.
    const quiet = one(s('a', { wake: wake() }), off);
    expect(codes(quiet)).toEqual(['wake-loop-disabled:info']);
    expect(quiet.tier).toBe('compact');
    expect(build([s('a')], {}, off).wakeLoopEnabled).toBe(false);
    expect(build([s('a')]).wakeLoopEnabled).toBe(true);
  });

  it('wake-failing from 2 consecutive failures or a failures pause', () => {
    expect(has(one(s('a', { wake: wake({ consecutiveFailures: 1 }) })), 'wake-failing')).toBe(false);
    expect(has(one(s('a', { wake: wake({ consecutiveFailures: 2, lastError: 'HTTP 500' }) })), 'wake-failing')).toBe(true);
    const p = one(s('a', { wake: wake({ consecutiveFailures: 5, pausedReason: 'failures' }) }));
    expect(codes(p)).toContain('wake-failing:high');
    expect(has(p, 'wake-paused')).toBe(false);
  });

  it('wake-overdue past 2 cadences, not when paused, running or the wake loop is off', () => {
    const due = (ms: number) => new Date(NOW - ms).toISOString();
    expect(has(one(s('a', { wake: wake({ nextWakeAt: due(2 * H) }) })), 'wake-overdue')).toBe(false);
    expect(has(one(s('a', { wake: wake({ nextWakeAt: due(2 * H + 1) }) })), 'wake-overdue')).toBe(true);
    expect(has(one(s('a', { wake: wake({ nextWakeAt: due(3 * H), pausedReason: 'expired' }) })), 'wake-overdue')).toBe(false);
    expect(has(one(s('a', { wake: wake({ nextWakeAt: due(3 * H), lastResult: 'running' }) })), 'wake-overdue')).toBe(false);
    expect(has(one(s('a', { wake: wake({ nextWakeAt: due(3 * H) }) }), { wakeLoopEnabled: false }), 'wake-overdue')).toBe(false);
  });

  it('wake-expiring when the final wake fired or the next one will be final', () => {
    expect(has(one(s('a', { wake: wake({ finalWakeAt: ago(H), lastResult: 'running' }) })), 'wake-expiring')).toBe(true);
    expect(has(one(s('a', { lastUsedAt: ago(8 * D), wake: wake() })), 'wake-expiring')).toBe(true);
    expect(has(one(s('a', { lastUsedAt: ago(6 * D), wake: wake() })), 'wake-expiring')).toBe(false);
  });

  it('wake-deferred-long when the current dueAt has been deferred over a day', () => {
    const nextWakeAt = ago(25 * H);
    const d = (first: string) => wake({ nextWakeAt, everyMinutes: 24 * 60, defers: [{ dueAt: nextWakeAt, kind: 'human', first, last: ago(MIN), count: 30 }] });
    expect(has(one(s('a', { wake: d(ago(D)) })), 'wake-deferred-long')).toBe(false);
    const e = one(s('a', { wake: d(ago(D + 1)) }));
    expect(codes(e)).toContain('wake-deferred-long:high');
    expect(e.flags.find(f => f.code === 'wake-deferred-long')!.detail).toContain('human');
  });

  it('wake-quiet-long: 6 fires since the human with no offer; low when history does not cover the span', () => {
    const anchor = ago(3 * D);
    const c = (n: number) => ({ fires: n, ok: n, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: n, humanAnchor: anchor });
    expect(has(one(s('a', { wake: wake({ counters: c(5), historySince: ago(4 * D) }) })), 'wake-quiet-long')).toBe(false);
    expect(codes(one(s('a', { wake: wake({ counters: c(6), historySince: ago(4 * D) }) })))).toContain('wake-quiet-long:high');
    expect(codes(one(s('a', { wake: wake({ counters: c(6), historySince: ago(D) }) })))).toContain('wake-quiet-long:low');
    // An offer after the anchor clears it.
    expect(has(one(s('a', { wake: wake({ counters: c(6), historySince: ago(4 * D), lastOfferedAt: ago(D) }) })), 'wake-quiet-long')).toBe(false);
  });

  it('wake-quiet-long: last offer older than 7 days with history covering it', () => {
    const c = { fires: 3, ok: 3, errors: 0, cancelled: 0, interrupted: 0, offered: 1, firesSinceHuman: 1, humanAnchor: ago(H) };
    expect(codes(one(s('a', { wake: wake({ counters: c, lastOfferedAt: ago(8 * D), historySince: ago(9 * D) }) })))).toContain('wake-quiet-long:high');
    expect(codes(one(s('a', { wake: wake({ counters: c, lastOfferedAt: ago(8 * D), historySince: ago(2 * D) }) })))).toContain('wake-quiet-long:low');
    expect(has(one(s('a', { wake: wake({ counters: c, lastOfferedAt: ago(6 * D), historySince: ago(9 * D) }) })), 'wake-quiet-long')).toBe(false);
  });

  it('wake-note-dated for a passed ISO or M/D date (low)', () => {
    expect(codes(one(s('a', { wake: wake({ note: 'check PR after 2026-11-10' }) })))).toContain('wake-note-dated:low');
    expect(has(one(s('a', { wake: wake({ note: 'deploy on 11/20' }) })), 'wake-note-dated')).toBe(false);
    expect(has(one(s('a', { wake: wake({ note: 'deploy on 11/16' }) })), 'wake-note-dated')).toBe(true);
    expect(datedNote('release 2026-11-17 today', NOW, 'UTC')).toBeNull();
    expect(datedNote('ratio 3/4/5 and v1.2/3', NOW, 'UTC')).toBeNull();
  });
});

describe('schedule and herd (O1)', () => {
  it('an enabled schedule with a next run is a wait; a disabled one is reported only', () => {
    const on = one(s('a', {}, { schedule: { slug: 'daily', enabled: true, nextRun: '2026-11-18T09:00:00.000Z', lastResult: 'success' } }));
    expect(on.waits).toEqual([{ kind: 'schedule', nextRun: '2026-11-18T09:00:00.000Z' }]);
    expect(on.schedule).toEqual({ slug: 'daily', enabled: true, nextRun: '2026-11-18T09:00:00.000Z', lastResult: 'success' });
    expect(one(s('a', {}, { schedule: { slug: 'x', enabled: false, nextRun: null } })).waits).toEqual([]);
  });

  it('a herd parent with busy children waits on them', () => {
    const ov = build([s('p'), s('c1', { orchestratedBy: 'p' }, { busySince: NOW - MIN }), s('c2', { orchestratedBy: 'p' })]);
    const p = ov.entries.find(e => e.sessionId === 'p')!;
    expect(p.waits).toEqual([{ kind: 'children', busy: 1 }]);
    expect(p.herd).toEqual({ children: 2, busyChildren: 1 });
    expect(ov.entries.find(e => e.sessionId === 'c2')!.herd).toEqual({ parent: 'p', parentState: 'ok' });
  });

  it('children-stuck when every child is idle with no-driver', () => {
    const errTail = tail({ lastError: { at: ago(H), text: 'boom' } });
    const ov = build([s('p'), s('c1', { orchestratedBy: 'p' }, { tail: errTail }), s('c2', { orchestratedBy: 'p' }, { tail: errTail })]);
    const p = ov.entries.find(e => e.sessionId === 'p')!;
    expect(codes(p)).toContain('children-stuck:low');
    expect(p.waits).toEqual([]);
  });

  it('orphan-child when the parent is missing or archived', () => {
    const missing = build([s('c', { orchestratedBy: 'gone' })]).entries[0];
    expect(missing.herd).toEqual({ parent: 'gone', parentState: 'missing' });
    expect(codes(missing)).toContain('orphan-child:high');
    const archived = build([s('p', { folder: 'auto-archive' }), s('c', { orchestratedBy: 'p' })]).entries[0];
    expect(archived.herd!.parentState).toBe('archived');
  });
});

describe('drivers and context (O1)', () => {
  it('no-driver (high) when the last turn ended in session.error', () => {
    const e = one(s('a', {}, { tail: tail({ lastError: { at: ago(2 * H), text: 'network' } }) }));
    expect(codes(e)).toEqual(['no-driver:high']);
    expect(e.tier).toBe('full');
    // An error before the last assistant message does not count.
    expect(codes(one(s('a', {}, { tail: tail({ lastError: { at: ago(4 * H), text: 'old' } }) })))).toEqual([]);
  });

  it('no-driver (low) when the last turn was unattended and made no offer', () => {
    const t = tail({ lastUser: { at: ago(3 * H), source: 'scheduler', text: 'Scheduled wake.' } });
    expect(codes(one(s('a', {}, { tail: t })))).toEqual(['no-driver:low']);
    expect(codes(one(s('a', { wake: wake() }, { tail: t })))).toEqual([]);
  });

  it('context-unavailable for unavailable, skipped and empty contexts; nothing when context was not read', () => {
    const u = one(s('a', {}, { tail: { context: { status: 'unavailable', errorCode: 'EBUSY' }, ask: { matched: null } } }));
    expect(codes(u)).toEqual(['context-unavailable:high']);
    expect(u.flags[0].detail).toContain('EBUSY');
    expect(has(one(s('a', {}, { tail: { context: { status: 'skipped-deadline' }, ask: { matched: null } } })), 'context-unavailable')).toBe(true);
    // A session never messaged has no transcript: reported, not flagged.
    const fresh = one(s('a', {}, { tail: { context: { status: 'unavailable', errorCode: 'ENOENT' }, ask: { matched: null } } }));
    expect(fresh.context).toEqual({ status: 'unavailable', errorCode: 'ENOENT' });
    expect(has(fresh, 'context-unavailable')).toBe(false);
    const none = one(s('a', {}, { tail: undefined }), { contextRead: false });
    expect(none.context).toEqual({ status: 'not-read' });
    expect(none.flags).toEqual([]);
  });
});

describe('awaiting-user-no-offer, classifier side (O11)', () => {
  const asking: AskVerdict = { matched: 'should i' };
  it('flags an idle session whose last message asks the user, with no offer and no driver', () => {
    const e = one(s('a', {}, { tail: tail({}, asking) }));
    expect(codes(e)).toEqual(['awaiting-user-no-offer:low']);
    expect(e.flags[0].detail).toContain('"should i"');
    expect(e.tier).toBe('full');
    expect(e.primaryFlag).toBe('awaiting-user-no-offer');
  });

  it('ranks first when no-driver (low) also applies', () => {
    const t = tail({ lastUser: { at: ago(3 * H), source: 'agent', text: 'x' } }, asking);
    const e = one(s('a', {}, { tail: t }));
    expect(codes(e).sort()).toEqual(['awaiting-user-no-offer:low', 'no-driver:low']);
    expect(e.primaryFlag).toBe('awaiting-user-no-offer');
  });

  it.each<[string, OverviewSessionInput]>([
    ['an undismissed offer', s('a', { responseOptions: ['Go'], responseOptionsAt: ago(H) }, { tail: tail({}, asking) })],
    ['an armed wake', s('a', { wake: wake() }, { tail: tail({}, asking) })],
    ['a busy session', s('a', {}, { busySince: NOW - MIN, tail: tail({}, asking) })],
    ['a pending retry', s('a', {}, { retryAttempt: 1, tail: tail({}, asking) })],
    ['no match', s('a', {}, { tail: tail({}, { matched: null }) })],
    ['truncated-start', s('a', {}, { tail: tail({}, { unavailable: 'truncated-start' }) })],
    ['oversized', s('a', {}, { tail: tail({}, { unavailable: 'oversized' }) })],
    ['an error-ended turn', s('a', {}, { tail: tail({ lastError: { at: ago(MIN), text: 'x' } }, asking) })],
  ])('does not flag with %s', (_label, input) => {
    expect(has(one(input), 'awaiting-user-no-offer')).toBe(false);
  });

  it('a heuristic-negative quiet session still appears as a compact row', () => {
    const ov = build([s('a', {}, { tail: tail({}, { matched: null }) })]);
    expect(ov.entries).toHaveLength(1);
    expect(ov.entries[0].tier).toBe('compact');
  });
});

describe('tiers, filters and ordering (O2)', () => {
  const sessions = () => [
    s('quiet'),
    s('offer', { responseOptions: ['Go'], responseOptionsAt: ago(H) }),
    s('busy', {}, { busySince: NOW - 2 * H }),
    s('wake', { wake: wake() }),
    s('err', {}, { tail: tail({ lastError: { at: ago(MIN), text: 'x' } }) }),
    s('arch', { folder: 'auto-archive' }),
  ];

  it('default lists every non-archived session with the right tier', () => {
    const ov = build(sessions());
    const tiers = Object.fromEntries(ov.entries.map(e => [e.sessionId, e.tier]));
    expect(tiers).toEqual({ quiet: 'compact', offer: 'full', busy: 'full', wake: 'compact', err: 'full' });
    expect(ov.counts).toMatchObject({ total: 5, shown: 5, omitted: 0, omittedFlagged: 0, full: 3, compact: 2, archivedExcluded: 1 });
  });

  it('attention shows full rows only and counts the omitted compact rows', () => {
    const ov = build(sessions(), { show: 'attention' });
    expect(ov.entries.map(e => e.sessionId).sort()).toEqual(['busy', 'err', 'offer']);
    expect(ov.counts).toMatchObject({ shown: 3, omitted: 2, omittedFlagged: 0 });
  });

  it('busy, wakes and waiting count every omitted flagged session', () => {
    const busy = build(sessions(), { show: 'busy' });
    expect(busy.entries.map(e => e.sessionId)).toEqual(['busy']);
    expect(busy.counts).toMatchObject({ omitted: 4, omittedFlagged: 1 }); // err
    const wakes = build(sessions(), { show: 'wakes' });
    expect(wakes.entries.map(e => e.sessionId)).toEqual(['wake']);
    expect(wakes.counts).toMatchObject({ omitted: 4, omittedFlagged: 2 }); // busy-long, err
    const waiting = build(sessions(), { show: 'waiting' });
    expect(waiting.entries.map(e => e.sessionId).sort()).toEqual(['err', 'offer', 'wake']);
    expect(waiting.counts).toMatchObject({ omitted: 2, omittedFlagged: 1 }); // busy
  });

  it('keys filter accepts composite and bare ids', () => {
    expect(build(sessions(), { keys: ['inst:offer', 'quiet'] }).entries.map(e => e.sessionId).sort()).toEqual(['offer', 'quiet']);
  });

  it('orders full rows by primary flag rank, then compact rows, by last activity then key; stable under shuffling', () => {
    const t = (at: string) => tail({ lastEventAt: at });
    const input = [
      s('c-old', {}, { tail: t(ago(5 * H)) }),
      s('c-new', {}, { tail: t(ago(H)) }),
      s('c-tie-b', {}, { tail: t(ago(2 * H)) }),
      s('c-tie-a', {}, { tail: t(ago(2 * H)) }),
      s('f-stale', { responseOptions: ['x'], responseOptionsAt: ago(3 * D) }, { tail: t(ago(H)) }),
      s('f-busy', {}, { busySince: NOW - 3 * H, tail: t(ago(5 * H)) }),
      s('f-ask', {}, { tail: tail({ lastEventAt: ago(9 * H) }, { matched: '?' }) }),
      s('f-multi', { wake: wake({ consecutiveFailures: 3, pausedReason: 'failures' }), responseOptions: ['x'], responseOptionsAt: ago(3 * D) }, { tail: t(ago(H)) }),
    ];
    const order = (xs: OverviewSessionInput[]) => build(xs).entries.map(e => e.sessionId);
    const expected = ['f-ask', 'f-multi', 'f-busy', 'f-stale', 'c-new', 'c-tie-a', 'c-tie-b', 'c-old'];
    expect(order(input)).toEqual(expected);
    for (let k = 0; k < 5; k++) {
      const shuffled = [...input].sort(() => (k % 2 ? 1 : -1) * (Math.random() - 0.5));
      expect(order(shuffled)).toEqual(expected);
    }
    const e = build(input).entries.find(x => x.sessionId === 'f-multi')!;
    expect(e.primaryFlag).toBe('wake-failing');
    expect(compareEntries(e, e)).toBe(0);
  });

  it('missing last activity sorts as oldest', () => {
    const ov = build([s('none', { lastUsedAt: undefined }, { tail: { context: { status: 'no-events' }, ask: { matched: null } } }), s('some')], {}, { contextRead: false });
    expect(ov.entries.map(e => e.sessionId)).toEqual(['some', 'none']);
  });
});

describe('thresholds', () => {
  it('env overrides positive numbers only', () => {
    const t = overviewThresholdsFromEnv({ CACO_OVERVIEW_BUSY_LONG_MS: '5000', CACO_OVERVIEW_OFFER_STALE_MS: '-1', CACO_OVERVIEW_WAKE_FAILING: 'x' });
    expect(t.busyLongMs).toBe(5000);
    expect(t.offerStaleMs).toBe(DEFAULT_OVERVIEW_THRESHOLDS.offerStaleMs);
    expect(t.wakeFailing).toBe(DEFAULT_OVERVIEW_THRESHOLDS.wakeFailing);
    expect(has(one(s('a', {}, { busySince: NOW - 6000 })), 'busy-long')).toBe(false);
    expect(has(build([s('a', {}, { busySince: NOW - 6000 })], { thresholds: t }).entries[0], 'busy-long')).toBe(true);
  });
});

