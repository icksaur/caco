/**
 * Applet Runtime
 * 
 * Client-side applet execution.
 * Handles receiving applet content from SSE and injecting it into the DOM.
 * 
 * Phase 2: Exposes setAppletState() for applet JS to push state to server.
 * Phase 3: Exposes loadApplet(slug) for loading saved applets from applet JS.
 */

import { setViewState } from './view-controller.js';

export interface AppletContent {
  html: string;
  js?: string;
  css?: string;
  title?: string;
}

// Current applet style element (for cleanup)
let currentStyleElement: HTMLStyleElement | null = null;

// Pending applet state - accumulated until next message is sent
let pendingAppletState: Record<string, unknown> | null = null;

/**
 * Initialize applet runtime - exposes global functions for applet JS
 * Call this once at app startup
 */
export function initAppletRuntime(): void {
  // Expose setAppletState globally for applet JS to use
  (window as unknown as { setAppletState: typeof setAppletState }).setAppletState = setAppletState;
  // Expose loadApplet globally for applet browser
  (window as unknown as { loadApplet: typeof loadAppletBySlug }).loadApplet = loadAppletBySlug;
  // Expose listApplets globally for applet browser
  (window as unknown as { listApplets: typeof listSavedApplets }).listApplets = listSavedApplets;
}

/**
 * Store state from applet locally
 * State is accumulated and sent with the next message POST
 * Applet JS calls this to make state queryable by agent's get_applet_state tool
 */
function setAppletState(state: Record<string, unknown>): void {
  // Merge with existing pending state (newer values overwrite)
  pendingAppletState = { ...pendingAppletState, ...state };
  console.log('[APPLET] State updated locally:', pendingAppletState);
}

/**
 * Load a saved applet by slug
 * Applet JS can call this to switch to a different applet
 */
async function loadAppletBySlug(slug: string): Promise<void> {
  try {
    console.log(`[APPLET] Loading applet: ${slug}`);
    
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
    
    // Execute the loaded applet
    executeApplet({
      html: data.html,
      js: data.js,
      css: data.css,
      title: data.title
    });
    
    console.log(`[APPLET] Loaded: ${data.title} (${slug})`);
  } catch (error) {
    console.error(`[APPLET] Failed to load "${slug}":`, error);
    throw error;
  }
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
 * Execute applet content in the applet view
 * 
 * This injects HTML, CSS, and executes JavaScript in the applet container.
 * Called when receiving applet.update SSE event.
 */
export function executeApplet(content: AppletContent): void {
  const appletView = document.getElementById('appletView');
  if (!appletView) {
    console.error('[APPLET] #appletView container not found');
    return;
  }
  
  console.log(`[APPLET] Executing: ${content.title || 'untitled'}`);
  
  // Clear previous content
  clearApplet();
  
  // Set title if provided
  if (content.title) {
    const header = appletView.querySelector('.applet-header');
    if (header) {
      header.textContent = content.title;
    }
  }
  
  // Get or create the content container
  let contentContainer = appletView.querySelector('.applet-content') as HTMLElement;
  if (!contentContainer) {
    contentContainer = document.createElement('div');
    contentContainer.className = 'applet-content';
    appletView.appendChild(contentContainer);
  }
  
  // Inject CSS first (so HTML renders with styles)
  if (content.css) {
    currentStyleElement = document.createElement('style');
    currentStyleElement.textContent = content.css;
    currentStyleElement.setAttribute('data-applet', 'true');
    document.head.appendChild(currentStyleElement);
  }
  
  // Inject HTML
  contentContainer.innerHTML = content.html;
  
  // Execute JavaScript after HTML is in DOM
  // Uses <script> element injection so functions are defined in global scope
  // This allows inline onclick handlers to work (they look up functions globally)
  if (content.js) {
    try {
      // Remove any previous applet scripts
      document.querySelectorAll('script[data-applet]').forEach(el => el.remove());
      
      const scriptElement = document.createElement('script');
      scriptElement.setAttribute('data-applet', 'true');
      // Provide appletContainer as a global for convenience
      // Functions defined here will be global, so onclick="myFunc()" works
      scriptElement.textContent = `
var appletContainer = document.querySelector('#appletView .applet-content');
${content.js}
`;
      document.body.appendChild(scriptElement);
    } catch (error) {
      console.error('[APPLET] JavaScript execution error:', error);
      const errorDiv = document.createElement('div');
      errorDiv.className = 'applet-error';
      errorDiv.innerHTML = `<pre>JavaScript Error: ${error instanceof Error ? error.message : String(error)}</pre>`;
      contentContainer.appendChild(errorDiv);
    }
  }
  
  // Switch to applet view
  setViewState('applet');
}

/**
 * Clear the current applet content
 */
export function clearApplet(): void {
  const appletView = document.getElementById('appletView');
  if (!appletView) return;
  
  // Remove injected styles
  if (currentStyleElement) {
    currentStyleElement.remove();
    currentStyleElement = null;
  }
  
  // Also remove any orphaned applet styles and scripts
  document.querySelectorAll('style[data-applet]').forEach(el => el.remove());
  document.querySelectorAll('script[data-applet]').forEach(el => el.remove());
  
  // Clear content container
  const contentContainer = appletView.querySelector('.applet-content');
  if (contentContainer) {
    contentContainer.innerHTML = '';
  }
  
  // Reset header
  const header = appletView.querySelector('.applet-header');
  if (header) {
    header.textContent = 'Applet';
  }
}

/**
 * Check if applet view has content
 */
export function hasAppletContent(): boolean {
  const contentContainer = document.querySelector('#appletView .applet-content');
  return contentContainer !== null && contentContainer.innerHTML.trim() !== '';
}
