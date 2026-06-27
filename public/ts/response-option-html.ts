import { escapeHtml } from './ui-utils.js';

/**
 * Build the HTML for offer-action buttons. The canonical (≤200-char) action text is
 * carried verbatim — via one shared escape — in BOTH `data-prompt` (sent on click) and
 * `title` (hover tooltip), so the two are byte-identical and decode back to the original
 * text. The visible label is the same escaped text; CSS ellipsis-truncates it so up to
 * four buttons fit a 2x2 grid. Pure (no DOM) so it is directly unit-testable.
 */
export function buildResponseOptionsHtml(options: string[], muted: boolean): string {
  return options.map(o => {
    const esc = escapeHtml(o);
    return `<button class="response-option-btn${muted ? ' muted' : ''}" data-prompt="${esc}" title="${esc}">${esc}</button>`;
  }).join('');
}
