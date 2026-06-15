/**
 * Context Footer
 * 
 * Left side: recently edited files as clickable links.
 * Center: token usage percentage.
 * Right side: model name + clickable cwd.
 * Description row: session name, git, applet links, roadmap.
 * Updated via WebSocket events or on session load.
 */

import { regions } from './dom-regions.js';
import { formatContextFiles, formatStatusParts, escapeHtml } from './ui-utils.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
export interface SessionContext {
  files?: string[];
  [key: string]: string[] | undefined;
}

let activeFooterSessionId: string | null = null;

/** Active session's per-session context-window budget (absolute tokens), or
 *  null for the SDK default. Drives the usage pie's compaction denominator and
 *  the model-name tooltip's effective window. */
let activeBudgetTokens: number | null = null;

/** Last-rendered model display name, kept so setActiveContextBudget can refresh
 *  the model-name tooltip without a full status re-render. */
let currentModelDisplayName = '';

/** SDK default background-compaction threshold (fraction of the window). */
const DEFAULT_BG_THRESHOLD = 0.80;

function formatWindowTokens(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}K`;
}

/** Build the model-name tooltip: "Claude Opus 4.8 · 400K context window".
 *  The window is the override budget when set, else the model's full window. */
function modelTitleFor(displayName: string): string {
  const model = getAvailableModels().find(m => m.id === activeModelId);
  const fullWindow = model?.contextWindow ?? 0;
  const effective = activeBudgetTokens && activeBudgetTokens > 0 ? activeBudgetTokens : fullWindow;
  if (effective > 0) return `${displayName} · ${formatWindowTokens(effective)} context window`;
  return displayName;
}

/** The absolute token count at which background compaction starts, honoring the
 *  override. Mirrors the server's thresholdForBudget clamp. */
function backgroundCompactSize(tokenLimit: number): number {
  if (activeBudgetTokens && activeBudgetTokens > 0) {
    const ratio = activeBudgetTokens / tokenLimit;
    if (ratio < 0.95) {
      const clamped = Math.min(0.94, Math.max(0.05, ratio));
      return Math.round(clamped * tokenLimit);
    }
  }
  return Math.round(DEFAULT_BG_THRESHOLD * tokenLimit);
}

/** Set (or clear) the active session's context budget and refresh the pie + the
 *  model-name tooltip immediately. */
export function setActiveContextBudget(tokens: number | null): void {
  activeBudgetTokens = tokens && tokens > 0 ? tokens : null;
  // Refresh the model-name tooltip in place.
  const modelEl = regions.footer.el.querySelector('.context-model span') as HTMLElement | null;
  if (modelEl && currentModelDisplayName) modelEl.title = modelTitleFor(currentModelDisplayName);
  // Re-render the cached usage pie against the new compaction denominator.
  const cached = activeFooterSessionId ? usageCache.get(activeFooterSessionId) : undefined;
  if (cached) renderUsage(cached.tokenLimit, cached.currentTokens);
}

/**
 * Render file links in the context footer.
 */
export function renderContextFooter(context: SessionContext): void {
  const footer = regions.footer.el;
  
  const linksContainer = footer.querySelector('.context-links');
  if (!linksContainer) return;
  
  const allFiles = context.files ?? [];
  const recentFiles = allFiles.length > 3 ? allFiles.slice(-3) : allFiles;
  const files = formatContextFiles(recentFiles);
  // Read current active session at render time so session switches don't leave
  // stale IDs baked into file links. Falls back to the captured ID for callers
  // that render outside an active-session context (transitional states).
  const sid = getActiveSessionId() ?? activeFooterSessionId;
  const sessionPart = sid ? `session=${encodeURIComponent(sid)}&` : '';
  const links = files.map(({ name, path }) => {
    const encodedPath = encodeURIComponent(path);
    return `<a href="/?${sessionPart}applet=files&openPath=${encodedPath}" title="${path}">${name}</a>`;
  });
  
  linksContainer.innerHTML = links.length
    ? links.join('<span class="context-sep">·</span>')
    : '';
  
  updateFooterVisibility();
}

/**
 * Render status for the new-chat view (model + cwd only, no session data).
 */
export function renderNewChatStatus(modelName: string, cwd: string): void {
  activeFooterSessionId = null;
  const footer = regions.footer.el;
  const { model, dirName, fullCwd } = formatStatusParts(modelName, cwd);

  // Row 1 right: (no session yet) — clear.
  const sessionEl = footer.querySelector('.context-session') as HTMLElement | null;
  if (sessionEl) sessionEl.innerHTML = '';

  // Row 2 left: model name.
  const modelEl = footer.querySelector('.context-model') as HTMLElement | null;
  if (modelEl) {
    currentModelDisplayName = model || '';
    modelEl.innerHTML = model ? `<span title="${escapeHtml(modelTitleFor(model))}">${escapeHtml(model)}</span>` : '';
  }

  // Row 2 right: cwd (no links without a session).
  const descEl = footer.querySelector('.context-description') as HTMLElement | null;
  if (descEl) descEl.innerHTML = dirName ? `<span title="${escapeHtml(fullCwd || '')}">${escapeHtml(dirName)}</span>` : '';

  updateFooterVisibility();
}

interface SessionStatusParams {
  modelName: string;
  cwd: string;
  hasGit?: boolean;
  sessionName?: string;
  sessionId: string;
  hasIcon?: boolean;
  gitBranch?: string | null;
}

/**
 * Render status for an active session (full metadata).
 */
export function renderSessionStatus(params: SessionStatusParams): void {
  const { modelName, cwd, hasGit = false, sessionName, sessionId, hasIcon, gitBranch } = params;
  activeFooterSessionId = sessionId;

  const footer = regions.footer.el;
  const { model, dirName, fullCwd } = formatStatusParts(modelName, cwd);

  // Row 1 right: gif icon + session name.
  const sessionEl = footer.querySelector('.context-session') as HTMLElement | null;
  if (sessionEl) {
    const sParts: string[] = [];
    if (hasIcon && sessionId) {
      sParts.push(`<img class="context-icon" src="/api/sessions/${encodeURIComponent(sessionId)}/icon" alt="">`);
    }
    if (sessionName) sParts.push(`<span class="context-session-name">${escapeHtml(sessionName)}</span>`);
    sessionEl.innerHTML = sParts.join(' ');
  }

  // Row 2 left: model name.
  const modelEl = footer.querySelector('.context-model') as HTMLElement | null;
  if (modelEl) {
    currentModelDisplayName = model || '';
    modelEl.innerHTML = model ? `<span title="${escapeHtml(modelTitleFor(model))}">${escapeHtml(model)}</span>` : '';
  }

  // Row 2 right: dashboard + git + cwd-as-files-link.
  renderDescription(sessionId, hasGit, gitBranch, fullCwd, dirName);
  updateFooterVisibility();
}

function renderDescription(sessionId: string, hasGit = false, gitBranch?: string | null, fullCwd?: string, dirName?: string): void {
  const footer = regions.footer.el;
  const descEl = footer.querySelector('.context-description') as HTMLElement | null;
  if (!descEl) return;

  const encodedCwd = fullCwd ? encodeURIComponent(fullCwd) : '';
  const encodedSession = encodeURIComponent(sessionId);
  const appletLinks: string[] = [];
  appletLinks.push(`<a href="/?session=${encodedSession}&applet=session-context" class="footer-applet-link" id="footerRoadmapLink" style="display:none">context dashboard</a>`);
  if (hasGit && encodedCwd) {
    const gitLabel = gitBranch ? `⎇ ${escapeHtml(gitBranch)}` : 'git';
    appletLinks.push(`<a href="/?session=${encodedSession}&applet=git-status&path=${encodedCwd}" class="footer-applet-link">${gitLabel}</a>`);
  }
  if (encodedCwd) {
    // Files link labeled with the cwd basename (per layout: "cwd string as files link").
    const label = dirName ? escapeHtml(dirName) : 'files';
    appletLinks.push(`<a href="/?session=${encodedSession}&applet=files&openFinder=1&openFinderRoot=${encodedCwd}" class="footer-applet-link" title="${escapeHtml(fullCwd || '')}">${label}</a>`);
  }

  descEl.innerHTML = appletLinks.join(' ');

  checkRoadmap(sessionId);
}

/**
 * Check if a session has a roadmap and show/hide the link.
 * Verifies session ownership after async fetch to prevent stale updates.
 */
function checkRoadmap(sessionId: string): void {
  fetch(`/api/sessions/${sessionId}/roadmap`).then(r => r.json()).then(data => {
    if (activeFooterSessionId !== sessionId) return;
    const link = document.getElementById('footerRoadmapLink');
    if (link) link.style.display = (data?.title || data?.steps?.length) ? '' : 'none';
  }).catch(() => {});
}

/**
 * Re-check roadmap visibility for the current session.
 * Called when roadmap may have changed (e.g., tool update events).
 */
export function refreshRoadmapLink(): void {
  if (activeFooterSessionId) checkRoadmap(activeFooterSessionId);
}

/**
 * Clear status from the footer.
 */
export function clearStatus(): void {
  activeFooterSessionId = null;
  const footer = regions.footer.el;
  for (const sel of ['.context-session', '.context-model', '.context-description']) {
    const el = footer.querySelector(sel);
    if (el) el.innerHTML = '';
  }
  updateFooterVisibility();
}

/**
 * Show footer if either side has content, hide if both empty.
 */
function updateFooterVisibility(): void {
  const footer = regions.footer.el;
  const links = footer.querySelector('.context-links');
  const session = footer.querySelector('.context-session');
  const model = footer.querySelector('.context-model');
  const hasContent =
    (links?.innerHTML || '') !== '' ||
    (session?.innerHTML || '') !== '' ||
    (model?.innerHTML || '') !== '';
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

const usageCache = new Map<string, { tokenLimit: number; currentTokens: number }>();

/**
 * Update context window usage display in footer.
 * Caches per session so it restores when switching back.
 */
export function updateContextUsage(data: { tokenLimit?: number; currentTokens?: number }, sessionId?: string): void {
  if (data.tokenLimit === null || data.tokenLimit === undefined || data.currentTokens === null || data.currentTokens === undefined) return;
  
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
  
  // Denominator is the background-compaction point (honoring any override), not
  // the full window — that's where context actually gets summarized.
  const compactSize = backgroundCompactSize(tokenLimit);
  const pct = Math.round((currentTokens / compactSize) * 100);
  const glyphIdx = Math.min(Math.floor(pct / 25), 4);
  const glyph = PIE_GLYPHS[glyphIdx];
  const tooltip =
    `${currentTokens.toLocaleString()} / ${compactSize.toLocaleString()} before compaction (${pct}%)` +
    `\nfull window: ${tokenLimit.toLocaleString()} tokens`;
  
  usageEl.textContent = `${glyph} ${Math.min(pct, 100)}%`;
  usageEl.title = tooltip;
  updateFooterVisibility();
}

export interface ThroughputData {
  requestIn: number;
  requestCache: number;
  requestOut: number;
  totalIn: number;
  totalCache: number;
  totalOut: number;
  rateLimitCount: number;
  lastRateLimitAt?: string;
  updatedAt: string;
  known?: boolean;
}

function kAbbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Active session's model id, stashed by updateStatus so renderThroughput
 *  can price the in/cache/out token classes. */
let activeModelId: string | null = null;
export function setActiveThroughputModel(modelId: string | null): void {
  activeModelId = modelId;
}

/** Compute approximate cost in AI credits from the model's per-MTOK
 *  prices. Returns null when prices are unknown (e.g. Auto). */
function estimateCost(d: ThroughputData): number | null {
  const model = getAvailableModels().find(m => m.id === activeModelId);
  if (!model || model.inputPerMtok === undefined || model.outputPerMtok === undefined) return null;
  const cacheRate = model.cachePerMtok ?? 0;
  const credits =
    (d.requestIn * model.inputPerMtok +
      d.requestCache * cacheRate +
      d.requestOut * model.outputPerMtok) / 1_000_000;
  return credits;
}

const throughputCache = new Map<string, ThroughputData>();

export function updateThroughput(data: ThroughputData, sessionId?: string): void {
  if (sessionId) {
    throughputCache.set(sessionId, data);
  }
  renderThroughput(data);
}

export function restoreThroughput(sessionId: string): void {
  const cached = throughputCache.get(sessionId);
  if (cached) {
    renderThroughput(cached);
  } else {
    clearThroughput();
  }
  fetch(`/api/sessions/${sessionId}/throughput`)
    .then(r => r.json())
    .then((data: ThroughputData) => {
      if (getActiveSessionId() !== sessionId) return;
      throughputCache.set(sessionId, data);
      renderThroughput(data);
    })
    .catch(() => {});
}

export function clearThroughput(): void {
  const footer = regions.footer.el;
  const el = footer.querySelector('.context-throughput');
  if (el) el.innerHTML = '';
}

function renderThroughput(data: ThroughputData): void {
  const footer = regions.footer.el;
  const el = footer.querySelector('.context-throughput') as HTMLElement | null;
  if (!el) return;

  const tooltip =
    `request: ${data.requestIn.toLocaleString()} in · ${data.requestCache.toLocaleString()} cache · ${data.requestOut.toLocaleString()} out` +
    `\nsession: ${data.totalIn.toLocaleString()} in · ${data.totalCache.toLocaleString()} cache · ${data.totalOut.toLocaleString()} out`;

  const parts =
    `${escapeHtml(kAbbrev(data.requestIn))} in ` +
    `${escapeHtml(kAbbrev(data.requestCache))} cache ` +
    `${escapeHtml(kAbbrev(data.requestOut))} out`;

  const cost = estimateCost(data);
  const costHtml = cost !== null
    ? ` <span class="tp-cost">≈${cost < 10 ? cost.toFixed(2) : Math.round(cost).toLocaleString()}cr</span>`
    : '';

  const tokenHtml = `<span title="${escapeHtml(tooltip)}">${parts}${costHtml}</span>`;

  let rateLimitHtml = '';
  if (data.rateLimitCount > 0) {
    const lastAt = data.lastRateLimitAt ? ` (last ${new Date(data.lastRateLimitAt).toLocaleTimeString()})` : '';
    const rlTooltip = `${data.rateLimitCount} rate-limited call${data.rateLimitCount !== 1 ? 's' : ''}${lastAt}`;
    rateLimitHtml = ` <span class="ratelimit" title="${escapeHtml(rlTooltip)}">⚠${data.rateLimitCount}</span>`;
  }

  el.innerHTML = tokenHtml + rateLimitHtml;
}
