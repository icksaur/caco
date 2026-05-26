/**
 * Applet Runtime
 * 
 * Client-side applet execution.
 * Handles receiving applet content from SSE and injecting it into the DOM.
 * 
 * Navigation is handled by router.ts - this module just renders applets.
 */

import { wsSetState, onStateUpdate, onEvent, onGlobalEvent, isWsConnected } from './websocket.js';
import { getActiveSessionId, getCurrentCwd, isLoadingHistory } from './app-state.js';
import { regions } from './dom-regions.js';
import { loadApplet } from './router.js';
import { showToast } from './toast.js';
import { fetchWithRetry, type FetchWithRetryOptions } from './fetch-retry.js';
import type { SessionEvent } from './types.js';

interface TempFileResult {
  path: string;
  filename: string;
}

export interface AppletContent {
  html: string;
  js?: string;
  css?: string;
  title?: string;
}

interface AppletInstance {
  slug: string;
  label: string;
  element: HTMLElement;
  styleElement: HTMLStyleElement | null;
  popstateHandler: (() => void) | null;
  cleanupFns: Array<() => void>;
}

let currentApplet: AppletInstance | null = null;
let pendingAppletState: Record<string, unknown> | null = null;

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  name?: string;
  kind?: string;
  model?: string;
  currentIntent?: string;
  busy?: boolean;
}

type SessionChangeCallback = (sessionId: string, info: SessionInfo) => void;
const sessionChangeCallbacks = new Set<SessionChangeCallback>();

export function notifySessionChange(sessionId: string, info: SessionInfo): void {
  for (const cb of sessionChangeCallbacks) {
    try { cb(sessionId, info); } catch (e) { console.error('[APPLET] sessionChange callback error:', e); }
  }
}

/**
 * Subscribe to session events (live only, not history replay).
 * Auto-registers cleanup when the applet is destroyed.
 */
function appletOnSessionEvent(cb: (event: SessionEvent) => void): () => void {
  const wrapper = (event: SessionEvent) => {
    // caco.fs.changed is delivered through the dedicated watch channel, not
    // here. Suppress so generic subscribers don't see other applets' watches.
    if (deliverWatchEvent(event as { type: string; data?: Record<string, unknown> })) return;
    if (!isLoadingHistory()) cb(event);
  };
  const unsub = onEvent(wrapper);
  currentApplet?.cleanupFns.push(unsub);
  return unsub;
}

function appletOnGlobalEvent(cb: (event: { type: string; data?: Record<string, unknown> }) => void): () => void {
  const unsub = onGlobalEvent(cb);
  currentApplet?.cleanupFns.push(unsub);
  return unsub;
}

/**
 * Subscribe to session changes. Fires immediately with current session.
 * Auto-registers cleanup when the applet is destroyed.
 */
function appletOnSessionChange(cb: SessionChangeCallback): () => void {
  sessionChangeCallbacks.add(cb);
  const unsub = () => sessionChangeCallbacks.delete(cb);
  currentApplet?.cleanupFns.push(unsub);
  
  const id = getActiveSessionId();
  const cwd = getCurrentCwd();
  if (id) cb(id, { sessionId: id, cwd });
  
  return unsub;
}

/**
 * Wrapped onStateUpdate that auto-registers cleanup.
 */
function appletOnStateUpdate(cb: (state: Record<string, unknown>) => void): () => void {
  const unsub = onStateUpdate(cb);
  currentApplet?.cleanupFns.push(unsub);
  return unsub;
}

async function getSessionMeta(sessionId?: string): Promise<SessionInfo | null> {
  const id = sessionId || getActiveSessionId();
  if (!id) return null;
  try {
    const res = await fetch(`/api/sessions/${id}/state`);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      sessionId: data.sessionId,
      cwd: data.cwd,
      name: data.name,
      kind: data.kind,
      model: data.model,
      currentIntent: data.currentIntent,
      busy: data.isBusy,
    };
  } catch { return null; }
}

/**
 * Helper function for applet JS to expose functions globally.
 * Needed for onclick handlers since scripts are wrapped in IIFE.
 */
