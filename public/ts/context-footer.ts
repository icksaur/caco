/**
 * Context Footer
 * 
 * Left side: recently edited files as clickable links.
 * Right side: model name + clickable cwd (added via renderStatus).
 * Updated via WebSocket events or on session load.
 */

import { regions } from './dom-regions.js';
import { formatContextFiles, formatStatusParts, escapeHtml } from './ui-utils.js';

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
export function renderStatus(modelName: string, cwd: string, hasGit = false, sessionName?: string, sessionId?: string, hasIcon?: boolean, gitBranch?: string | null): void {
  const footer = regions.footer.el;
  const statusEl = footer.querySelector('.context-status') as HTMLElement | null;
  if (!statusEl) return;
  
  const { model, dirName, fullCwd } = formatStatusParts(modelName, cwd);
  const parts: string[] = [];
  
  if (model) {
    parts.push(`<span class="context-model">${model}</span>`);
  }
  
  if (dirName) {
    parts.push(`<span title="${fullCwd || ''}">${dirName}</span>`);
  }
  
  if (hasIcon && sessionId) {
    parts.push(`<img class="context-icon" src="/api/sessions/${sessionId}/icon" alt="">`);
  }
  
  statusEl.innerHTML = parts.join('<span class="context-sep">·</span>');
  
  const descEl = footer.querySelector('.context-description') as HTMLElement | null;
  if (descEl) {
    const descParts: string[] = [];
    if (sessionName) descParts.push(escapeHtml(sessionName));
    
    const encodedCwd = fullCwd ? encodeURIComponent(fullCwd) : '';
    const appletLinks: string[] = [];
    if (sessionId) {
      appletLinks.push('<a href="/?applet=roadmap" class="footer-applet-link" id="footerRoadmapLink" style="display:none">roadmap</a>');
    }
    if (hasGit && encodedCwd) {
      const gitLabel = gitBranch ? `⎇ ${escapeHtml(gitBranch)}` : 'git';
      appletLinks.push(`<a href="/?applet=git-status&path=${encodedCwd}" class="footer-applet-link">${gitLabel}</a>`);
    }
    if (encodedCwd) {
      appletLinks.push(`<a href="/?applet=file-finder&root=${encodedCwd}" class="footer-applet-link">files</a>`);
    }
    
    descEl.innerHTML = descParts.join('') + (appletLinks.length ? ' ' + appletLinks.join(' ') : '');
    
    if (sessionId) {
      fetch(`/api/sessions/${sessionId}/roadmap`).then(r => r.json()).then(data => {
        if (data?.title || data?.steps?.length) {
          const link = document.getElementById('footerRoadmapLink');
          if (link) link.style.display = '';
        }
      }).catch(() => {});
    }
  }
  
  updateFooterVisibility();
}

/**
 * Clear status from the footer.
 */
export function clearStatus(): void {
  const footer = regions.footer.el;
  const statusEl = footer.querySelector('.context-status');
  const descEl = footer.querySelector('.context-description');
  if (statusEl) statusEl.innerHTML = '';
  if (descEl) descEl.innerHTML = '';
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

// Cache usage per session so it restores on switch
const usageCache = new Map<string, { tokenLimit: number; currentTokens: number }>();

/**
 * Update context window usage display in footer.
 * Caches per session so it restores when switching back.
 */
export function updateContextUsage(data: { tokenLimit?: number; currentTokens?: number }, sessionId?: string): void {
  if (!data.tokenLimit || !data.currentTokens) return;
  
  if (sessionId) {
    usageCache.set(sessionId, { tokenLimit: data.tokenLimit, currentTokens: data.currentTokens });
  }
  
  renderUsage(data.tokenLimit, data.currentTokens);
}

/**
 * Restore cached usage for a session, or clear if none cached.
 */
export function restoreContextUsage(sessionId: string): void {
  const cached = usageCache.get(sessionId);
  if (cached) {
    renderUsage(cached.tokenLimit, cached.currentTokens);
  } else {
    clearContextUsage();
  }
}

/**
 * Clear the usage display from the footer.
 */
export function clearContextUsage(): void {
  const footer = regions.footer.el;
  const usageEl = footer.querySelector('.context-usage');
  if (usageEl) usageEl.textContent = '';
  updateFooterVisibility();
}

function renderUsage(tokenLimit: number, currentTokens: number): void {
  const footer = regions.footer.el;
  const usageEl = footer.querySelector('.context-usage') as HTMLElement | null;
  if (!usageEl) return;
  
  const pct = Math.round((currentTokens / tokenLimit) * 100);
  const glyphIdx = Math.min(Math.floor(pct / 25), 4);
  const glyph = PIE_GLYPHS[glyphIdx];
  const tooltip = `${currentTokens.toLocaleString()} / ${tokenLimit.toLocaleString()} tokens (${pct}%)`;
  
  usageEl.textContent = `${glyph} ${pct}%`;
  usageEl.title = tooltip;
  updateFooterVisibility();
}
