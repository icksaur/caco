/**
 * Applet Runtime
 * 
 * Client-side applet execution.
 * Handles receiving applet content from SSE and injecting it into the DOM.
 * 
 * Navigation is handled by router.ts - this module just renders applets.
 */

import { setViewState, updateTitle } from './view-controller.js';
import { wsSetState, onStateUpdate, isWsConnected, getActiveSessionId as getWsActiveSession } from './websocket.js';
import { getActiveSessionId } from './app-state.js';

// Result type for saveTempFile
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

// Current applet instance (one at a time per spec)
interface AppletInstance {
  slug: string;
  label: string;
  element: HTMLElement;        // The .applet-instance div
  styleElement: HTMLStyleElement | null;
}

// Single current applet (no stack - switching destroys previous)
let currentApplet: AppletInstance | null = null;

// Current applet style element (for cleanup) - legacy, migrating to per-instance
let currentStyleElement: HTMLStyleElement | null = null;

// Pending applet state - accumulated until next message is sent
let pendingAppletState: Record<string, unknown> | null = null;

/**
 * Helper function for applet JS to expose functions globally.
 * Needed for onclick handlers since scripts are wrapped in IIFE.
 */
function expose(nameOrObj: string | Record<string, unknown>, fn?: unknown): void {
  if (typeof nameOrObj === 'string' && fn !== undefined) {
    (window as Record<string, unknown>)[nameOrObj] = fn;
  } else if (typeof nameOrObj === 'object') {
    Object.assign(window, nameOrObj);
  }
}

/**
 * Initialize applet runtime - exposes global functions for applet JS
 * Call this once at app startup
 */
export function initAppletRuntime(): void {
  // Expose helper for applets to expose their own functions
  (window as unknown as { expose: typeof expose }).expose = expose;

  // Expose setAppletState globally for applet JS to use
  (window as unknown as { setAppletState: typeof setAppletState }).setAppletState = setAppletState;
  // Expose listApplets globally for applet browser
  (window as unknown as { listApplets: typeof listSavedApplets }).listApplets = listSavedApplets;
  
  // URL params API for applet JS
  (window as unknown as { getAppletUrlParams: typeof getAppletUrlParams }).getAppletUrlParams = getAppletUrlParams;
  (window as unknown as { getAppletSlug: typeof getAppletSlug }).getAppletSlug = getAppletSlug;
  (window as unknown as { updateAppletUrlParam: typeof updateAppletUrlParam }).updateAppletUrlParam = updateAppletUrlParam;
  
  // WebSocket state subscription for applet JS
  (window as unknown as { onStateUpdate: typeof onStateUpdate }).onStateUpdate = onStateUpdate;
  
  // Agent invocation API for applet JS
  (window as unknown as { getSessionId: typeof getActiveSessionId }).getSessionId = getActiveSessionId;
  (window as unknown as { sendAgentMessage: typeof sendAgentMessage }).sendAgentMessage = sendAgentMessage;

  // Temp file API for applet JS - save images for agent to view
  (window as unknown as { saveTempFile: typeof saveTempFile }).saveTempFile = saveTempFile;

  // MCP tool API for applet JS - call MCP tools
  (window as unknown as { callMCPTool: typeof callMCPTool }).callMCPTool = callMCPTool;
  
  // Navigation will be handled by router.ts (Phase 3)
  // For now, applets are loaded via loadAppletBySlug() directly
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
  const slug = appletSlug ?? currentApplet?.slug;
  
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
 * Call an MCP tool from applet JS
 * Applets can use MCP tools the agent has access to via HTTP proxy
 * 
 * @param toolName - The MCP tool to call (e.g., "read_file", "write_file", "list_directory")
 * @param params - Tool parameters as key-value object
 * @returns Tool result
 */
async function callMCPTool(toolName: string, params: Record<string, unknown>): Promise<unknown> {
  const endpoint = `/api/mcp/${toolName}`;
  
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  
  const result = await response.json();
  
  // Check for tool error
  if (!result.ok) {
    throw new Error(result.error || 'Tool call failed');
  }
  
  return result;
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
    stack: currentApplet ? [{ slug: currentApplet.slug, label: currentApplet.label }] : [],
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
 * Load an applet, destroying any previous one
 * One applet at a time - no stack
 * 
 * @param slug - Unique identifier for the applet
 * @param label - Display name
 * @param content - The applet HTML/CSS/JS content
 */
export function pushApplet(slug: string, label: string, content: AppletContent): void {
  const appletView = document.getElementById('appletView');
  if (!appletView) {
    console.error('[APPLET] #appletView container not found');
    return;
  }
  
  console.log(`[APPLET] Loading: ${label} (${slug})`);
  
  // If same applet already loaded, just show it
  if (currentApplet?.slug === slug) {
    console.log(`[APPLET] Already loaded: ${slug}`);
    showInstance(currentApplet);
    setViewState('applet');
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
  
  // Render content into instance
  const styleElement = renderAppletToInstance(instanceDiv, content, slug);
  
  // Store as current
  currentApplet = {
    slug,
    label,
    element: instanceDiv,
    styleElement
  };
  
  setViewState('applet');
  
  // WebSocket is already connected on page load - no need to connect here
}

/**
 * Clear the current applet content
 */
export function clearApplet(): void {
  if (currentApplet) {
    destroyInstance(currentApplet);
    currentApplet = null;
  }
  
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