function expose(nameOrObj: string | Record<string, unknown>, fn?: unknown): void {
  if (typeof nameOrObj === 'string' && fn !== undefined) {
    (window as unknown as Record<string, unknown>)[nameOrObj] = fn;
  } else if (typeof nameOrObj === 'object') {
    Object.assign(window, nameOrObj);
  }
}

/**
 * Escape HTML special chars for safe insertion into innerHTML.
 *
 * Timing: only call from event handlers or async contexts where `appletAPI`
 * is guaranteed initialized. Calling at the applet script's top level may
 * run before `window.appletAPI` is set. Top-level call sites should inline
 * the escape logic to avoid the load-order dependency.
 */
function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface AppletFetchOptions extends RequestInit {
  timeout?: number;
}

/**
 * fetch wrapper with timeout and HTTP error handling.
 * Throws on non-OK responses with the server's error message if available.
 */
async function appletFetch(url: string, options: AppletFetchOptions = {}): Promise<Response> {
  const { timeout = 10000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const errMsg = await res.json().then(d => d?.error).catch(() => null);
      throw new Error(errMsg || `HTTP ${res.status}`);
    }
    return res;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`Request timeout after ${timeout}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

interface ToastOptions {
  type?: 'info' | 'success' | 'error';
  autoHideMs?: number;
}

/**
 * Show a toast notification from an applet.
 */
function appletToast(message: string, options: ToastOptions = {}): void {
  showToast(message, options);
}

/**
 * Applet API interface - exposed as window.appletAPI
 */
interface AppletAPI {
  expose: typeof expose;
  setAppletState: typeof setAppletState;
  listApplets: typeof listSavedApplets;
  loadApplet: typeof loadApplet;
  getAppletUrlParams: typeof getAppletUrlParams;
  getAppletSlug: typeof getAppletSlug;
  updateAppletUrlParam: typeof updateAppletUrlParam;
  navigateAppletUrlParam: typeof navigateAppletUrlParam;
  onUrlParamsChange: typeof onUrlParamsChange;
  onStateUpdate: typeof appletOnStateUpdate;
  onSessionEvent: typeof appletOnSessionEvent;
  onGlobalEvent: typeof appletOnGlobalEvent;
  onSessionChange: typeof appletOnSessionChange;
  getSessionId: typeof getActiveSessionId;
  getSessionMeta: typeof getSessionMeta;
  sendAgentMessage: typeof sendAgentMessage;
  saveTempFile: typeof saveTempFile;
  callFileApi: typeof callFileApi;
  /** @deprecated Use callFileApi. */
  callMCPTool: typeof callFileApi;
  fetchWithRetry: typeof appletFetchWithRetry;
  watchPath: typeof watchPath;
  fetch: typeof appletFetch;
  escapeHtml: typeof escapeHtml;
  toast: typeof appletToast;
}

declare global {
  interface Window {
    appletAPI: AppletAPI;
    // Legacy globals (kept for backward compatibility)
    expose: typeof expose;
    setAppletState: typeof setAppletState;
  }
}

/**
 * Initialize applet runtime - exposes global functions for applet JS
 * Call this once at app startup
 */
export function initAppletRuntime(): void {
  // Create unified appletAPI object
  const api: AppletAPI = {
    expose,
    setAppletState,
    listApplets: listSavedApplets,
    loadApplet,
    getAppletUrlParams,
    getAppletSlug,
    updateAppletUrlParam,
    navigateAppletUrlParam,
    onUrlParamsChange,
    onStateUpdate: appletOnStateUpdate,
    onSessionEvent: appletOnSessionEvent,
    onGlobalEvent: appletOnGlobalEvent,
    onSessionChange: appletOnSessionChange,
    getSessionId: getActiveSessionId,
    getSessionMeta,
    sendAgentMessage,
    saveTempFile,
    callFileApi,
    callMCPTool: callFileApi,
    fetchWithRetry: appletFetchWithRetry,
    watchPath,
    fetch: appletFetch,
    escapeHtml,
    toast: appletToast,
  };
  
  window.appletAPI = api;
  
  // Legacy globals (for backward compatibility with existing applets)
  window.expose = expose;
  window.setAppletState = setAppletState;
}

/**
 * Get URL query params (excluding 'applet' slug)
 * For applet JS to read initial state from URL
 */
export function getAppletUrlParams(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const result: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key !== 'applet') {
      result[key] = value;
    }
  });
  return result;
}

/**
 * Get the current applet's slug from URL
 * Returns null if not in an applet view
 */
export function getAppletSlug(): string | null {
  return new URLSearchParams(window.location.search).get('applet');
}

/**
 * Debounced sync of URL params to session metadata.
 * Called after navigateAppletUrlParam / updateAppletUrlParam so meta.appletParams
 * stays current as the user navigates within an applet.
 */
let _appletParamsSyncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleAppletParamsSync(): void {
  if (_appletParamsSyncTimer) clearTimeout(_appletParamsSyncTimer);
  _appletParamsSyncTimer = setTimeout(() => {
    _appletParamsSyncTimer = null;
    const sessionId = getActiveSessionId();
    if (!sessionId) return;
    const appletParams = getAppletUrlParams();
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/applet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appletParams }),
    }).catch(() => { /* best-effort */ });
  }, 300);
}

/**
 * Update a URL query param (for applet state sharing)
 * Uses replaceState so it doesn't create history entries
 */
export function updateAppletUrlParam(key: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  history.replaceState(history.state, '', url.toString());
  scheduleAppletParamsSync();
}

/**
 * Navigate to new applet URL params (creates history entry for back button)
 * Use this for user-initiated navigation within an applet
 */
export function navigateAppletUrlParam(key: string, value: string): void {
  const url = new URL(window.location.href);
  if (value) {
    url.searchParams.set(key, value);
  } else {
    url.searchParams.delete(key);
  }
  history.pushState(null, '', url.toString());
  scheduleAppletParamsSync();
}

/**
 * Register callback for URL param changes (including initial load)
 * 
 * This is the recommended way to handle URL params in applets.
 * Handles both initial load and navigation (back/forward, param changes).
 * 
 * Note: Only ONE handler is active at a time. When a new applet registers,
 * the previous handler is automatically removed.
 * 
 * @example
 * window.appletAPI.onUrlParamsChange(function(params) {
 *   loadImage(params.path || '');
 * });
 */
export function onUrlParamsChange(callback: (params: Record<string, string>) => void): void {
  // Remove any previous handler from current applet
  if (currentApplet?.popstateHandler) {
    window.removeEventListener('popstate', currentApplet.popstateHandler);
    currentApplet.popstateHandler = null;
  }
  
  // Call immediately with current params
  callback(getAppletUrlParams());

  // Create new handler
  const handler = () => {
    callback(getAppletUrlParams());
  };
  
  // Store on current applet instance if one exists
  if (currentApplet) {
    currentApplet.popstateHandler = handler;
  }
  
  // Listen for future changes (popstate from browser or router)
  window.addEventListener('popstate', handler);
}

/**
 * Store state from applet
 * Uses WebSocket when connected for real-time sync, otherwise stores locally.
 * Applet JS calls this to make state queryable by agent's get_applet_state tool
 */
function setAppletState(state: Record<string, unknown>): void {
  // Merge with existing pending state (newer values overwrite)
  pendingAppletState = { ...pendingAppletState, ...state };
  
  // If WebSocket connected, push immediately
  if (isWsConnected()) {
    wsSetState(state);
    console.log('[APPLET] State pushed via WebSocket:', Object.keys(state));
  } else {
    console.log('[APPLET] State queued (no WS):', Object.keys(state));
  }
}

/**
 * Options for sendAgentMessage
 */
interface MessageOptions {
  /** Applet slug for context (defaults to current applet) */
  appletSlug?: string;
  /** Base64 data URL for image submission (data:image/...;base64,...) */
  imageData?: string;
}

/** Max image size - Express default JSON body limit */
const MAX_IMAGE_SIZE = 100 * 1024;

/**
 * Send a message to the agent from applet JS
 * Creates an "applet" bubble (orange) in the chat and triggers agent response
 * 
 * @param prompt - The message to send to the agent
 * @param options - Optional applet slug and image data
 * @returns Promise that resolves when message is sent (not when agent responds)
 */
async function sendAgentMessage(prompt: string, options?: MessageOptions): Promise<void> {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    throw new Error('No active session - cannot send agent message');
  }
  
  // Validate image size (100KB server limit)
  if (options?.imageData && options.imageData.length > MAX_IMAGE_SIZE) {
    throw new Error('Image too large (max 100KB)');
  }
  
  // Default to current applet if not specified
  const slug = options?.appletSlug ?? currentApplet?.slug;
  
  console.log(`[APPLET] Sending agent message: "${prompt.slice(0, 50)}..." (session: ${sessionId}, applet: ${slug}${options?.imageData ? ', with image' : ''})`);
  
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      source: 'applet',
      appletSlug: slug,
      imageData: options?.imageData
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  console.log('[APPLET] Agent message sent successfully');
}

/**
 * Save a temporary file (e.g., image from canvas) to ~/.caco/tmp/
 * Returns the file path for agent viewing
 * 
 * @param data - Base64 data URL (data:image/png;base64,...) or raw base64
 * @param options - Optional filename and mimeType
 */
async function saveTempFile(
  data: string, 
  options?: { filename?: string; mimeType?: string }
): Promise<TempFileResult> {
  const response = await fetch('/api/tmpfile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data,
      filename: options?.filename,
      mimeType: options?.mimeType
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  const result = await response.json();
  return result;
}

/**
 * Call one of Caco's built-in file/workspace HTTP endpoints from applet JS.
 *
 * These are not MCP tools and do not consume agent tokens — they are plain
 * Caco backend routes under /api/mcp/* exposing read_file, write_file, and
 * list_directory. Naming is historical; the helper is kept for applets that
 * just need quick file ops without going through the agent.
 *
 * For arbitrary shell commands, use fetch('/api/shell', ...) directly.
 *
 * @param endpoint - Endpoint name: "read_file", "write_file", "list_directory"
 * @param params - Endpoint parameters as key-value object
 * @returns The JSON response (always shape { ok: true, ... } on success)
 */
async function callFileApi(endpoint: string, params: Record<string, unknown>): Promise<unknown> {
  const url = `/api/mcp/${endpoint}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || 'callFileApi failed');
  }
  return result;
}

