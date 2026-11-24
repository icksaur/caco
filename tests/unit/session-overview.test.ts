import { describe, it, expect } from 'vitest';
import {
  buildSessionOverview, compareEntries, mergeSessionOverviews,
  type OverviewSessionInput, type OverviewInputs, type OverviewOptions, type SessionOverview,
} from '../../src/session-overview.js';
import type { LastContext, TailResult } from '../../src/sdk-session-tail.js';
import type { WakeState } from '../../src/session-meta-store.js';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const NOW = Date.parse('2026-11-17T18:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function tail(over: Partial<LastContext> = {}): TailResult {
  return {
    context: {
      status: 'ok', windowCoversTurn: true,
      lastUser: { at: ago(3 * H), source: 'user', text: 'please do it' },
      lastAssistant: { at: ago(3 * H - MIN), text: 'Done.' },
      lastEventType: 'assistant.turn_end', lastEventAt: ago(3 * H - MIN),
      ...over,
    },
  };
}

type Meta = NonNullable<OverviewSessionInput['meta']>;
function s(id: string, meta: Partial<Meta> = {}, over: Partial<OverviewSessionInput> = {}): OverviewSessionInput {
  return { sessionId: id, cwd: 'C:/work', meta: { name: id, lastUsedAt: ago(3 * H), ...meta }, tail: tail(), ...over };
}

function build(sessions: OverviewSessionInput[], opts: OverviewOptions = {}, extra: Partial<OverviewInputs> = {}): SessionOverview {
  return buildSessionOverview({
    instance: { id: 'inst', name: 'laptop' }, sessions, archiveFolder: 'auto-archive',
    wakeLoopEnabled: true, contextRead: true, ...extra,
  }, NOW, opts);
}
const one = (input: OverviewSessionInput, extra: Partial<OverviewInputs> = {}) => build([input], {}, extra).entries[0];

function wake(over: Partial<WakeState> = {}): WakeState {
  return {
    everyMinutes: 60, registeredAt: ago(2 * D), nextWakeAt: new Date(NOW + 30 * MIN).toISOString(),
    consecutiveFailures: 0, slotSeq: 0, counters: { fires: 0, ok: 0, errors: 0, cancelled: 0, interrupted: 0, offered: 0, firesSinceHuman: 0 },
    historySince: ago(2 * D), ...over,
  };
}

const JUDGMENT_FIELDS = ['flags', 'tier', 'primaryFlag', 'ask'];

