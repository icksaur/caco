/**
 * Applet State
 * 
 * Minimal state for applet interactions:
 * - User state pushed from applet JS (for agent to query)
 * - Navigation context (stack + URL params)
 * - Reload signal
 * 
 * Removed (agent writes files directly):
 * - Applet content storage (set_applet_content tool)
 * - Active slug tracking
 */

export interface NavigationContext {
  stack: Array<{ slug: string; label: string }>;
  urlParams: Record<string, string>;
}

// User state pushed from applet JS
let appletUserState: Record<string, unknown> = {};

// Navigation context from client
let appletNavigation: NavigationContext = { stack: [], urlParams: {} };

// Reload signal for client
let pendingReload = false;

/**
 * Set user state (called from /api/applet/state endpoint or message POST)
 */
export function setAppletUserState(state: Record<string, unknown>): void {
  appletUserState = { ...appletUserState, ...state };
  console.log('[APPLET] User state updated:', Object.keys(state).join(', '));
}

/**
 * Get user state (called from get_applet_state tool)
 */
export function getAppletUserState(): Record<string, unknown> {
  return appletUserState;
}

/**
 * Clear user state (e.g., on applet change)
 */
export function clearAppletUserState(): void {
  appletUserState = {};
}

/**
 * Set navigation context (called when receiving message with appletNavigation)
 */
export function setAppletNavigation(nav: NavigationContext): void {
  appletNavigation = nav;
  console.log('[APPLET] Navigation context updated:', nav.stack.length, 'items in stack');
}

/**
 * Get navigation context (called from get_applet_state tool)
 */
export function getAppletNavigation(): NavigationContext {
  return appletNavigation;
}

/**
 * Signal that the client should reload
 */
export function triggerReload(): void {
  pendingReload = true;
  console.log('[RELOAD] Page reload triggered');
}

/**
 * Check and consume pending reload signal
 */
export function consumeReloadSignal(): boolean {
  if (pendingReload) {
    pendingReload = false;
    return true;
  }
  return false;
}
