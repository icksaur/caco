/**
 * Inline offer-action parsing (tool-diet A3).
 *
 * The model ends a message with a fenced block to offer next-step buttons:
 *
 *   ```caco-actions
 *   Fix the failing test
 *   Add a regression test
 *   ```
 *
 * This module extracts those options into the same `responseOptions` the
 * `caco_offer_action` tool wrote, so the existing pinned-button UI is unchanged.
 *
 * Validation (`normalizeOptions`) is shared with the tool so the two paths can
 * never diverge during the bake-in period.
 */

export const MAX_OPTIONS = 4;
export const MAX_OPTION_LENGTH = 50;

/** Trim, drop blanks, cap to MAX_OPTIONS, truncate each to MAX_OPTION_LENGTH. */
export function normalizeOptions(raw: string[]): string[] {
  const trimmed = raw.map(o => o.trim()).filter(Boolean);
  return trimmed
    .slice(0, MAX_OPTIONS)
    .map(o => (o.length > MAX_OPTION_LENGTH ? o.slice(0, MAX_OPTION_LENGTH) : o));
}

/**
 * Final-trailer rule: a `caco-actions` block counts ONLY when it is the last
 * top-level content of the message (its closing fence is the final non-
 * whitespace text). The body may not contain a fence, so a `caco-actions`
 * sample quoted mid-message or actions emitted before more prose never match.
 *
 * Returns the normalized option list, or [] when there is no qualifying block.
 */
const TRAILER_RE = /(?:^|\n)```caco-actions[ \t]*\r?\n((?:(?!```)[\s\S])*?)\r?\n```[ \t]*$/;

export function extractActionOptions(message: string): string[] {
  if (!message) return [];
  const trimmed = message.replace(/\s+$/, '');
  const match = TRAILER_RE.exec(trimmed);
  if (!match) return [];
  const body = match[1];
  return normalizeOptions(body.split(/\r?\n/));
}
