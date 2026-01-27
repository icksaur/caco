/**
 * Applet State
 * 
 * In-memory state for the current applet content and user state.
 * Phase 1: Single applet, session-scoped, no persistence.
 * Phase 2: Applet-pushed state for agent queries.
 * Phase 3: Active slug tracking for persisted applets.
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

// Phase 3: Active slug if this applet was loaded from/saved to disk
let activeSlug: string | null = null;

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
