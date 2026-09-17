/**
 * Pound-completion session label (spec-auto-name-sessions, spec-report-intent-tool).
 *
 * The `#` autocomplete in the chat input searches sessions by their label. When
 * a session's title comes from `autoName` (a report_intent-latched auto-title),
 * the pound provider MUST use the same title-ladder the session list uses;
 * otherwise the user sees "fix routing bug" in the sidebar but the picker only
 * exposes a hex slug, and the session is unfindable.
 *
 * This test isolates the mapping used inside `registerPoundProvider` in main.ts.
 * It does not exercise the full registry — that would need a DOM harness — but
 * pins the string projection so a future edit that drops `autoName` from the
 * ladder fails here rather than in the field.
 */

import { describe, it, expect } from 'vitest';
import type { SessionData } from '../../public/ts/types.js';
import { displayTitleFor, truncateForTitle, NO_SUMMARY } from '../../public/ts/session-title.js';

// Mirrors the mapping in public/ts/main.ts::registerPoundProvider. Kept small
// and dependency-free so the rule under test is legible in one place.
function poundLabelFor(s: SessionData): string {
  const ladderTitle = displayTitleFor(s);
  return ladderTitle === NO_SUMMARY
    ? s.sessionId.slice(0, 8)
    : truncateForTitle(ladderTitle);
}

function make(over: Partial<SessionData>): SessionData {
  return { sessionId: '8467f5a5-5093-426f-b6a4-e7923f4de4d7', ...over };
}

describe('pound-completion session label', () => {
  it('uses meta.name when present (unchanged from prior behavior)', () => {
    expect(poundLabelFor(make({ name: 'my chat' }))).toBe('my chat');
  });

  it('falls back to workspace.summary when name is empty', () => {
    expect(poundLabelFor(make({ name: '', summary: 'triage bugs' }))).toBe('triage bugs');
  });

  it('falls back to autoName when name AND summary are empty (the fix)', () => {
    // Regression: before this fix the label showed the sessionId slice for
    // report_intent-latched sessions, making the auto-titled sidebar entry
    // unfindable via # completion even though it was visible.
    expect(poundLabelFor(make({ name: '', summary: undefined, autoName: 'fix routing bug' }))).toBe('fix routing bug');
  });

  it('falls back to sessionId slice when every ladder level is empty', () => {
    expect(poundLabelFor(make({}))).toBe('8467f5a5');
  });

  it('treats whitespace-only fields as empty (matches server hasValidText)', () => {
    expect(poundLabelFor(make({ name: '   ', summary: '', autoName: 'triage email' }))).toBe('triage email');
  });

  it('truncates a long autoName the same way the sidebar does', () => {
    // The pound picker is a narrow popup — a 100-char autoName clipped in
    // the sidebar must clip in the picker too, or the two labels drift.
    const longAuto = 'a'.repeat(100);
    const label = poundLabelFor(make({ name: '', autoName: longAuto }));
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan(longAuto.length);
  });
});
