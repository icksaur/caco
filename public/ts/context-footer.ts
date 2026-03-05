/**
 * Context Footer
 * 
 * Left side: recently edited files as clickable links.
 * Right side: model name + clickable cwd (added via renderStatus).
 * Updated via WebSocket events or on session load.
 */

import { regions } from './dom-regions.js';
import { formatContextFiles, formatStatusParts } from './ui-utils.js';

export interface SessionContext {
  files?: string[];
  [key: string]: string[] | undefined;
}

/**
 * Render file links in the context footer.
 */
export function renderContextFooter(context: SessionContext): void {
  const footer = regions.footer.el;
  
  const linksContainer = footer.querySelector('.context-links');
  if (!linksContainer) return;
  
  const files = formatContextFiles(context.files ?? []);
  const links = files.map(({ name, path }) => {
    const encodedPath = encodeURIComponent(path);
    return `<a href="/?applet=text-editor&path=${encodedPath}" title="${path}">${name}</a>`;
  });
  
  linksContainer.innerHTML = links.length
    ? links.join('<span class="context-sep">·</span>')
    : '';
  
  updateFooterVisibility();
}

/**
 * Render status (model name + cwd) in the right side of the footer.
 */
export function renderStatus(modelName: string, cwd: string): void {
  const footer = regions.footer.el;
  const statusEl = footer.querySelector('.context-status') as HTMLElement | null;
  if (!statusEl) return;
  
  const { model, dirName, fullCwd } = formatStatusParts(modelName, cwd);
  const parts: string[] = [];
  
  if (model) {
    parts.push(`<span class="context-model">${model}</span>`);
  }
  
  if (dirName && fullCwd) {
    const encodedCwd = encodeURIComponent(fullCwd);
    parts.push(`<a href="/?applet=file-browser&path=${encodedCwd}" title="${fullCwd}">${dirName}</a>`);
  }
  
  statusEl.innerHTML = parts.join('<span class="context-sep">·</span>');
  updateFooterVisibility();
}

/**
 * Clear status from the footer.
 */
export function clearStatus(): void {
  const footer = regions.footer.el;
  const statusEl = footer.querySelector('.context-status');
  if (statusEl) statusEl.innerHTML = '';
  updateFooterVisibility();
}

/**
 * Show footer if either side has content, hide if both empty.
 */
function updateFooterVisibility(): void {
  const footer = regions.footer.el;
  const links = footer.querySelector('.context-links');
  const status = footer.querySelector('.context-status');
  const hasContent = (links?.innerHTML || '') !== '' || (status?.innerHTML || '') !== '';
  footer.classList.toggle('has-context', hasContent);
}

/**
 * Clear the context footer (files only — status is independent).
 */
export function clearContextFooter(): void {
  renderContextFooter({});
}

/**
 * Handle caco.context WebSocket event.
 */
export function handleContextEvent(data: { context: SessionContext }): void {
  renderContextFooter(data.context ?? {});
}

const PIE_GLYPHS = ['○', '◔', '◑', '◕', '●'];

/**
 * Update context window usage display in footer.
 * Shows a pie chart glyph + percentage in yellow, with tooltip showing details.
 */
export function updateContextUsage(data: { tokenLimit?: number; currentTokens?: number }): void {
  const footer = regions.footer.el;
  let usageEl = footer.querySelector('.context-usage') as HTMLElement | null;
  
  if (!data.tokenLimit || !data.currentTokens) return;
  
  const pct = Math.round((data.currentTokens / data.tokenLimit) * 100);
  const glyphIdx = Math.min(Math.floor(pct / 25), 4);
  const glyph = PIE_GLYPHS[glyphIdx];
  const tooltip = `${data.currentTokens.toLocaleString()} / ${data.tokenLimit.toLocaleString()} tokens (${pct}%)`;
  
  if (!usageEl) {
    usageEl = document.createElement('span');
    usageEl.className = 'context-usage';
    const statusEl = footer.querySelector('.context-status');
    if (statusEl) {
      statusEl.insertAdjacentElement('beforebegin', usageEl);
    }
  }
  
  usageEl.textContent = `${glyph} ${pct}%`;
  usageEl.title = tooltip;
  updateFooterVisibility();
}
