/**
 * Applet State
 * 
 * In-memory state for the current applet content and user state.
 * Phase 1: Single applet, session-scoped, no persistence.
 * Phase 2: Applet-pushed state for agent queries.
 */

export interface AppletContent {
  html: string;
  js?: string;
  css?: string;
  title?: string;
  timestamp: number;
}

let currentApplet: AppletContent | null = null;

// Phase 2: User state pushed from applet JS
let appletUserState: Record<string, unknown> = {};

/**
 * Set the current applet content
 */
export function setApplet(content: Omit<AppletContent, 'timestamp'>): void {
  currentApplet = {
    ...content,
    timestamp: Date.now()
  };
  // Clear user state when applet changes
  appletUserState = {};
  console.log(`[APPLET] Content set: ${content.title || 'untitled'} (${content.html.length} chars HTML)`);
}

/**
 * Get the current applet content
 */
export function getApplet(): AppletContent | null {
  return currentApplet;
}

/**
 * Clear the current applet
 */
export function clearApplet(): void {
  currentApplet = null;
  appletUserState = {};
  console.log('[APPLET] Content cleared');
}

/**
 * Set user state (called from /api/applet/state endpoint)
 */
export function setAppletUserState(state: Record<string, unknown>): void {
  appletUserState = { ...appletUserState, ...state };
  console.log(`[APPLET] User state updated:`, Object.keys(state).join(', '));
}

/**
 * Get user state (called from get_applet_state tool)
 */
export function getAppletUserState(): Record<string, unknown> {
  return appletUserState;
}
