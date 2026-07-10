import { describe, it, expect } from 'vitest';
import { decideAutoContinue, AUTO_CONTINUE_CAP } from '../../src/auto-continue.js';

describe('decideAutoContinue', () => {
  const cap = AUTO_CONTINUE_CAP;

  it('fires when a reveal is pending, session is idle, and under the cap', () => {
    expect(decideAutoContinue({ hasPending: true, busy: false, attempts: 0, cap })).toBe('fire');
    expect(decideAutoContinue({ hasPending: true, busy: false, attempts: cap - 1, cap })).toBe('fire');
  });

  it('skips when nothing is pending', () => {
    expect(decideAutoContinue({ hasPending: false, busy: false, attempts: 0, cap })).toBe('skip');
    // even at/over cap, no pending ⇒ skip (never cap-reached)
    expect(decideAutoContinue({ hasPending: false, busy: false, attempts: cap, cap })).toBe('skip');
  });

  it('skips when the session is busy (busy precedes cap so no terminal message)', () => {
    expect(decideAutoContinue({ hasPending: true, busy: true, attempts: 0, cap })).toBe('skip');
    expect(decideAutoContinue({ hasPending: true, busy: true, attempts: cap, cap })).toBe('skip');
  });

  it('reports cap-reached when pending + idle but at/over the cap', () => {
    expect(decideAutoContinue({ hasPending: true, busy: false, attempts: cap, cap })).toBe('cap-reached');
    expect(decideAutoContinue({ hasPending: true, busy: false, attempts: cap + 1, cap })).toBe('cap-reached');
  });

  it('default cap is 3', () => {
    expect(AUTO_CONTINUE_CAP).toBe(3);
  });
});