/** @deprecated Use callFileApi(endpoint, params). callMCPTool is misnamed —
 *  these are Caco HTTP routes, not MCP tools. Will be removed in a future release.
 *  Backward-compat alias is wired in initAppletRuntime as callMCPTool: callFileApi. */

/**
 * Fetch with retries, timeout, and exponential backoff. For applet customScript
 * to call flaky external APIs (Azure DevOps, internal services, third parties).
 *
 * Retries on network errors, HTTP 5xx, and HTTP 429.
 * Does NOT retry on other 4xx (those won't fix themselves on retry).
 *
 * @param url - URL to fetch
 * @param init - Standard fetch init
 * @param options - { retries, timeoutMs, backoffMs, maxBackoffMs }
 * @throws FetchWithRetryError on final failure
 */
function appletFetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: FetchWithRetryOptions
): Promise<Response> {
  return fetchWithRetry(url, init, options);
}

// ============================================================================
// File-watch leases
// See docs/file-watch-leases.md
// ============================================================================

/** Event delivered to a WatchHandle's onChange callback. */
export interface WatchChangeEvent {
  path: string;
  eventType: 'change' | 'rename';
  filename?: string;
}

export interface WatchOptions {
  /** "file" or "dir". Defaults based on the path's current type. */
  scope?: 'file' | 'dir';
}

