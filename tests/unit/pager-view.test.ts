import { describe, it, expect } from 'vitest';
import {
  needsTriage,
  buildPagerView,
  offerAtOf,
  PAGER_MAX_WAITING,
  PAGER_MAX_OFFER_AGE_MS,
  type PagerSessionInput,
} from '../../src/pager-view.js';

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const DAY = 86400000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function input(over: Partial<PagerSessionInput> = {}): PagerSessionInput {
  return {
    sessionId: 'sess-0001',
    name: 'a session',
    cwd: '/w',
    kind: 'interactive',
    isBusy: false,
    responseOptions: ['do the thing'],
    responseOptionsAt: ago(DAY),
    ...over,
  };
}

describe('offerAtOf', () => {
  it('prefers the offer stamp', () => {
    expect(offerAtOf(input({ responseOptionsAt: ago(DAY), lastIdleAt: ago(5 * DAY) }))).toBe(NOW - DAY);
  });

  // Offers written before responseOptionsAt existed must not be invisible forever.
  // lastIdleAt is a sound stand-in: the turn that wrote the options is the turn
  // that then idled, so for a session still holding options they describe the
  // same moment.
  it('falls back to lastIdleAt when the offer stamp is absent', () => {
    expect(offerAtOf(input({ responseOptionsAt: undefined, lastIdleAt: ago(3 * DAY) }))).toBe(NOW - 3 * DAY);
  });

  it('reports unknown when neither timestamp exists', () => {
    expect(offerAtOf(input({ responseOptionsAt: undefined, lastIdleAt: undefined }))).toBeNull();
  });

  it('reports unknown for an unparseable timestamp rather than a NaN age', () => {
    expect(offerAtOf(input({ responseOptionsAt: 'not-a-date', lastIdleAt: undefined }))).toBeNull();
  });
});

describe('needsTriage', () => {
  // Hand table over the four terms. Expected values computed by hand from the
  // rule: not busy AND has options AND offer newer than any dismissal AND offer
  // within the freshness window. Unobserved state is deliberately not a term.
  const cases: Array<{ label: string; over: Partial<PagerSessionInput>; expected: boolean }> = [
    { label: 'fresh, undismissed, idle, with options', over: {}, expected: true },
    { label: 'busy', over: { isBusy: true }, expected: false },
    { label: 'no options (absent)', over: { responseOptions: undefined }, expected: false },
    { label: 'no options (empty)', over: { responseOptions: [] }, expected: false },
    { label: 'dismissed after the offer', over: { pagerDismissedAt: ago(0) }, expected: false },
    { label: 'dismissed exactly at the offer', over: { pagerDismissedAt: ago(DAY) }, expected: false },
    { label: 'dismissed before the offer', over: { pagerDismissedAt: ago(2 * DAY) }, expected: true },
    { label: 'offer older than the window', over: { responseOptionsAt: ago(8 * DAY) }, expected: false },
    { label: 'offer at the window edge', over: { responseOptionsAt: new Date(NOW - PAGER_MAX_OFFER_AGE_MS).toISOString() }, expected: true },
    { label: 'offer one ms past the edge', over: { responseOptionsAt: new Date(NOW - PAGER_MAX_OFFER_AGE_MS - 1).toISOString() }, expected: false },
    { label: 'no timestamps at all', over: { responseOptionsAt: undefined, lastIdleAt: undefined }, expected: false },
    { label: 'stale offer AND dismissed', over: { responseOptionsAt: ago(30 * DAY), pagerDismissedAt: ago(29 * DAY) }, expected: false },
    // Agent-driven sessions are drained by whoever drives them, so their offers
    // are not the user's to action. This exclusion used to be an accident of
    // gating on isUnobserved; dropping that gate would have admitted them.
    { label: 'herd child by kind', over: { kind: 'agent' }, expected: false },
    { label: 'swarm session', over: { kind: 'swarm' }, expected: false },
    { label: 'herd child by bond', over: { orchestratedBy: 'parent-1' }, expected: false },
    // A scheduled run that finished overnight with nobody watching is exactly
    // what a pager is for; the old coupling hid these too.
    { label: 'scheduled run', over: { kind: 'scheduled' }, expected: true },
  ];

  for (const c of cases) {
    it(`${c.label} => ${c.expected}`, () => {
      expect(needsTriage(input(c.over), NOW)).toBe(c.expected);
    });
  }

  // The whole point of the change: another client viewing the session must not
  // remove it from the board, so the predicate must not consult that state.
  it('is unaffected by whether the session has been observed elsewhere', () => {
    const withExtra = { ...input(), isUnobserved: false } as PagerSessionInput & { isUnobserved: boolean };
    expect(needsTriage(withExtra, NOW)).toBe(true);
  });

  it('does not throw when responseOptions is absent', () => {
    const bare = input({ responseOptions: undefined });
    delete (bare as { responseOptions?: string[] }).responseOptions;
    expect(() => needsTriage(bare, NOW)).not.toThrow();
    expect(needsTriage(bare, NOW)).toBe(false);
  });

  it('re-admits a session once a NEWER offer outranks the dismissal', () => {
    const dismissedAt = ago(2 * DAY);
    expect(needsTriage(input({ responseOptionsAt: ago(3 * DAY), pagerDismissedAt: dismissedAt }), NOW)).toBe(false);
    expect(needsTriage(input({ responseOptionsAt: ago(DAY), pagerDismissedAt: dismissedAt }), NOW)).toBe(true);
  });
});

