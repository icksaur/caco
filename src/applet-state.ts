/**
 * Applet State
 * 
 * In-memory state for the current applet content.
 * Phase 1: Single applet, session-scoped, no persistence.
 */

export interface AppletContent {
  html: string;
  js?: string;
  css?: string;
  title?: string;
  timestamp: number;
}

let currentApplet: AppletContent | null = null;

/**
 * Set the current applet content
 */
export function setApplet(content: Omit<AppletContent, 'timestamp'>): void {
  currentApplet = {
    ...content,
    timestamp: Date.now()
  };
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
  console.log('[APPLET] Content cleared');
}