describe('facts only (R1)', () => {
  it('entries carry no flags, tier, primaryFlag or ask, for any fixture', () => {
    const ov = build([
      s('quiet'),
      s('busy', {}, { busySince: NOW - 2 * H, pendingTools: 2, currentIntent: 'fixing' }),
      s('err', {}, { tail: tail({ lastError: { at: ago(MIN), text: 'boom' } }) }),
      s('offer', { responseOptions: ['Go'], responseOptionsAt: ago(10 * D) }),
      s('wake', { wake: wake({ consecutiveFailures: 4, pausedReason: 'failures', note: 'after 11/1' }) }),
    ]);
    expect(ov.entries).toHaveLength(5);
    for (const e of ov.entries) for (const f of JUDGMENT_FIELDS) expect(f in e).toBe(false);
    for (const k of ['omittedFlagged', 'full', 'compact']) expect(k in ov.counts).toBe(false);
  });

  it('a quiet idle session: no waits, title, key, instance', () => {
    expect(one(s('a'))).toMatchObject({ key: 'inst:a', instance: { id: 'inst', name: 'laptop' }, activity: 'idle', waits: [], title: 'a', titleSource: 'name' });
  });

  it('title ladder: name, workspace summary, autoName, none', () => {
    expect(one(s('a', { name: '' }, { workspace: { summary: 'Sum' } }))).toMatchObject({ title: 'Sum', titleSource: 'workspace-summary' });
    expect(one(s('a', { name: '', autoName: 'Auto' }))).toMatchObject({ title: 'Auto', titleSource: 'auto-name' });
    expect(one(s('a', { name: '' }))).toMatchObject({ title: 'No summary', titleSource: 'none' });
  });

  it('auto-archive sessions are excluded and counted; agent and herd children are marked', () => {
    const ov = build([s('p'), s('arch', { folder: 'auto-archive' }), s('ag', { kind: 'agent' }), s('ch', { orchestratedBy: 'p' })]);
    expect(ov.counts).toEqual({ total: 3, shown: 3, omitted: 0, archivedExcluded: 1 });
    const by = (id: string) => ov.entries.find(e => e.sessionId === id)!;
    expect(by('ag').hidden).toBe('agent');
    expect(by('ch').hidden).toBe('herd-child');
    expect(ov.entries.some(e => e.sessionId === 'arch')).toBe(false);
  });

  it('sessions without a cwd are excluded, matching the session list', () => {
    const ov = build([s('ok'), s('nocwd', {}, { cwd: null }), s('unknown', {}, { cwd: '(unknown)' })]);
    expect(ov.entries.map(e => e.sessionId)).toEqual(['ok']);
    expect(ov.counts).toMatchObject({ total: 1, archivedExcluded: 0 });
  });

  it('busy: turn-running wait and busy facts', () => {
    const e = one(s('a', {}, { busySince: NOW - H, pendingTools: 2, currentIntent: 'fixing' }));
    expect(e.activity).toBe('busy');
    expect(e.waits).toEqual([{ kind: 'turn-running' }]);
    expect(e.busy).toEqual({ since: ago(H), pendingTools: 2, currentIntent: 'fixing' });
  });

  it('retry: retry-pending wait with the attempt', () => {
    expect(one(s('a', {}, { retryAttempt: 6 })).waits).toEqual([{ kind: 'retry-pending', attempt: 6 }]);
  });

  it('offers: fresh is a wait; old and dismissed are facts only', () => {
    const fresh = one(s('a', { responseOptions: ['Ship', 'Wait'], responseOptionsAt: ago(H) }));
    expect(fresh.waits).toEqual([{ kind: 'user-offer' }]);
    expect(fresh.offer).toEqual({ options: ['Ship', 'Wait'], at: ago(H), dismissed: false, ageMs: H, onPager: true });
    const old = one(s('a', { responseOptions: ['Go'], responseOptionsAt: ago(10 * D) }));
    expect(old.waits).toEqual([]);
    expect(old.offer).toMatchObject({ dismissed: false, ageMs: 10 * D, onPager: false });
    const dismissed = one(s('a', { responseOptions: ['Go'], responseOptionsAt: ago(H), pagerDismissedAt: ago(30 * MIN) }));
    expect(dismissed.waits).toEqual([]);
    expect(dismissed.offer).toMatchObject({ dismissed: true, onPager: false });
  });

  it('wakes: armed is a wait with history; paused is not; running is wake-running', () => {
    const armed = one(s('a', { wake: wake({ history: [{ slot: 1, dueAt: ago(H), outcome: 'ok' }], lastError: 'HTTP 500', consecutiveFailures: 2 }) }));
    expect(armed.waits).toEqual([{ kind: 'wake', nextAt: armed.wake!.nextWakeAt }]);
    expect(armed.wake).toMatchObject({ everyHours: 1, consecutiveFailures: 2, lastError: 'HTTP 500', history: [{ slot: 1 }] });
    expect(armed.wake!.nextIsFinal).toBeUndefined();
    const paused = one(s('a', { wake: wake({ pausedReason: 'expired', finalWakeAt: ago(H) }) }));
    expect(paused.waits).toEqual([]);
    expect(paused.wake).toMatchObject({ pausedReason: 'expired', finalWakeAt: ago(H) });
    expect(one(s('a', { wake: wake({ lastResult: 'running' }) })).waits).toEqual([{ kind: 'wake-running' }]);
  });

  it('wake.nextIsFinal: when the next fire is the final one, only while the loop runs and the wake is not paused', () => {
    expect(one(s('a', { lastUsedAt: ago(8 * D), wake: wake() })).wake!.nextIsFinal).toBe(true);
    expect(one(s('a', { lastUsedAt: ago(6 * D), wake: wake() })).wake!.nextIsFinal).toBeUndefined();
    expect(one(s('a', { lastUsedAt: ago(8 * D), wake: wake({ pausedReason: 'expired' }) })).wake!.nextIsFinal).toBeUndefined();
    expect(one(s('a', { lastUsedAt: ago(8 * D), wake: wake({ finalWakeAt: ago(H), lastResult: 'running' }) })).wake!.nextIsFinal).toBeUndefined();
    expect(one(s('a', { lastUsedAt: ago(8 * D), wake: wake() }), { wakeLoopEnabled: false }).wake!.nextIsFinal).toBeUndefined();
    expect(one(s('a', { lastUsedAt: ago(3 * D), wake: wake() }), { wakeExpireMs: 2 * D }).wake!.nextIsFinal).toBe(true);
  });

  it('wake loop disabled: an armed wake is not a wait, and the response says so', () => {
    const ov = build([s('a', { wake: wake() })], {}, { wakeLoopEnabled: false });
    expect(ov.wakeLoopEnabled).toBe(false);
    expect(ov.entries[0].waits).toEqual([]);
    expect(build([s('a', { wake: wake({ lastResult: 'running' }) })], {}, { wakeLoopEnabled: false }).entries[0].waits).toEqual([{ kind: 'wake-running' }]);
  });

  it('schedule: enabled with a next run is a wait; disabled is a fact', () => {
    const on = one(s('a', {}, { schedule: { slug: 'daily', enabled: true, nextRun: '2026-11-18T09:00:00.000Z', lastResult: 'success' } }));
    expect(on.waits).toEqual([{ kind: 'schedule', nextRun: '2026-11-18T09:00:00.000Z' }]);
    expect(on.schedule).toEqual({ slug: 'daily', enabled: true, nextRun: '2026-11-18T09:00:00.000Z', lastResult: 'success' });
    expect(one(s('a', {}, { schedule: { slug: 'x', enabled: false, nextRun: null } })).waits).toEqual([]);
  });

  it('herd: parent missing or archived; children and busy children', () => {
    expect(build([s('c', { orchestratedBy: 'gone' })]).entries[0].herd).toEqual({ parent: 'gone', parentState: 'missing' });
    expect(build([s('p', { folder: 'auto-archive' }), s('c', { orchestratedBy: 'p' })]).entries[0].herd).toEqual({ parent: 'p', parentState: 'archived' });
    const ov = build([s('p'), s('c1', { orchestratedBy: 'p' }, { busySince: NOW - MIN }), s('c2', { orchestratedBy: 'p' })]);
    const p = ov.entries.find(e => e.sessionId === 'p')!;
    expect(p.herd).toEqual({ children: 2, busyChildren: 1 });
    expect(p.waits).toEqual([{ kind: 'children', busy: 1 }]);
    expect(ov.entries.find(e => e.sessionId === 'c2')!.herd).toEqual({ parent: 'p', parentState: 'ok' });
  });

  it('context facts pass through, including status, error code and last error', () => {
    const e = one(s('a', {}, { tail: tail({ lastError: { at: ago(MIN), text: 'boom' } }) }));
    expect(e.context.lastError).toEqual({ at: ago(MIN), text: 'boom' });
    expect(one(s('a', {}, { tail: { context: { status: 'unavailable', errorCode: 'EBUSY' } } })).context).toEqual({ status: 'unavailable', errorCode: 'EBUSY' });
    expect(one(s('a', {}, { tail: undefined }), { contextRead: false }).context).toEqual({ status: 'not-read' });
  });
});

