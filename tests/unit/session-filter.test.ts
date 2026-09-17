/**
 * Session-list fuzzy filter (session-title-fuzzyfind).
 *
 * The filter uses `displayTitleFor` so it matches whatever label the user
 * SEES in the sidebar — meta.name, workspace summary, or the auto-name
 * latched from `report_intent` (spec-report-intent-tool). This test pins the
 * pure predicate: DOM, event wiring, and focus preservation are exercised in
 * the running app, not here.
 */

import { describe, it, expect } from 'vitest';
import type { SessionData } from '../../public/ts/types.js';
import { filterSessionsByQuery } from '../../public/ts/session-panel.js';

function make(over: Partial<SessionData>): SessionData {
  return { sessionId: 'abcd1234-0000-0000-0000-000000000000', ...over };
}

const sessions: SessionData[] = [
  make({ sessionId: 'sess-1', name: 'triage email' }),
  make({ sessionId: 'sess-2', summary: 'fix routing bug' }),
  make({ sessionId: 'sess-3', autoName: 'capacity planning' }),
  make({ sessionId: 'sess-4' }),
];

describe('filterSessionsByQuery', () => {
  it('returns every session unchanged for an empty query', () => {
    expect(filterSessionsByQuery(sessions, '')).toEqual(sessions);
  });

  it('returns every session unchanged for a whitespace-only query', () => {
    // Spec: "When fuzzy is empty string OR whitespace only, no fuzzy find
    // happens, and all sessions are shown."
    expect(filterSessionsByQuery(sessions, '   \t\n')).toEqual(sessions);
  });

  it('matches sessions with a title from meta.name', () => {
    const r = filterSessionsByQuery(sessions, 'trg');
    expect(r.map(s => s.sessionId)).toEqual(['sess-1']);
  });

  it('matches sessions with a title from workspace.summary', () => {
    const r = filterSessionsByQuery(sessions, 'rout');
    expect(r.map(s => s.sessionId)).toEqual(['sess-2']);
  });

  it('matches auto-named sessions via the displayTitleFor ladder', () => {
    // Regression guard: dropping autoName from displayTitleFor would silently
    // strand report_intent-labeled sessions here.
    const r = filterSessionsByQuery(sessions, 'cap');
    expect(r.map(s => s.sessionId)).toEqual(['sess-3']);
  });

  it('is case-insensitive', () => {
    expect(filterSessionsByQuery(sessions, 'ROUT').map(s => s.sessionId)).toEqual(['sess-2']);
    expect(filterSessionsByQuery(sessions, 'RoUt').map(s => s.sessionId)).toEqual(['sess-2']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterSessionsByQuery(sessions, 'xyznomatch')).toEqual([]);
  });

  it('drops sessions whose title falls back to "No summary"', () => {
    // sess-4 has no name/summary/autoName — its ladder title is the fallback
    // "No summary". A search for "rout" must not drag it along.
    const r = filterSessionsByQuery(sessions, 'rout');
    expect(r.some(s => s.sessionId === 'sess-4')).toBe(false);
  });

  it('supports fuzzy sub-sequence matching, not just substring', () => {
    // fuzzyScore accepts non-contiguous character runs; a user typing "trmg"
    // should still find "triage email" (t-r-i-a-g-e-e-m-a-i-l → t..r..g..).
    // Wait — the letters "trmg" don't appear as a subsequence in "triage email".
    // Use a real subsequence: "tem" (t..e..m) — matches "triage email" via
    // t(riage) e(mail) but not "capacity planning".
    const r = filterSessionsByQuery(sessions, 'tem');
    expect(r.map(s => s.sessionId)).toContain('sess-1');
    expect(r.map(s => s.sessionId)).not.toContain('sess-3');
  });

  it('does not mutate the input array', () => {
    const copy = [...sessions];
    filterSessionsByQuery(sessions, 'trg');
    expect(sessions).toEqual(copy);
  });
});
