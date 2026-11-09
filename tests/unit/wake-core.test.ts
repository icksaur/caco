import { describe, it, expect } from 'vitest';
import {
  parseWakeWindow, inWindow, nextWindowStart, decideWake, isExpired, buildWakePrompt, formatElapsed,
  type WakeWindow, type WakeDecisionInput,
} from '../../src/wake-core.js';
import type { WakeState } from '../../src/session-meta-store.js';

const H = 60 * 60 * 1000;
const D = 24 * H;

describe('parseWakeWindow', () => {
  it('parses the default weekday window in server-local time', () => {
    const w = parseWakeWindow('Mon-Fri 07:00-19:00') as WakeWindow;
    expect([...w.days].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(w.startMin).toBe(420);
    expect(w.endMin).toBe(1140);
    expect(w.timeZone).toBeUndefined();
  });

  it('accepts an IANA zone, day lists, and wrapping ranges', () => {
    const w = parseWakeWindow('Sat,Sun 09:00-12:00 America/Los_Angeles') as WakeWindow;
    expect([...w.days].sort()).toEqual([0, 6]);
    expect(w.timeZone).toBe('America/Los_Angeles');
    expect([...(parseWakeWindow('Fri-Mon 08:00-09:00') as WakeWindow).days].sort()).toEqual([0, 1, 5, 6]);
  });

  it('"always" means no window', () => {
    expect(parseWakeWindow('always')).toBeNull();
  });

  it.each(['Mon-Fri', 'Mon-Fri 19:00-07:00', 'Funday 07:00-08:00', 'Mon 07:00-08:00 Not/AZone', 'Mon 7-8'])('rejects %s', (spec) => {
    expect(() => parseWakeWindow(spec)).toThrow();
  });
});

describe('window math', () => {
  const utc = parseWakeWindow('Mon-Fri 07:00-19:00 UTC') as WakeWindow;
  const la = parseWakeWindow('Mon-Fri 07:00-19:00 America/Los_Angeles') as WakeWindow;

  it('inWindow respects day and hours in the configured zone', () => {
    expect(inWindow(Date.parse('2026-11-09T10:00:00Z'), utc)).toBe(true); // Monday
    expect(inWindow(Date.parse('2026-11-09T19:00:00Z'), utc)).toBe(false); // end is exclusive
    expect(inWindow(Date.parse('2026-11-07T10:00:00Z'), utc)).toBe(false); // Saturday
    // 15:00Z Monday is 07:00 PST.
    expect(inWindow(Date.parse('2026-11-09T15:00:00Z'), la)).toBe(true);
    expect(inWindow(Date.parse('2026-11-09T14:59:00Z'), la)).toBe(false);
  });

  it('a Saturday instant opens at Monday 07:00 (A7)', () => {
    expect(nextWindowStart(Date.parse('2026-11-07T12:00:00Z'), utc)).toBe(Date.parse('2026-11-09T07:00:00Z'));
    expect(nextWindowStart(Date.parse('2026-11-07T12:00:00Z'), la)).toBe(Date.parse('2026-11-09T15:00:00Z'));
  });

  it('after hours on a weekday opens next morning; before hours opens the same day', () => {
    expect(nextWindowStart(Date.parse('2026-11-10T20:00:00Z'), utc)).toBe(Date.parse('2026-11-11T07:00:00Z'));
    expect(nextWindowStart(Date.parse('2026-11-10T05:00:00Z'), utc)).toBe(Date.parse('2026-11-10T07:00:00Z'));
  });

  it('handles a DST change in the zone (2026-11-01 PDT -> PST)', () => {
    // Saturday 2026-10-31: Monday 2026-11-02 07:00 PST = 15:00Z.
    expect(nextWindowStart(Date.parse('2026-10-31T18:00:00Z'), la)).toBe(Date.parse('2026-11-02T15:00:00Z'));
  });
});

const NOW = Date.parse('2026-11-09T16:00:00Z'); // Monday

function wake(over: Partial<WakeState> = {}): WakeState {
  return { everyMinutes: 60, registeredAt: new Date(NOW - 2 * H).toISOString(), nextWakeAt: new Date(NOW - 1000).toISOString(), consecutiveFailures: 0, ...over };
}

function input(over: Partial<WakeDecisionInput> = {}): WakeDecisionInput {
  return {
    wake: wake(), nowMs: NOW, lastHumanAt: new Date(NOW - 3 * H).toISOString(), busy: false, runningCount: 0,
    window: null, expireMs: 7 * D, humanQuietMs: 30 * 60 * 1000, maxRunning: 2, ...over,
  };
}

describe('decideWake', () => {
  it('fires a due wake', () => {
    expect(decideWake(input())).toEqual({ kind: 'fire', final: false });
  });

  it('skips paused, running, and not-due wakes', () => {
    expect(decideWake(input({ wake: wake({ pausedReason: 'failures' }) })).kind).toBe('paused');
    expect(decideWake(input({ wake: wake({ lastResult: 'running' }) })).kind).toBe('running');
    expect(decideWake(input({ wake: wake({ nextWakeAt: new Date(NOW + 1000).toISOString() }) })).kind).toBe('not-due');
  });

  it('defers a busy session, a recent human message, and the concurrency cap (A5, D)', () => {
    expect(decideWake(input({ busy: true })).kind).toBe('defer-busy');
    expect(decideWake(input({ lastHumanAt: new Date(NOW - 10 * 60 * 1000).toISOString() })).kind).toBe('defer-human');
    expect(decideWake(input({ runningCount: 2 })).kind).toBe('defer-concurrency');
    expect(decideWake(input({ runningCount: 1 })).kind).toBe('fire');
  });

  it('defers off-hours to the next window start', () => {
    const win = parseWakeWindow('Mon-Fri 07:00-19:00 UTC');
    const sat = Date.parse('2026-11-07T12:00:00Z');
    expect(decideWake(input({ nowMs: sat, window: win, wake: wake({ nextWakeAt: new Date(sat - 1000).toISOString() }) })))
      .toEqual({ kind: 'defer-window', nextAtMs: Date.parse('2026-11-09T07:00:00Z') });
  });

  it('an expired wake fires once as the final wake (C)', () => {
    expect(decideWake(input({ lastHumanAt: new Date(NOW - 8 * D).toISOString() }))).toEqual({ kind: 'fire', final: true });
  });
});

describe('isExpired keys on human activity only (B)', () => {
  it('uses lastUsedAt when present, so re-registering does not extend the wake', () => {
    const fresh = wake({ registeredAt: new Date(NOW - 60 * 1000).toISOString() });
    expect(isExpired(fresh, new Date(NOW - 8 * D).toISOString(), NOW, 7 * D)).toBe(true);
  });

  it('falls back to registeredAt for a session no human wrote to', () => {
    expect(isExpired(wake({ registeredAt: new Date(NOW - 8 * D).toISOString() }), undefined, NOW, 7 * D)).toBe(true);
    expect(isExpired(wake(), undefined, NOW, 7 * D)).toBe(false);
  });
});

describe('buildWakePrompt', () => {
  it('carries local time, time since registration, the note, and the clear instruction (A4)', () => {
    const p = buildWakePrompt({ nowMs: NOW, wake: wake({ note: 'waiting on PR 5504426 review' }), final: false, timeZone: 'UTC', expireDays: 7 });
    expect(p).toContain('Local time Mon 2026-11-09 16:00 UTC');
    expect(p).toContain('Registered 2h 0m ago.');
    expect(p).toContain('Note: waiting on PR 5504426 review');
    expect(p).toContain('call caco_wake with action "clear"');
  });

  it('uses time since the last wake when there is one, and omits an absent note', () => {
    const p = buildWakePrompt({ nowMs: NOW, wake: wake({ lastWakeAt: new Date(NOW - 4 * H - 2 * 60000).toISOString() }), final: false, expireDays: 7 });
    expect(p).toContain('Last wake 4h 2m ago.');
    expect(p).not.toContain('Note:');
  });

  it('the final wake asks for a caco-actions renewal offer', () => {
    const p = buildWakePrompt({ nowMs: NOW, wake: wake(), final: true, expireDays: 7 });
    expect(p).toContain('FINAL wake');
    expect(p).toContain('caco-actions');
    expect(p).toContain('action "set"');
    expect(p).not.toContain('action "clear"');
  });

  it('formatElapsed', () => {
    expect(formatElapsed(45 * 60000)).toBe('45m');
    expect(formatElapsed(2 * D + 3 * H)).toBe('2d 3h');
  });
});
