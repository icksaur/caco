/**
 * Context Footer
 * 
 * Left side: recently edited files as clickable links.
 * Center: token usage percentage.
 * Right side: model name + clickable cwd.
 * Description row: session name, git, applet links.
 * Updated via WebSocket events or on session load.
 */

import { regions } from './dom-regions.js';
import { formatContextFiles, formatStatusParts, escapeHtml } from './ui-utils.js';
import { getActiveSessionId, getAvailableModels } from './app-state.js';
import { computeNetCreditsSaved } from './saved-pricing.js';
export interface SessionContext {
  files?: string[];
  [key: string]: string[] | undefined;
}

let ownerSessionId: string | null = null;

/** The session that currently owns the footer. Usage / throughput / context-file
 *  updates for any other session are silently dropped. Set early on resume
 *  (before history loads, via setFooterOwner) so in-flight updates for the
 *  incoming session are accepted, and re-affirmed by the status renderers. This
 *  is the single footer-ownership pointer (formerly split between this module
 *  and ChatViewController.footerSessionId). */
export function setFooterOwner(sessionId: string | null): void {
  ownerSessionId = sessionId;
}

export function isFooterOwner(sessionId: string): boolean {
  return ownerSessionId === sessionId;
}

/** Active session's per-session context-window budget (absolute tokens), or
 *  null for the SDK default. Drives the usage pie's compaction denominator and
 *  the model-name tooltip's effective window. */
let activeBudgetTokens: number | null = null;

/** Active session's reasoning effort level, or null for the model default. */
let activeReasoningEffort: string | null = null;

const EFFORT_LABELS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh' };

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

/** Build the model-name tooltip: "Claude Opus 4.8 · 400K context window · High effort".
 *  Window is the override budget when set, else the model's full window.
 *  Effort label is omitted when null or equals the model default. */
function modelTitleFor(displayName: string): string {
  const model = getAvailableModels().find(m => m.id === activeModelId);
  const fullWindow = model?.contextWindow ?? 0;
  const effective = activeBudgetTokens && activeBudgetTokens > 0 ? activeBudgetTokens : fullWindow;
  const parts = [displayName];
  if (effective > 0) parts.push(`${formatWindowTokens(effective)} context window`);
  if (activeReasoningEffort) {
    const label = EFFORT_LABELS[activeReasoningEffort] ?? activeReasoningEffort;
    parts.push(`${label} effort`);
  }
  return parts.join(' · ');
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
  refreshModelTooltip();
  // Re-render the cached usage pie against the new compaction denominator.
  const cached = ownerSessionId ? usageCache.get(ownerSessionId) : undefined;
  if (cached) renderUsage(cached.tokenLimit, cached.currentTokens);
}

/** Set (or clear) the active session's reasoning effort and refresh the model tooltip. */
export function setActiveReasoningEffort(effort: string | null): void {
  activeReasoningEffort = effort;
  refreshModelTooltip();
}

function refreshModelTooltip(): void {
  const modelEl = regions.footer.el.querySelector('.context-model span') as HTMLElement | null;
  if (modelEl && currentModelDisplayName) modelEl.title = modelTitleFor(currentModelDisplayName);
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
  const sid = getActiveSessionId() ?? ownerSessionId;
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
  ownerSessionId = null;
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
  ownerSessionId = sessionId;

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
}

/**
 * Clear status from the footer.
 */
