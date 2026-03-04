/**
 * Applet State
 * 
 * Minimal state for applet interactions:
 * - User state pushed from applet JS (for agent to query)
 * - Navigation context (stack + URL params)
 * - Active applet slug tracking
 * - Reload signal
 */

export interface NavigationContext {
  stack: Array<{ slug: string; label: string }>;
  urlParams: Record<string, string>;
}

let appletUserState: Record<string, unknown> = {};
let appletNavigation: NavigationContext = { stack: [], urlParams: {} };
let activeSlug: string | null = null;
let pendingReload = false;

/**
 * Set user state (called from /api/applet/state endpoint or message POST)
 */
export function setAppletUserState(state: Record<string, unknown>): void {
  appletUserState = { ...appletUserState, ...state };
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
}

/**
 * Get navigation context (called from get_applet_state tool)
 */
export function getAppletNavigation(): NavigationContext {
  return appletNavigation;
}

/**
 * Get the currently active applet slug
 */
export function getActiveAppletSlug(): string | null {
  return activeSlug;
}

/**
 * Set the currently active applet slug (called on applet load)
 */
export function setActiveAppletSlug(slug: string | null): void {
  activeSlug = slug;
}

/**
 * Signal that the client should reload
 */
export function triggerReload(): void {
  pendingReload = true;
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