export interface WatchHandle {
  /** Set or replace the change handler. */
  onChange(cb: (event: WatchChangeEvent) => void): void;
  /** Release the lease and stop receiving events. Idempotent. */
  close(): Promise<void>;
}

interface WatchInternal {
  leaseId: string;
  callback: ((event: WatchChangeEvent) => void) | null;
}

/** All active WatchHandles in this page, keyed by leaseId. Used by the
 *  WebSocket event interceptor to route caco.fs.changed without going through
 *  the generic onSessionEvent path. */
const activeWatches = new Map<string, WatchInternal>();

const WATCH_RENEW_INTERVAL_MS = 60_000;

/** Tracks event objects already dispatched, to prevent multi-delivery when
 *  multiple onSessionEvent subscribers each call deliverWatchEvent. */
const deliveredEvents = new WeakSet<object>();

/** Called by the WS layer when a caco.fs.changed event arrives.
 *  Returns true if the event was consumed (dispatched to a known lease)
 *  and should not propagate to onSessionEvent subscribers. */
export function deliverWatchEvent(event: { type: string; data?: Record<string, unknown> }): boolean {
  if (event.type !== 'caco.fs.changed') return false;
  // Multiple onSessionEvent subscribers each call this for the same event
  // object; suppress duplicate dispatches.
  if (deliveredEvents.has(event)) return true;
  deliveredEvents.add(event);

  const data = event.data || {};
  const leaseId = data.leaseId as string | undefined;
  if (!leaseId) return true;
  const watch = activeWatches.get(leaseId);
  if (!watch || !watch.callback) {
    // Lease unknown to this tab (could be from another tab on same session)
    // or the consumer hasn't installed a callback yet. Drop quietly; do not
    // forward to onSessionEvent subscribers either way — caco.fs.changed is
    // an internal channel.
    return true;
  }
  try {
    watch.callback({
      path: data.path as string,
      eventType: data.eventType as 'change' | 'rename',
      filename: data.filename as string | undefined,
    });
  } catch (err) {
    console.error('[WATCH] onChange callback error:', err);
  }
  return true;
}

