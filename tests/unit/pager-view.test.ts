import { describe, it, expect } from 'vitest';
import {
  needsTriage,
  buildPagerView,
  PAGER_MAX_WAITING,
  type PagerSessionInput,
} from '../../src/pager-view.js';

function input(over: Partial<PagerSessionInput> = {}): PagerSessionInput {
  return {
    sessionId: 'sess-0001',
    name: 'a session',
    cwd: '/w',
    kind: 'interactive',
    isBusy: false,
    isUnobserved: true,
    responseOptions: ['do the thing'],
    lastIdleAt: '2026-08-03T10:00:00.000Z',
    ...over,
  };
}

describe('needsTriage', () => {
  // Hand table: every combination of the three terms, with the expected value
  // computed by hand from the rule "not busy AND unobserved AND has options".
  // `undefined` options is the COMMON case (the write is guarded on length), so
  // it is a first-class row rather than an afterthought.
  const cases: Array<{ busy: boolean; unobserved: boolean; options: string[] | undefined; expected: boolean }> = [
    { busy: false, unobserved: true, options: ['x'], expected: true },
    { busy: false, unobserved: true, options: ['x', 'y'], expected: true },
    { busy: false, unobserved: true, options: [], expected: false },
    { busy: false, unobserved: true, options: undefined, expected: false },
    { busy: false, unobserved: false, options: ['x'], expected: false },
    { busy: false, unobserved: false, options: [], expected: false },
    { busy: false, unobserved: false, options: undefined, expected: false },
    { busy: true, unobserved: true, options: ['x'], expected: false },
    { busy: true, unobserved: true, options: [], expected: false },
    { busy: true, unobserved: true, options: undefined, expected: false },
    { busy: true, unobserved: false, options: ['x'], expected: false },
    { busy: true, unobserved: false, options: undefined, expected: false },
  ];

  for (const c of cases) {
    const label = `busy=${c.busy} unobserved=${c.unobserved} options=${c.options === undefined ? 'absent' : JSON.stringify(c.options)}`;
    it(`${label} => ${c.expected}`, () => {
      expect(needsTriage(input({ isBusy: c.busy, isUnobserved: c.unobserved, responseOptions: c.options }))).toBe(c.expected);
    });
  }

  it('does not throw when responseOptions is absent', () => {
    const bare = input({ responseOptions: undefined });
    delete (bare as { responseOptions?: string[] }).responseOptions;
    expect(() => needsTriage(bare)).not.toThrow();
    expect(needsTriage(bare)).toBe(false);
  });
});

describe('buildPagerView', () => {
  it('matches an independently constructed snapshot', () => {
    const inputs: PagerSessionInput[] = [
      // busy: counted in busy, never in waiting
      input({ sessionId: 'busy-01', name: 'worker', isBusy: true, isUnobserved: false, responseOptions: undefined }),
      // waiting, older
      input({ sessionId: 'wait-01', name: 'older', lastIdleAt: '2026-08-03T09:00:00.000Z', responseOptions: ['resume A'] }),
      // observed already: excluded
      input({ sessionId: 'seen-01', name: 'seen', isUnobserved: false, responseOptions: ['ignored'] }),
      // waiting, newer
      input({ sessionId: 'wait-02', name: 'newer', lastIdleAt: '2026-08-03T11:00:00.000Z', responseOptions: ['resume B', 'resume C'] }),
      // no options: excluded
      input({ sessionId: 'none-01', name: 'quiet', responseOptions: undefined }),
    ];

    // Expected written out by hand, NOT derived from the production function.
    const expected = {
      version: 7,
      busyCount: 3,
      busy: [{ sessionId: 'busy-01', name: 'worker' }],
      waiting: [
        {
          sessionId: 'wait-02',
          name: 'newer',
          cwd: '/w',
          kind: 'interactive',
          idleAt: '2026-08-03T11:00:00.000Z',
          options: ['resume B', 'resume C'],
        },
        {
          sessionId: 'wait-01',
          name: 'older',
          cwd: '/w',
          kind: 'interactive',
          idleAt: '2026-08-03T09:00:00.000Z',
          options: ['resume A'],
        },
      ],
      waitingTruncated: false,
    };

    expect(buildPagerView(inputs, 3, 7)).toEqual(expected);
  });

  it('passes option text through byte-exactly', () => {
    const tricky = ['Push “smart quotes” & <script>alert(1)</script>', 'Ünïcödé — em‑dash, 100%'];
    const view = buildPagerView([input({ responseOptions: tricky })], 0, 1);
    expect(view.waiting[0].options).toEqual(tricky);
  });

  it('caps waiting at PAGER_MAX_WAITING and flags the truncation', () => {
    const many = Array.from({ length: PAGER_MAX_WAITING + 5 }, (_, i) =>
      input({ sessionId: `s-${String(i).padStart(3, '0')}`, lastIdleAt: `2026-08-03T10:${String(i % 60).padStart(2, '0')}:00.000Z` }));
    const view = buildPagerView(many, 0, 1);
    expect(view.waiting.length).toBe(PAGER_MAX_WAITING);
    expect(view.waitingTruncated).toBe(true);
  });

  it('does not flag truncation at exactly the cap', () => {
    const exact = Array.from({ length: PAGER_MAX_WAITING }, (_, i) => input({ sessionId: `s-${i}` }));
    const view = buildPagerView(exact, 0, 1);
    expect(view.waiting.length).toBe(PAGER_MAX_WAITING);
    expect(view.waitingTruncated).toBe(false);
  });

  it('reports an empty board without inventing entries', () => {
    expect(buildPagerView([], 0, 3)).toEqual({
      version: 3, busyCount: 0, busy: [], waiting: [], waitingTruncated: false,
    });
  });

  it('treats a missing lastIdleAt as oldest rather than dropping the session', () => {
    const view = buildPagerView([
      input({ sessionId: 'no-date', lastIdleAt: undefined }),
      input({ sessionId: 'dated', lastIdleAt: '2026-08-03T10:00:00.000Z' }),
    ], 0, 1);
    expect(view.waiting.map(w => w.sessionId)).toEqual(['dated', 'no-date']);
    expect(view.waiting[1].idleAt).toBeNull();
  });
});

describe('buildPagerView ordering', () => {
  it('is deterministic under input shuffling', () => {
    // Equal timestamps force the sessionId tie-break to decide, so a stable sort
    // over input order would NOT be enough to make this pass.
    const same = '2026-08-03T10:00:00.000Z';
    const ids = ['s-c', 's-a', 's-e', 's-b', 's-d'];
    const forward = buildPagerView(ids.map(id => input({ sessionId: id, lastIdleAt: same })), 0, 1);
    const reversed = buildPagerView([...ids].reverse().map(id => input({ sessionId: id, lastIdleAt: same })), 0, 1);

    expect(forward.waiting.map(w => w.sessionId)).toEqual(['s-a', 's-b', 's-c', 's-d', 's-e']);
    expect(reversed.waiting.map(w => w.sessionId)).toEqual(forward.waiting.map(w => w.sessionId));
  });

  it('orders newest idle first', () => {
    const view = buildPagerView([
      input({ sessionId: 'mid', lastIdleAt: '2026-08-03T10:00:00.000Z' }),
      input({ sessionId: 'new', lastIdleAt: '2026-08-03T12:00:00.000Z' }),
      input({ sessionId: 'old', lastIdleAt: '2026-08-03T08:00:00.000Z' }),
    ], 0, 1);
    expect(view.waiting.map(w => w.sessionId)).toEqual(['new', 'mid', 'old']);
  });
});
