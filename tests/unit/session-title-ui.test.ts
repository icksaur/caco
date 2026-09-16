/**
 * UI title helpers (spec-auto-name-sessions, Oracles 8 + 9).
 *
 * Tests the pure functions in public/ts/session-title.ts — the ladder pick,
 * truncation, and the sub-line suppression predicate. The heavy DOM path (the
 * actual span-render) is covered indirectly by tests/unit/session-panel.test.ts
 * via its render assertions; here we isolate the logic so a regression can be
 * traced to one predicate, not the whole panel.
 */

import { describe, it, expect } from 'vitest';
import type { SessionData } from '../../public/ts/types.js';
import {
  displayTitleFor,
  truncateForTitle,
  shouldSuppressIntentSubline,
  TITLE_MAX_CHARS,
  NO_SUMMARY,
} from '../../public/ts/session-title.js';

function s(over: Partial<SessionData>): SessionData {
  return { sessionId: 'sess-1', ...over };
}

// ============================================================================
// Oracle 8: UI title render + truncation
// ============================================================================

describe('displayTitleFor — ladder', () => {
  it("picks name → summary → autoName → 'No summary'", () => {
    // name wins
    expect(displayTitleFor(s({ name: 'my chat', summary: 's', autoName: 'a' }))).toBe('my chat');
    // summary wins when name is empty
    expect(displayTitleFor(s({ name: '', summary: 'work', autoName: 'a' }))).toBe('work');
    // autoName wins when both above are empty/null
    expect(displayTitleFor(s({ name: '', summary: undefined, autoName: 'first intent' }))).toBe('first intent');
    // NO_SUMMARY when nothing populated
    expect(displayTitleFor(s({}))).toBe(NO_SUMMARY);
  });

  it('treats empty-string name/summary as falsy (falls through)', () => {
    expect(displayTitleFor(s({ name: '', summary: '', autoName: 'first intent' }))).toBe('first intent');
    expect(displayTitleFor(s({ name: '   ', summary: '', autoName: 'first intent' }))).toBe('first intent');
  });
});

describe('truncateForTitle', () => {
  it('leaves short strings unchanged (no gratuitous ellipsis)', () => {
    expect(truncateForTitle('short')).toBe('short');
    // Exactly the limit — no truncation.
    const exact = 'x'.repeat(TITLE_MAX_CHARS);
    expect(truncateForTitle(exact)).toBe(exact);
  });

  it('clips long strings to maxChars and appends an ellipsis', () => {
    const long = 'x'.repeat(TITLE_MAX_CHARS + 40);
    const truncated = truncateForTitle(long);
    expect(truncated).toBe('x'.repeat(TITLE_MAX_CHARS) + '…');
    expect(truncated.length).toBe(TITLE_MAX_CHARS + 1);
  });

  it('accepts a custom maxChars', () => {
    expect(truncateForTitle('abcdef', 3)).toBe('abc…');
  });
});

describe('displayTitleFor + truncateForTitle composition (drag payload contract)', () => {
  it('a 100-char autoName is truncated the same way for title and drag', () => {
    // The drag payload should carry the SAME truncated string the title
    // displays, so a drop receiver sees what the user was dragging.
    const longAuto = 'a'.repeat(100);
    const session = s({ name: '', summary: undefined, autoName: longAuto });
    const rendered = truncateForTitle(displayTitleFor(session));
    expect(rendered).toBe('a'.repeat(TITLE_MAX_CHARS) + '…');
  });
});

// ============================================================================
// Oracle 9: sub-line suppression scoped to auto-name
// ============================================================================

describe('shouldSuppressIntentSubline', () => {
  it('SUPPRESSES when title came from autoName AND currentIntent === autoName', () => {
    const session = s({
      name: '',
      summary: undefined,
      autoName: 'first intent',
      currentIntent: 'first intent',
      titleSource: 'auto-name',
    });
    expect(shouldSuppressIntentSubline(session)).toBe(true);
  });

  it('does NOT suppress when title came from name, even if currentIntent === name', () => {
    // A user-named session whose italics coincidentally match must still render
    // the sub-line — the name is a label, the intent is a status; both are
    // deliberate signals from different sources.
    const session = s({
      name: 'my chat',
      currentIntent: 'my chat',
      titleSource: 'name',
    });
    expect(shouldSuppressIntentSubline(session)).toBe(false);
  });

  it('does NOT suppress when title came from workspace-summary, even if currentIntent matches', () => {
    // Similar reasoning: workspace summary is the SDK's own signal, and the
    // sub-line stays visible as an activity indicator.
    const session = s({
      name: '',
      summary: 'work-summary',
      currentIntent: 'work-summary',
      titleSource: 'workspace-summary',
    });
    expect(shouldSuppressIntentSubline(session)).toBe(false);
  });

  it('does NOT suppress when autoName title differs from currentIntent (session has moved on)', () => {
    // Auto-named session whose activity has progressed past the latch: the
    // sub-line renders the CURRENT activity, which is different from the
    // stable title.
    const session = s({
      name: '',
      autoName: 'first intent',
      currentIntent: 'now doing X',
      titleSource: 'auto-name',
    });
    expect(shouldSuppressIntentSubline(session)).toBe(false);
  });

  it('compares against UNTRUNCATED autoName (not the displayed title)', () => {
    // A 100-char autoName truncates in the display but the suppression check
    // uses the raw wire values — currentIntent === autoName still fires.
    const longAuto = 'a'.repeat(100);
    const session = s({
      name: '',
      autoName: longAuto,
      currentIntent: longAuto,
      titleSource: 'auto-name',
    });
    expect(shouldSuppressIntentSubline(session)).toBe(true);
  });

  it('does NOT suppress when currentIntent is null/undefined', () => {
    const session = s({
      name: '',
      autoName: 'first intent',
      currentIntent: undefined,
      titleSource: 'auto-name',
    });
    expect(shouldSuppressIntentSubline(session)).toBe(false);
  });
});