/**
 * Acquire a lease on a file or directory; receive caco.fs.changed events
 * coalesced to the lease. Auto-renews while the handle is alive.
 *
 * Throws on acquire failure. The handle stays open until close() or until
 * the server-side TTL expires (5 minutes default; renewed every 60s).
 *
 * Caco runs as the user; the only access boundary is filesystem permissions.
 * Watching paths the user can't read returns watch-failed.
 */
async function watchPath(path: string, options?: WatchOptions): Promise<WatchHandle> {
  const sessionId = getActiveSessionId();
  if (!sessionId) throw new Error('No active session for watchPath');

  const acquireUrl = `/api/sessions/${encodeURIComponent(sessionId)}/watch`;
  const acquireRes = await fetch(acquireUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, scope: options?.scope }),
  });
  if (!acquireRes.ok) {
    throw new Error(`watchPath HTTP ${acquireRes.status}`);
  }
  const body = await acquireRes.json();
  if (!body.ok) {
    const err = new Error(`watchPath failed: ${body.reason}${body.error ? ` (${body.error})` : ''}`);
    (err as Error & { reason?: string }).reason = body.reason;
    throw err;
  }
  const leaseId = body.leaseId as string;

  const watch: WatchInternal = { leaseId, callback: null };
  activeWatches.set(leaseId, watch);

  // Periodic renewal. setInterval is unref'd in the browser by default
  // (no equivalent of Node's unref), so we just clear it on close.
  let renewTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
    void (async () => {
    try {
      const renewRes = await fetch(`${acquireUrl}/${encodeURIComponent(leaseId)}/renew`, {
        method: 'POST',
      });
      if (!renewRes.ok) return;
      const renewBody = await renewRes.json();
      if (!renewBody.ok && renewBody.reason === 'unknown-lease') {
        // Server lost the lease (restart, expiry). Stop renewing; the consumer
        // will discover the watch is dead when no events arrive. They can
        // close() and re-acquire.
        if (renewTimer !== null) {
          clearInterval(renewTimer);
          renewTimer = null;
        }
      }
    } catch {
      // Network blip; try again next interval.
    }
    })();
  }, WATCH_RENEW_INTERVAL_MS);

  let closed = false;
  const handle: WatchHandle = {
    onChange(cb) {
      watch.callback = cb;
    },
    async close() {
      if (closed) return;
      closed = true;
      activeWatches.delete(leaseId);
      if (renewTimer !== null) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      try {
        await fetch(`${acquireUrl}/${encodeURIComponent(leaseId)}`, { method: 'DELETE' });
      } catch {
        // Best effort — TTL will expire the lease anyway.
      }
    },
  };

  currentApplet?.cleanupFns.push(() => { void handle.close(); });

  return handle;
}

