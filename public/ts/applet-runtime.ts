/**
 * Applet Runtime
 * 
 * Client-side applet execution.
 * Handles receiving applet content from SSE and injecting it into the DOM.
 * 
 * Phase 2: Exposes setAppletState() for applet JS to push state to server.
 * Phase 3: Exposes loadApplet(slug) for loading saved applets from applet JS.
 * Phase 4: WebSocket for real-time state sync.
 * Phase 5: Agent invocation - applets can POST to active session.
 * Phase 6: Navigation API for SPA routing.
 */

import { setViewState, updateTitle } from './view-controller.js';
import { wsSetState, onStateUpdate, isWsConnected, getActiveSessionId as getWsActiveSession } from './websocket.js';
import { getActiveSessionId } from './app-state.js';

// Navigation API types (not yet in TypeScript lib)
interface NavigateEvent extends Event {
  canIntercept: boolean;
  downloadRequest: string | null;
  hashChange: boolean;
  navigationType: 'push' | 'replace' | 'reload' | 'traverse';
  destination: { url: string };
  intercept(options: { handler: () => Promise<void> }): void;
}

interface Navigation extends EventTarget {
  addEventListener(type: 'navigate', listener: (event: NavigateEvent) => void): void;
  navigate(url: string, options?: { state?: unknown }): { committed: Promise<void>; finished: Promise<void> };
  currentEntry: { getState(): unknown };
  updateCurrentEntry(options: { state: unknown }): void;
}

export interface AppletContent {
  html: string;
  js?: string;
  css?: string;
  title?: string;
}

// Applet instance in the navigation stack
interface AppletInstance {
  slug: string;
  label: string;
  element: HTMLElement;        // The .applet-instance div
  styleElement: HTMLStyleElement | null;
}

// Navigation stack - applets are hidden, not destroyed on forward nav
const MAX_STACK_DEPTH = 5;
const appletStack: AppletInstance[] = [];

// Current applet style element (for cleanup) - legacy, migrating to per-instance
let currentStyleElement: HTMLStyleElement | null = null;

// Pending applet state - accumulated until next message is sent
let pendingAppletState: Record<string, unknown> | null = null;

// Flag to prevent recursive navigation when inside a navigate handler
let insideNavigateHandler = false;

/**
 * Initialize applet runtime - exposes global functions for applet JS
 * Call this once at app startup
 */
export function initAppletRuntime(): void {
  // Expose setAppletState globally for applet JS to use
  (window as unknown as { setAppletState: typeof setAppletState }).setAppletState = setAppletState;
  // Expose listApplets globally for applet browser
  (window as unknown as { listApplets: typeof listSavedApplets }).listApplets = listSavedApplets;
  
  // URL params API for applet JS
  (window as unknown as { getAppletUrlParams: typeof getAppletUrlParams }).getAppletUrlParams = getAppletUrlParams;
  (window as unknown as { updateAppletUrlParam: typeof updateAppletUrlParam }).updateAppletUrlParam = updateAppletUrlParam;
  
  // WebSocket state subscription for applet JS
  (window as unknown as { onStateUpdate: typeof onStateUpdate }).onStateUpdate = onStateUpdate;
  
  // Agent invocation API for applet JS
  (window as unknown as { getSessionId: typeof getActiveSessionId }).getSessionId = getActiveSessionId;
  (window as unknown as { sendAgentMessage: typeof sendAgentMessage }).sendAgentMessage = sendAgentMessage;
  
  // Navigation API: single handler for all navigation types
  // (links, back/forward, programmatic, address bar)
  // Applets use <a href="?applet=slug"> links - no JS API needed
  setupNavigationHandler();
}

/**
 * Set up Navigation API handler for applet routing
 * Intercepts all navigations with ?applet= param
 */
