/**
 * Applet Runtime
 * 
 * Client-side applet execution.
 * Handles receiving applet content from SSE and injecting it into the DOM.
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
  if (content.js) {
    try {
      // Create a function to execute JS with access to the applet container
      // This runs in global scope but we pass the container for convenience
      const executeScript = new Function('appletContainer', content.js);
      executeScript(contentContainer);
    } catch (error) {
      console.error('[APPLET] JavaScript execution error:', error);
      // Show error to user in applet view
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
  
  // Also remove any orphaned applet styles
  document.querySelectorAll('style[data-applet]').forEach(el => el.remove());
  
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