/**
 * Load applet from URL query param (?applet=slug)
 * Called on page load
 * @returns true if an applet was loaded from URL
 */
export async function loadAppletFromUrl(): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('applet');
  if (slug) {
    console.log(`[APPLET] Loading from URL param: ${slug}`);
    try {
      await loadApplet(slug, getAppletUrlParams());
      return true;
    } catch (err) {
      console.error('[APPLET] Failed to load from URL:', err);
      return false;
    }
  }
  return false;
}

/**
 * List saved applets
 * Returns array of { slug, name, description, updatedAt }
 */
async function listSavedApplets(): Promise<Array<{
  slug: string;
  name: string;
  description: string | null;
  updatedAt: string;
}>> {
  const response = await fetch('/api/applets');
  if (!response.ok) {
    throw new Error(`Failed to list applets: HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.applets;
}

/**
 * Get and clear pending applet state
 * Called by message sender to include state with POST
 * Returns null if no state pending
 */
export function getAndClearPendingAppletState(): Record<string, unknown> | null {
  const state = pendingAppletState;
  pendingAppletState = null;
  return state;
}

/**
 * Navigation context for agent queries
 */
export interface NavigationContext {
  stack: Array<{ slug: string; label: string }>;
  urlParams: Record<string, string>;
}

/**
 * Get current navigation context
 * Sent with message POST for agent to query via get_applet_state tool
 */
export function getNavigationContext(): NavigationContext {
  return {
    stack: currentApplet ? [{ slug: currentApplet.slug, label: currentApplet.label }] : [],
    urlParams: getAppletUrlParams()
  };
}

/**
 * Destroy an applet instance (remove from DOM, cleanup styles/scripts/listeners)
 */
function destroyInstance(instance: AppletInstance): void {
  instance.cleanupFns.forEach(fn => { try { fn(); } catch { /* ignore */ } });
  instance.cleanupFns.length = 0;
  instance.element.remove();
  instance.styleElement?.remove();
  document.querySelectorAll(`script[data-applet-slug="${instance.slug}"]`)
    .forEach(el => el.remove());
  if (instance.popstateHandler) {
    window.removeEventListener('popstate', instance.popstateHandler);
    instance.popstateHandler = null;
  }
}

/**
 * Show an applet instance (unhide from stack)
 */
function showInstance(instance: AppletInstance): void {
  instance.element.style.display = 'block';
}

/**
 * Hide an applet instance (keep in stack, but not visible)
 */
function _hideInstance(instance: AppletInstance): void {
  instance.element.style.display = 'none';
}

function scopeAppletCSS(css: string, slug: string): string {
  const scope = `.applet-instance[data-slug="${slug}"]`;
  const temp = document.createElement('style');
  temp.textContent = css;
  document.head.appendChild(temp);
  const sheet = temp.sheet;
  if (!sheet) {
    temp.remove();
    return css;
  }
  
  const scoped: string[] = [];
  for (const rule of Array.from(sheet.cssRules)) {
    if (rule instanceof CSSKeyframesRule) {
      scoped.push(rule.cssText);
    } else if (rule instanceof CSSMediaRule) {
      const inner = Array.from(rule.cssRules)
        .map(r => r instanceof CSSStyleRule ? `${scope} ${r.selectorText} { ${r.style.cssText} }` : r.cssText)
        .join('\n');
      scoped.push(`@media ${rule.conditionText} {\n${inner}\n}`);
    } else if (rule instanceof CSSStyleRule) {
      const selectors = rule.selectorText.split(',')
        .map(s => `${scope} ${s.trim()}`)
        .join(', ');
      scoped.push(`${selectors} { ${rule.style.cssText} }`);
    } else {
      scoped.push(rule.cssText);
    }
  }
  
  temp.remove();
  return scoped.join('\n');
}

/**
 * Render applet content into a container element
 * Internal function - does the actual HTML/CSS/JS injection
 */
function renderAppletToInstance(
  container: HTMLElement, 
  content: AppletContent,
  slug: string,
  label: string
): HTMLStyleElement | null {
  let styleElement: HTMLStyleElement | null = null;
  
  // Inject CSS first (so HTML renders with styles), scoped to this applet instance
  if (content.css) {
    styleElement = document.createElement('style');
    styleElement.textContent = scopeAppletCSS(content.css, slug);
    styleElement.setAttribute('data-applet', 'true');
    styleElement.setAttribute('data-applet-slug', slug);
    document.head.appendChild(styleElement);
  }
  
  // Add label in the clearance zone (above applet content)
  const labelEl = document.createElement('div');
  labelEl.className = 'applet-label';
  labelEl.textContent = label;
  container.appendChild(labelEl);

  // Inject HTML
  container.insertAdjacentHTML('beforeend', content.html);

  // Execute JavaScript after HTML is in DOM
  if (content.js) {
    try {
      const scriptElement = document.createElement('script');
      scriptElement.setAttribute('data-applet', 'true');
      scriptElement.setAttribute('data-applet-slug', slug);
      // Provide appletContainer scoped to this instance
      scriptElement.textContent = `
(function() {
  var appletContainer = document.querySelector('.applet-instance[data-slug="${slug}"]');
  ${content.js}
})();
`;
      document.body.appendChild(scriptElement);
    } catch (error) {
      console.error('[APPLET] JavaScript execution error:', error);
      const errorDiv = document.createElement('div');
      errorDiv.className = 'applet-error';
      errorDiv.innerHTML = `<pre>JavaScript Error: ${error instanceof Error ? error.message : String(error)}</pre>`;
      container.appendChild(errorDiv);
    }
  }
  
  return styleElement;
}

/**
 * Load an applet, destroying any previous one
 * One applet at a time - no stack
 * 
 * @param slug - Unique identifier for the applet
 * @param label - Display name
 * @param content - The applet HTML/CSS/JS content
 */
export function pushApplet(slug: string, label: string, content: AppletContent): void {
  // Use regions.applet — scoped, cannot collide with chat content duplicates
  const appletView = regions.applet.el;
  
  console.log(`[APPLET] Loading: ${label} (${slug})`);
  
  // If same applet already loaded, just show it
  if (currentApplet?.slug === slug) {
    console.log(`[APPLET] Already loaded: ${slug}`);
    showInstance(currentApplet);
    return;
  }
  
  // Destroy current applet if any
  if (currentApplet) {
    console.log(`[APPLET] Destroying previous: ${currentApplet.slug}`);
    destroyInstance(currentApplet);
    currentApplet = null;
  }
  
  // Create new instance container
  const instanceDiv = document.createElement('div');
  instanceDiv.className = 'applet-instance';
  instanceDiv.dataset.slug = slug;
  appletView.appendChild(instanceDiv);
  
  // Set currentApplet BEFORE rendering so onUrlParamsChange can store its handler
  currentApplet = {
    slug,
    label,
    element: instanceDiv,
    styleElement: null,
    popstateHandler: null,
    cleanupFns: []
  };
  
  // Render content into instance (runs applet JS which may call onUrlParamsChange)
  currentApplet.styleElement = renderAppletToInstance(instanceDiv, content, slug, label);

  // Panel visibility is the router's job. pushApplet only loads content.

  // WebSocket is already connected on page load - no need to connect here
}

/**
 * Get the current applet slug, or null if none active
 */
export function getActiveAppletSlug(): string | null {
  return currentApplet?.slug ?? null;
}

/**
 * Get the current applet label (friendly name), or null if none active
 */
export function getActiveAppletLabel(): string | null {
  return currentApplet?.label ?? null;
}

/**
 * Check if applet view has content
 */
export function hasAppletContent(): boolean {
  return currentApplet !== null;
}