function setupNavigationHandler(): void {
  // TypeScript doesn't have Navigation API types yet
  const nav = (window as unknown as { navigation?: Navigation }).navigation;
  if (!nav) {
    console.warn('[APPLET] Navigation API not available');
    return;
  }
  
  nav.addEventListener('navigate', (event: NavigateEvent) => {
    // Skip if we can't intercept (e.g., cross-origin)
    if (!event.canIntercept) return;
    
    // Skip downloads, hash-only changes, and page reloads
    // Page reloads are handled by loadAppletFromUrl() in main.ts
    if (event.downloadRequest !== null || event.hashChange) return;
    if (event.navigationType === 'reload') return;
    
    const url = new URL(event.destination.url);
    const appletSlug = url.searchParams.get('applet');
    
    // Only intercept same-origin applet navigations
    if (url.origin !== window.location.origin) return;
    
    // Check if navigating away from applet (no ?applet= param)
    if (!appletSlug) {
      // If we're currently showing an applet, intercept to clear it
      if (appletStack.length > 0) {
        event.intercept({
          handler: async () => {
            insideNavigateHandler = true;
            try {
              console.log('[APPLET] navigate: leaving applet view');
              clearApplet();
              updateTitle();
            } finally {
              insideNavigateHandler = false;
            }
          }
        });
      }
      return;
    }
    
    // Extract URL params for applet state
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      if (key !== 'applet') params[key] = value;
    });
    
    // Intercept and handle applet navigation
    event.intercept({
      handler: async () => {
        insideNavigateHandler = true;
        try {
          // Check if slug is already in stack (breadcrumb click or back navigation)
          const index = appletStack.findIndex(a => a.slug === appletSlug);
          if (index >= 0 && index < appletStack.length - 1) {
            // Pop down to existing entry (it's earlier in the stack)
            console.log(`[APPLET] navigate: popping to stack index ${index}`);
            while (appletStack.length > index + 1) {
              const popped = appletStack.pop()!;
              destroyInstance(popped);
            }
            showInstance(appletStack[index]);
            updateBreadcrumbUI();
            setViewState('applet');
          } else if (index === appletStack.length - 1) {
            // Already showing this applet, just ensure it's visible
            console.log(`[APPLET] navigate: already showing ${appletSlug}`);
            showInstance(appletStack[index]);
            setViewState('applet');
          } else {
            // Load applet (push new) - pushApplet will call setViewState
            console.log(`[APPLET] navigate: loading ${appletSlug}`, Object.keys(params).length ? params : '');
            await loadAppletBySlug(appletSlug, Object.keys(params).length ? params : undefined);
          }
          updateTitle();
        } finally {
          insideNavigateHandler = false;
        }
      }
    });
  });
  
  console.log('[APPLET] Navigation API handler installed');
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
 * Update a URL query param (for applet state sharing)
 * Uses replaceState so it doesn't create history entries
 */