describe('show filters', () => {
  const sessions = () => [
    s('quiet'),
    s('offer', { responseOptions: ['Go'], responseOptionsAt: ago(H) }),
    s('dismissed', { responseOptions: ['Go'], responseOptionsAt: ago(H), pagerDismissedAt: ago(MIN) }),
    s('busy', {}, { busySince: NOW - 2 * H }),
    s('wake', { wake: wake() }),
  ];
  it('all, busy, wakes and waiting count omissions', () => {
    expect(build(sessions()).counts).toEqual({ total: 5, shown: 5, omitted: 0, archivedExcluded: 0 });
    expect(build(sessions(), { show: 'busy' }).entries.map(e => e.sessionId)).toEqual(['busy']);
    expect(build(sessions(), { show: 'wakes' }).entries.map(e => e.sessionId)).toEqual(['wake']);
    const waiting = build(sessions(), { show: 'waiting' });
    expect(waiting.entries.map(e => e.sessionId).sort()).toEqual(['dismissed', 'offer', 'wake']);
    expect(waiting.counts).toEqual({ total: 5, shown: 3, omitted: 2, archivedExcluded: 0 });
  });
  it('keys filter accepts composite and bare ids', () => {
    expect(build(sessions(), { keys: ['inst:offer', 'quiet'] }).entries.map(e => e.sessionId).sort()).toEqual(['offer', 'quiet']);
  });
});

