/**
 * Session-title helpers (spec-auto-name-sessions).
 *
 * `displayTitleFor` picks the ladder-winning title string for one session, and
 * `truncateForTitle` clips a candidate to a sidebar-safe length. Extracted from
 * `session-panel.ts` so the title-render code and the drag payload can share
 * the same truncation logic — otherwise a runaway autoName would clip in the
 * visible row but drag as a full paragraph to a drop receiver, which reads
 * badly.
 */

import type { SessionData } from './types.js';

/** Sidebar-safe title width, in characters. Chosen to fit the default sidebar
 *  layout without pushing the age/action buttons off the right edge. */
export const TITLE_MAX_CHARS = 60;

/** UI's terminal fallback string when no ladder level is populated
 *  (spec-auto-name-sessions). Not sent on the wire — server projects null. */
export const NO_SUMMARY = 'No summary';

/** True iff `x` is a string with at least one non-whitespace character.
 *  Mirrors `hasValidText` on the server (spec-auto-name-sessions), so both
 *  sides accept and reject the same strings without needing a shared runtime. */
function hasValidText(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

/**
 * The ladder-winning title candidate for a session, or `NO_SUMMARY` when every
 * level is empty. Preferred order: `name` → `summary` → `autoName` → literal.
 * Untruncated — callers that render into a fixed-width slot pipe the result
 * through `truncateForTitle`.
 */
export function displayTitleFor(session: SessionData): string {
  if (hasValidText(session.name)) return session.name;
  if (hasValidText(session.summary)) return session.summary;
  if (hasValidText(session.autoName)) return session.autoName;
  return NO_SUMMARY;
}

/**
 * Clip a title candidate to `maxChars`, appending an ellipsis if truncation
 * actually removed characters. Strings of length ≤ `maxChars` are returned
 * unchanged (no gratuitous ellipsis on already-fitting titles).
 */
export function truncateForTitle(text: string, maxChars: number = TITLE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…';
}

/**
 * True iff the italicised sub-line should be SUPPRESSED for this row
 * (spec-auto-name-sessions). The rule is narrow: only when the title came
 * from `autoName` AND the current intent equals the (untruncated) autoName —
 * i.e. the same string would render twice on the row. In every other case
 * — user-named session, workspace-summary title, or auto-named title whose
 * current intent has moved on — the sub-line renders as before.
 *
 * Uses raw string equality against untruncated `autoName`, not the displayed
 * (truncated) title, so a long autoName still suppresses correctly when its
 * current intent still matches.
 */
export function shouldSuppressIntentSubline(session: SessionData): boolean {
  return session.titleSource === 'auto-name'
    && typeof session.autoName === 'string'
    && typeof session.currentIntent === 'string'
    && session.currentIntent === session.autoName;
}