export function updateAppletUrlParam(key: string, value: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(key, value);
  history.replaceState(history.state, '', url.toString());
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
 * Send a message to the agent from applet JS
 * Creates an "applet" bubble (orange) in the chat and triggers agent response
 * 
 * @param prompt - The message to send to the agent
 * @param appletSlug - Optional applet slug for context (defaults to current applet)
 * @returns Promise that resolves when message is sent (not when agent responds)
 */
async function sendAgentMessage(prompt: string, appletSlug?: string): Promise<void> {
  const sessionId = getActiveSessionId();
  if (!sessionId) {
    throw new Error('No active session - cannot send agent message');
  }
  
  // Default to current applet if not specified
  const slug = appletSlug ?? appletStack[appletStack.length - 1]?.slug;
  
  console.log(`[APPLET] Sending agent message: "${prompt.slice(0, 50)}..." (session: ${sessionId}, applet: ${slug})`);
  
  const response = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      source: 'applet',
      appletSlug: slug
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  console.log('[APPLET] Agent message sent successfully');
}

/**
 * Load a saved applet by slug, optionally with URL params
 * Applet JS can call this to navigate to a different applet with context
 * 
 * @param slug - The applet slug to load
 * @param params - Optional URL params to set (e.g., { file: '/path/to/image.jpg' })
 */
async function loadAppletBySlug(slug: string, params?: Record<string, string>): Promise<void> {
  try {
    console.log(`[APPLET] Loading applet: ${slug}`, params ? `with params: ${JSON.stringify(params)}` : '');
    
    // POST to load endpoint (updates server state + returns content)
    const response = await fetch(`/api/applets/${encodeURIComponent(slug)}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    
    const data = await response.json();
    
    // Push applet to stack with correct slug
    const content: AppletContent = {
      html: data.html,
      js: data.js,
      css: data.css,
      title: data.title
    };
    pushApplet(slug, data.title || slug, content);
    
    console.log(`[APPLET] Loaded: ${data.title} (${slug})`);
  } catch (error) {
    console.error(`[APPLET] Failed to load "${slug}":`, error);
    throw error;
  }
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
      await loadAppletBySlug(slug);
      return true;
    } catch (err) {
      console.error(`[APPLET] Failed to load from URL:`, err);
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
    stack: appletStack.map(a => ({ slug: a.slug, label: a.label })),
    urlParams: getAppletUrlParams()
  };
}

/**
 * Destroy an applet instance (remove from DOM, cleanup styles/scripts)
 */
function destroyInstance(instance: AppletInstance): void {
  instance.element.remove();
  instance.styleElement?.remove();
  // Remove scripts tagged with this instance's slug
  document.querySelectorAll(`script[data-applet-slug="${instance.slug}"]`)
    .forEach(el => el.remove());
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
function hideInstance(instance: AppletInstance): void {
  instance.element.style.display = 'none';
}

/**
 * Render applet content into a container element
 * Internal function - does the actual HTML/CSS/JS injection
 */
function renderAppletToInstance(
  container: HTMLElement, 
  content: AppletContent,
  slug: string
): HTMLStyleElement | null {
  let styleElement: HTMLStyleElement | null = null;
  
  // Inject CSS first (so HTML renders with styles)
  if (content.css) {
    styleElement = document.createElement('style');
    styleElement.textContent = content.css;
    styleElement.setAttribute('data-applet', 'true');
    styleElement.setAttribute('data-applet-slug', slug);
    document.head.appendChild(styleElement);
  }
  
  // Inject HTML
  container.innerHTML = content.html;
  
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
 * Sync current applet to URL using Navigation API
 * Enables browser back/forward navigation
 */
function syncToUrl(): void {
  // Skip if we're inside a navigate handler - the URL is already being handled
  if (insideNavigateHandler) return;
  
  const nav = (window as unknown as { navigation?: Navigation }).navigation;
  
  const current = appletStack[appletStack.length - 1];
  const url = new URL(window.location.href);
  const currentSlugInUrl = url.searchParams.get('applet');
  
  if (!current) {
    // No applets - clear the URL param
    if (url.searchParams.has('applet')) {
      url.searchParams.delete('applet');
      if (nav) {
        nav.navigate(url.toString(), { state: { appletStack: [] } });
      } else {
        history.pushState({ appletStack: [] }, '', url.toString());
      }
    }
    return;
  }
  
  // Only navigate if different from current URL
  if (currentSlugInUrl !== current.slug) {
    url.searchParams.set('applet', current.slug);
    const stackData = appletStack.map(a => ({ slug: a.slug, label: a.label }));
    
    if (nav) {
      nav.navigate(url.toString(), { state: { appletStack: stackData } });
    } else {
      history.pushState({ appletStack: stackData }, '', url.toString());
    }
    console.log(`[APPLET] URL synced: ${url.searchParams.get('applet')}`);
  }
}

/**
 * Update the breadcrumb UI based on current stack
 * Shows clickable trail with overflow collapse for 5+ items
 * Uses simple hrefs - Navigation API handles the actual navigation
 */
function updateBreadcrumbUI(): void {
  const container = document.querySelector('.applet-breadcrumbs');
  if (!container) return;
  
  container.innerHTML = '';
  
  if (appletStack.length === 0) {
    container.textContent = 'Applet';
    return;
  }
  
  // Determine which items to show
  const MAX_VISIBLE = 5;
  let itemsToShow: Array<{ instance: AppletInstance; originalIndex: number }>;
  let showEllipsis = false;
  
  if (appletStack.length <= MAX_VISIBLE) {
    itemsToShow = appletStack.map((instance, i) => ({ instance, originalIndex: i }));
  } else {
    // Show: first, ..., last 3
    showEllipsis = true;
    const first = { instance: appletStack[0], originalIndex: 0 };
    const lastThree = appletStack.slice(-3).map((instance, i) => ({
      instance,
      originalIndex: appletStack.length - 3 + i
    }));
    itemsToShow = [first, ...lastThree];
  }
  
  itemsToShow.forEach((item, displayIndex) => {
    const isLast = item.originalIndex === appletStack.length - 1;
    
    // Add ellipsis after first item if needed
    if (showEllipsis && displayIndex === 1) {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'breadcrumb-sep';
      ellipsis.textContent = ' > ';
      container.appendChild(ellipsis);
      
      const dots = document.createElement('span');
      dots.className = 'breadcrumb-ellipsis';
      dots.textContent = '...';
      container.appendChild(dots);
    }
    
    // Add separator before item (except first)
    if (displayIndex > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = ' > ';
      container.appendChild(sep);
    }
    
    // Create breadcrumb item - use <a> for clickable, <span> for current
    if (isLast) {
      const crumb = document.createElement('span');
      crumb.className = 'breadcrumb-item active';
      crumb.textContent = item.instance.label;
      container.appendChild(crumb);
    } else {
      const link = document.createElement('a');
      link.className = 'breadcrumb-item';
      link.href = `?applet=${item.instance.slug}`;
      link.textContent = item.instance.label;
      container.appendChild(link);
    }
  });
}

/**
 * Push a new applet onto the navigation stack
 * Handles deduplication and max depth limit
 * 
 * @param slug - Unique identifier for the applet
 * @param label - Display name for breadcrumbs
 * @param content - The applet HTML/CSS/JS content
 */
export function pushApplet(slug: string, label: string, content: AppletContent): void {
  const appletView = document.getElementById('appletView');
  if (!appletView) {
    console.error('[APPLET] #appletView container not found');
    return;
  }
  
  console.log(`[APPLET] Pushing: ${label} (${slug})`);
  
  // Check for duplicate - if already in stack, navigate to it instead
  const existingIndex = appletStack.findIndex(a => a.slug === slug);
  if (existingIndex >= 0) {
    console.log(`[APPLET] Dupe detected at index ${existingIndex}, truncating stack`);
    // Destroy all instances after the existing one
    while (appletStack.length > existingIndex + 1) {
      const popped = appletStack.pop()!;
      destroyInstance(popped);
    }
    // Show the existing instance
    showInstance(appletStack[existingIndex]);
    updateBreadcrumbUI();
    syncToUrl();
    setViewState('applet');
    return;
  }
  
  // Enforce max depth - destroy oldest (bottom of stack)
  while (appletStack.length >= MAX_STACK_DEPTH) {
    const oldest = appletStack.shift()!;
    console.log(`[APPLET] Stack limit reached, destroying oldest: ${oldest.slug}`);
    destroyInstance(oldest);
  }
  
  // Hide current top of stack (don't destroy)
  const current = appletStack[appletStack.length - 1];
  if (current) {
    hideInstance(current);
  }
  
  // Create new instance container
  const instanceDiv = document.createElement('div');
  instanceDiv.className = 'applet-instance';
  instanceDiv.dataset.slug = slug;
  appletView.appendChild(instanceDiv);
  
  // Render content into instance
  const styleElement = renderAppletToInstance(instanceDiv, content, slug);
  
  // Push to stack
  appletStack.push({
    slug,
    label,
    element: instanceDiv,
    styleElement
  });
  
  // Update UI
  updateBreadcrumbUI();
  syncToUrl();
  setViewState('applet');
  
  // WebSocket is already connected on page load - no need to connect here
}

/**
 * Clear the current applet content
 * Clears entire stack when leaving applet view completely
 */
export function clearApplet(): void {
  
  // Destroy all instances in stack
  while (appletStack.length > 0) {
    const instance = appletStack.pop()!;
    destroyInstance(instance);
  }
  
  // Update breadcrumb UI (now empty)
  updateBreadcrumbUI();
  
  // Also remove any orphaned applet styles and scripts (legacy cleanup)
  document.querySelectorAll('style[data-applet]').forEach(el => el.remove());
  document.querySelectorAll('script[data-applet]').forEach(el => el.remove());
  
  // Clear legacy style element if any
  if (currentStyleElement) {
    currentStyleElement.remove();
    currentStyleElement = null;
  }
  
  // Switch back to chat view
  setViewState('chatting');
}

/**
 * Pop the current applet from the stack and show previous
 * Used for back navigation
 */
export function popApplet(): void {
  if (appletStack.length <= 1) {
    console.log('[APPLET] Cannot pop - at bottom of stack');
    return;
  }
  
  // Destroy current
  const current = appletStack.pop()!;
  console.log(`[APPLET] Popping: ${current.slug}`);
  destroyInstance(current);
  
  // Show previous
  const previous = appletStack[appletStack.length - 1];
  showInstance(previous);
  
  updateBreadcrumbUI();
  syncToUrl();
}

/**
 * Get the current applet stack (read-only)
 */
export function getAppletStack(): ReadonlyArray<{ slug: string; label: string }> {
  return appletStack.map(a => ({ slug: a.slug, label: a.label }));
}

/**
 * Get the current (top) applet slug, or null if none active
 */
export function getActiveAppletSlug(): string | null {
  if (appletStack.length === 0) return null;
  return appletStack[appletStack.length - 1].slug;
}

/**
 * Get the current (top) applet label (friendly name), or null if none active
 */
export function getActiveAppletLabel(): string | null {
  if (appletStack.length === 0) return null;
  return appletStack[appletStack.length - 1].label;
}

/**
 * Check if applet view has content
 */
export function hasAppletContent(): boolean {
  const contentContainer = document.querySelector('#appletView .applet-content');
  return contentContainer !== null && contentContainer.innerHTML.trim() !== '';
}
