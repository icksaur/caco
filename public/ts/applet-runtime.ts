/**
 * Applet Runtime
 * 
 * Client-side applet execution.
 * Handles receiving applet content from SSE and injecting it into the DOM.
 * 
 * Phase 2: Exposes setAppletState() for applet JS to push state to server.
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

/**
 * Initialize applet runtime - exposes global functions for applet JS
 * Call this once at app startup
 */
export function initAppletRuntime(): void {
  // Expose setAppletState globally for applet JS to use
  (window as unknown as { setAppletState: typeof setAppletState }).setAppletState = setAppletState;
}

/**
 * Push state from applet to server
 * Applet JS calls this to make state queryable by agent's get_applet_state tool
 */
async function setAppletState(state: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch('/api/applet/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state)
    });
    if (!response.ok) {
      console.error('[APPLET] Failed to sync state:', response.status);
    }
  } catch (error) {
    console.error('[APPLET] Error syncing state:', error);
  }
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