describe('buildPagerView', () => {
  it('matches an independently constructed snapshot', () => {
    const inputs: PagerSessionInput[] = [
      input({ sessionId: 'busy-01', name: 'worker', isBusy: true, responseOptions: undefined }),
      input({ sessionId: 'wait-01', name: 'older', responseOptionsAt: ago(3 * DAY), responseOptions: ['resume A'] }),
      input({ sessionId: 'stale-1', name: 'stale', responseOptionsAt: ago(20 * DAY), responseOptions: ['too old'] }),
      input({ sessionId: 'wait-02', name: 'newer', responseOptionsAt: ago(DAY), responseOptions: ['resume B', 'resume C'] }),
      input({ sessionId: 'none-01', name: 'quiet', responseOptions: undefined }),
      input({ sessionId: 'dism-01', name: 'dismissed', responseOptionsAt: ago(2 * DAY), pagerDismissedAt: ago(DAY) }),
    ];

    // Expected written out by hand, NOT derived from the production function.
    const expected = {
      version: 7,
      busyCount: 3,
      busy: [{ sessionId: 'busy-01', name: 'worker' }],
      waiting: [
        { sessionId: 'wait-02', name: 'newer', cwd: '/w', kind: 'interactive', idleAt: ago(DAY), options: ['resume B', 'resume C'] },
        { sessionId: 'wait-01', name: 'older', cwd: '/w', kind: 'interactive', idleAt: ago(3 * DAY), options: ['resume A'] },
      ],
      waitingTruncated: false,
    };

    expect(buildPagerView(inputs, 3, 7, NOW)).toEqual(expected);
  });

  it('passes option text through byte-exactly', () => {
    const tricky = ['Push “smart quotes” & <script>alert(1)</script>', 'Ünïcödé — em‑dash, 100%'];
    const view = buildPagerView([input({ responseOptions: tricky })], 0, 1, NOW);
    expect(view.waiting[0].options).toEqual(tricky);
  });

  it('caps waiting at PAGER_MAX_WAITING and flags the truncation', () => {
    const many = Array.from({ length: PAGER_MAX_WAITING + 5 }, (_, i) =>
      input({ sessionId: `s-${String(i).padStart(3, '0')}`, responseOptionsAt: ago(i * 1000) }));
    const view = buildPagerView(many, 0, 1, NOW);
    expect(view.waiting.length).toBe(PAGER_MAX_WAITING);
    expect(view.waitingTruncated).toBe(true);
  });

  it('does not flag truncation at exactly the cap', () => {
    const exact = Array.from({ length: PAGER_MAX_WAITING }, (_, i) => input({ sessionId: `s-${i}` }));
    const view = buildPagerView(exact, 0, 1, NOW);
    expect(view.waiting.length).toBe(PAGER_MAX_WAITING);
    expect(view.waitingTruncated).toBe(false);
  });

  it('reports an empty board without inventing entries', () => {
    expect(buildPagerView([], 0, 3, NOW)).toEqual({
      version: 3, busyCount: 0, busy: [], waiting: [], waitingTruncated: false,
    });
  });

  it('surfaces a legacy offer dated only by lastIdleAt', () => {
    const view = buildPagerView(
      [input({ sessionId: 'legacy', responseOptionsAt: undefined, lastIdleAt: ago(2 * DAY) })], 0, 1, NOW);
    expect(view.waiting.map(w => w.sessionId)).toEqual(['legacy']);
    expect(view.waiting[0].idleAt).toBe(ago(2 * DAY));
  });
});

describe('buildPagerView ordering', () => {
  it('is deterministic under input shuffling', () => {
    // Equal timestamps force the sessionId tie-break to decide, so a stable sort
    // over input order would NOT be enough to make this pass.
    const same = ago(DAY);
    const ids = ['s-c', 's-a', 's-e', 's-b', 's-d'];
    const forward = buildPagerView(ids.map(id => input({ sessionId: id, responseOptionsAt: same })), 0, 1, NOW);
    const reversed = buildPagerView([...ids].reverse().map(id => input({ sessionId: id, responseOptionsAt: same })), 0, 1, NOW);

    expect(forward.waiting.map(w => w.sessionId)).toEqual(['s-a', 's-b', 's-c', 's-d', 's-e']);
    expect(reversed.waiting.map(w => w.sessionId)).toEqual(forward.waiting.map(w => w.sessionId));
  });

  it('orders newest offer first', () => {
    const view = buildPagerView([
      input({ sessionId: 'mid', responseOptionsAt: ago(2 * DAY) }),
      input({ sessionId: 'new', responseOptionsAt: ago(1000) }),
      input({ sessionId: 'old', responseOptionsAt: ago(5 * DAY) }),
    ], 0, 1, NOW);
    expect(view.waiting.map(w => w.sessionId)).toEqual(['new', 'mid', 'old']);
  });
});
