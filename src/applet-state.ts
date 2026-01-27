/**
 * Applet State
 * 
 * In-memory state for the current applet content and user state.
 * Phase 1: Single applet, session-scoped, no persistence.
 * Phase 2: Applet-pushed state for agent queries.
 * Phase 3: Active slug tracking for persisted applets.
 * Phase 4: Navigation context (stack + URL params) for agent queries.
 */

export interface AppletContent {
  html: string;
  js?: string;
  css?: string;
  title?: string;
  timestamp: number;
}

export interface NavigationContext {
  stack: Array<{ slug: string; label: string }>;
  urlParams: Record<string, string>;
}

let currentApplet: AppletContent | null = null;

// Phase 2: User state pushed from applet JS
let appletUserState: Record<string, unknown> = {};

// Phase 3: Active slug if this applet was loaded from/saved to disk
let activeSlug: string | null = null;

// Phase 4: Navigation context from client
let appletNavigation: NavigationContext = { stack: [], urlParams: {} };

/**
 * Set the current applet content
 * @param slug - Optional slug if loading from disk
 */
export function setApplet(content: Omit<AppletContent, 'timestamp'>, slug?: string): void {
  currentApplet = {
    ...content,
    timestamp: Date.now()
  };
  // Clear user state when applet changes
  appletUserState = {};
  // Track slug if provided
  activeSlug = slug || null;
  console.log(`[APPLET] Content set: ${content.title || 'untitled'} (${content.html.length} chars HTML)${slug ? ` [slug: ${slug}]` : ''}`);
}

/**
 * Get the current applet content
 */
export function getApplet(): AppletContent | null {
  return currentApplet;
}

/**
 * Get the active applet slug (if loaded from/saved to disk)
 */
export function getActiveSlug(): string | null {
  return activeSlug;
}

/**
 * Set the active slug (e.g., after saving)
 */
export function setActiveSlug(slug: string | null): void {
  activeSlug = slug;
}

/**
 * Clear the current applet
 */
export function clearApplet(): void {
  currentApplet = null;
  appletUserState = {};
  activeSlug = null;
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

/**
 * Set navigation context (called when receiving message with appletNavigation)
 */
export function setAppletNavigation(nav: NavigationContext): void {
  appletNavigation = nav;
  console.log(`[APPLET] Navigation context updated: ${nav.stack.length} items in stack`);
}

/**
 * Get navigation context (called from get_applet_state tool)
 */
export function getAppletNavigation(): NavigationContext {
  return appletNavigation;
}

// Reload signal for client
let pendingReload = false;

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