export function clearStatus(): void {
  ownerSessionId = null;
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
  workflowSavedTokens?: number;
  workflowRuns?: number;
  workflowVirtualCallsAvoided?: number;
  workflowRoundTripsSaved?: number;
  workflowCacheReplaySaved?: number;
  workflowCacheCompoundSaved?: number;
  workflowOutputDelta?: number;
  workflowTimeSavedMs?: number;
  totalWallMs?: number;
  shapingSavedTokens?: number;
  shapingShapeCount?: number;
  requestTurns?: number;
  requestReasoning?: number;
  requestToolCalls?: number;
  requestToolFailures?: number;
  requestWallMs?: number;
  totalTurns?: number;
  totalReasoning?: number;
  totalToolCalls?: number;
  totalToolFailures?: number;
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

/** Compute approximate session-accumulated cost in AI credits from the model's
 *  per-MTOK prices. Returns null when prices are unknown (e.g. Auto). */
function estimateCost(d: ThroughputData): number | null {
  const model = getAvailableModels().find(m => m.id === activeModelId);
  if (!model || model.inputPerMtok === undefined || model.outputPerMtok === undefined) return null;
  const cacheRate = model.cachePerMtok ?? 0;
  const credits =
    (d.totalIn * model.inputPerMtok +
      d.totalCache * cacheRate +
      d.totalOut * model.outputPerMtok) / 1_000_000;
  return credits;
}


interface SavedPricing {
  /** Net credits saved — context savings that survive parallel tool calls, minus output cost. May be negative. */
  netCredits: number | null;
  /** Active model's per-MTOK rates, or null when unknown (e.g. Auto). */
  rates: { input: number; cache: number; output: number } | null;
}

/** Price saved tokens by billing class (input for fresh + shaping; cache for
 *  window-replay + compounding; output for the net code delta). Returns null
 *  rates/credits when the model's rates are unknown (e.g. Auto). */
function priceSaved(d: ThroughputData): SavedPricing {
  const model = getAvailableModels().find(m => m.id === activeModelId);
  if (!model || model.inputPerMtok === undefined) {
    return { netCredits: null, rates: null };
  }
  const rates = { input: model.inputPerMtok, cache: model.cachePerMtok ?? 0, output: model.outputPerMtok ?? 0 };

  const fresh = d.workflowSavedTokens ?? 0;
  const compound = d.workflowCacheCompoundSaved ?? 0;
  const replay = d.workflowCacheReplaySaved ?? 0;
  const outputDelta = d.workflowOutputDelta ?? 0;
  const shaping = d.shapingSavedTokens ?? 0;

  const netCredits = computeNetCreditsSaved(rates, { fresh, shaping, compound, replay, outputDelta });
  return { netCredits, rates };
}

function fmtCredits(c: number): string {
  const a = Math.abs(c);
  return a < 10 ? a.toFixed(2) : Math.round(a).toLocaleString();
}

/** Precise credit formatter for the math breakdown — keeps small per-class
 *  components legible (a component can be a tiny fraction of a credit). */
function fmtCr(c: number): string {
  const a = Math.abs(c);
  if (a >= 10) return Math.round(a).toLocaleString();
  if (a >= 0.01) return a.toFixed(2);
  if (a === 0) return '0';
  return a.toPrecision(2);
}

function fmtDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 1000).toFixed(1)}s`;
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

/** Seed throughput from a bundled payload (the /resume response) instead of a
 *  separate GET /throughput round trip. Falls back to a fetch when the payload
 *  is absent (e.g. an older server during a rolling deploy). */
export function seedThroughput(sessionId: string, data: ThroughputData | null | undefined): void {
  if (!data) {
    restoreThroughput(sessionId);
    return;
  }
  throughputCache.set(sessionId, data);
  renderThroughput(data);
}

export function clearThroughput(): void {
  const footer = regions.footer.el;
  const el = footer.querySelector('.context-throughput');
  if (el) el.innerHTML = '';
  renderSaved({} as ThroughputData);
}

function renderThroughput(data: ThroughputData): void {
  const footer = regions.footer.el;
  const el = footer.querySelector('.context-throughput') as HTMLElement | null;
  if (!el) return;

  const turns = data.totalTurns ?? 0;
  const reasoning = data.totalReasoning ?? 0;
  const toolCalls = data.totalToolCalls ?? 0;
  const toolFails = data.totalToolFailures ?? 0;
  const wallMs = data.totalWallMs ?? 0;
  const wallNote = wallMs > 0 ? ` in ${(wallMs / 1000).toFixed(1)}s` : '';
  const failNote = toolFails > 0 ? ` (${toolFails} failed)` : '';
  const tooltip =
    `session: ${data.totalIn.toLocaleString()} in · ${data.totalCache.toLocaleString()} cache · ${data.totalOut.toLocaleString()} out` +
    `\nlast request: ${data.requestIn.toLocaleString()} in · ${data.requestCache.toLocaleString()} cache · ${data.requestOut.toLocaleString()} out` +
    `\nround trips: ${turns} turn${turns !== 1 ? 's' : ''}${wallNote} · ${reasoning.toLocaleString()} reasoning · ${toolCalls} tool call${toolCalls !== 1 ? 's' : ''}${failNote}`;

  const parts =
    `${escapeHtml(kAbbrev(data.totalIn))} in ` +
    `${escapeHtml(kAbbrev(data.totalCache))} cache ` +
    `${escapeHtml(kAbbrev(data.totalOut))} out`;

  const cost = estimateCost(data);
  const costHtml = cost !== null
    ? ` <span class="tp-cost">≈${cost < 10 ? cost.toFixed(2) : Math.round(cost).toLocaleString()}cr</span>`
    : '';

  const turnHtml = turns > 0 ? ` <span class="tp-turns">⟲${turns}</span>` : '';

  const tokenHtml = `<span title="${escapeHtml(tooltip)}">${parts}${costHtml}${turnHtml}</span>`;

  let rateLimitHtml = '';
  if (data.rateLimitCount > 0) {
    const lastAt = data.lastRateLimitAt ? ` (last ${new Date(data.lastRateLimitAt).toLocaleTimeString()})` : '';
    const rlTooltip = `${data.rateLimitCount} rate-limited call${data.rateLimitCount !== 1 ? 's' : ''}${lastAt}`;
    rateLimitHtml = ` <span class="ratelimit" title="${escapeHtml(rlTooltip)}">⚠${data.rateLimitCount}</span>`;
  }

  el.innerHTML = tokenHtml + rateLimitHtml;
  renderSaved(data);
}

/** Render the accumulated savings indicator next to the context usage pie.
 *  Glyph is net credits saved; the tooltip shows the token quantities and the
 *  exact credit arithmetic (rates expanded as perMtok/1000000). */
function renderSaved(data: ThroughputData): void {
  const footer = regions.footer.el;
  const el = footer.querySelector('.context-saved') as HTMLElement | null;
  if (!el) return;

  const fresh = data.workflowSavedTokens ?? 0;
  const compound = data.workflowCacheCompoundSaved ?? 0;
  const replay = data.workflowCacheReplaySaved ?? 0;
  const virtualCalls = data.workflowVirtualCallsAvoided ?? 0;
  const roundTrips = data.workflowRoundTripsSaved ?? 0;
  const outputDelta = data.workflowOutputDelta ?? 0;
  const shaping = data.shapingSavedTokens ?? 0;
  const inputSaved = fresh + shaping;
  const cacheSaved = replay + compound;
  const totalTokens = inputSaved + cacheSaved;
  const timeSavedMs = data.workflowTimeSavedMs ?? 0;

  const { netCredits, rates } = priceSaved(data);

  let glyph: string;
  if (netCredits === null) glyph = `↯${kAbbrev(totalTokens)}`;
  else if (netCredits < 0) glyph = `↯−${fmtCredits(netCredits)}cr`;
  else glyph = `↯≈${fmtCredits(netCredits)}cr`;
  el.textContent = glyph;

  const n = (v: number) => v.toLocaleString();
  const turns = data.totalTurns ?? 0;
  const calls = data.totalToolCalls ?? 0;
  const batch = turns >= 3 && calls / turns > 1 ? calls / turns : 1;
  const lines: string[] = [
    `${n(virtualCalls)} virtual tool calls → ${n(roundTrips)} round trips saved (batching ×${batch.toFixed(1)})`,
  ];
  if (timeSavedMs > 0) lines.push(`~${fmtDuration(timeSavedMs)} round-trip time saved (accum)`);
  lines.push(
    `cache saved (accum est): ${n(replay)} replay + ${n(compound)} lean = ${n(cacheSaved)} tok`,
    `input saved (exact): shaping ${n(shaping)} + workflow ${n(fresh)} = ${n(inputSaved)} tok`,
    `output spent (script est): ${n(outputDelta)} tok`,
  );

  if (rates) {
    const PER = 1_000_000;
    const cacheCr = cacheSaved * rates.cache / PER;
    const inputCr = inputSaved * rates.input / PER;
    const outputCr = outputDelta * rates.output / PER;
    const net = cacheCr + inputCr - outputCr;
    // Sign-fold the output term so the formula never prints "− −".
    const outSymOp = outputDelta >= 0 ? '−' : '+';
    const outCrOp = outputCr >= 0 ? '−' : '+';
    lines.push(
      `${n(cacheSaved)}×${rates.cache}/${PER} + ${n(inputSaved)}×${rates.input}/${PER} ${outSymOp} ${n(Math.abs(outputDelta))}×${rates.output}/${PER}`,
      `= ${fmtCr(cacheCr)} + ${fmtCr(inputCr)} ${outCrOp} ${fmtCr(outputCr)} = ${net < 0 ? '−' : ''}${fmtCr(net)} cr`,
    );
  } else {
    lines.push(`rates unknown (Auto): ${n(totalTokens)} tok saved`);
  }

  el.title = lines.join('\n');
}