describe('ordering (R2)', () => {
  it('last activity descending, then key; busy rows are not special-cased; missing sorts oldest', () => {
    const at = (x: string) => tail({ lastEventAt: x });
    const ov = build([
      s('b-mid', {}, { tail: at(ago(2 * H)) }),
      s('a-mid', {}, { tail: at(ago(2 * H)) }),
      s('new', {}, { tail: at(ago(MIN)) }),
      s('busy-old', { lastUsedAt: ago(9 * H) }, { busySince: NOW - 8 * H, tail: at(ago(8 * H)) }),
      s('none', { lastUsedAt: undefined }, { tail: { context: { status: 'no-events' } } }),
    ]);
    expect(ov.entries.map(e => e.sessionId)).toEqual(['new', 'a-mid', 'b-mid', 'busy-old', 'none']);
  });

  it('is stable under shuffled multi-instance input with equal timestamps', () => {
    const same = ago(2 * H);
    const mk = (id: string, name: string) => build(
      ['x', 'y', 'z'].map(n => s(`${id}-${n}`, {}, { tail: tail({ lastEventAt: same }) })), {},
      { instance: { id, name } },
    );
    const parts = [mk('i1', 'one'), mk('i2', 'two'), mk('i3', 'three')];
    const order = (ps: SessionOverview[]) => mergeSessionOverviews(ps).entries.map(e => e.key);
    const base = order(parts);
    expect(base).toEqual([...base].sort());
    for (const o of [[2, 0, 1], [1, 2, 0], [2, 1, 0]]) expect(order(o.map(i => parts[i]))).toEqual(base);
    const e = parts[0].entries[0];
    expect(compareEntries(e, e)).toBe(0);
  });
});

describe('duplicateOn (R3)', () => {
  it('is set on every copy of a session id seen on two or more instances', () => {
    const a = build([s('shared'), s('only-a')], {}, { instance: { id: 'ia', name: 'laptop' } });
    const b = build([s('shared'), s('only-b')], {}, { instance: { id: 'ib', name: 'devbox' } });
    const c = build([s('shared')], {}, { instance: { id: 'ic', name: '' } });
    const m = mergeSessionOverviews([a, b, c]);
    const shared = m.entries.filter(e => e.sessionId === 'shared');
    expect(shared).toHaveLength(3);
    expect(shared.find(e => e.instance.id === 'ia')!.duplicateOn).toEqual(['devbox', 'ic']);
    expect(shared.find(e => e.instance.id === 'ib')!.duplicateOn).toEqual(['ic', 'laptop']);
    expect(shared.find(e => e.instance.id === 'ic')!.duplicateOn).toEqual(['devbox', 'laptop']);
    expect(m.entries.filter(e => e.sessionId !== 'shared').every(e => e.duplicateOn === undefined)).toBe(true);
  });

  it('is recomputed on re-merge, never stacked', () => {
    const a = build([s('shared')], {}, { instance: { id: 'ia', name: 'laptop' } });
    const b = build([s('shared')], {}, { instance: { id: 'ib', name: 'devbox' } });
    const first = mergeSessionOverviews([a, b]).entries.filter(e => e.instance.id === 'ia');
    const again = mergeSessionOverviews([{ ...a, entries: first }]);
    expect(again.entries[0].duplicateOn).toBeUndefined();
  });
});
