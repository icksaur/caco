/**
 * Input Router
 * 
 * Centralized keyboard input routing to active view/applet.
 * Applets register handlers instead of using global document listeners.
 * The router dispatches only to the currently active applet.
 */

import { getViewState } from './view-controller.js';
import { getActiveAppletSlug } from './applet-runtime.js';

export type KeyHandler = (e: KeyboardEvent) => void;

/** Registered keyboard handlers by applet slug */
const keyHandlers = new Map<string, KeyHandler>();

/** Handler for chat view keyboard shortcuts */
let chatKeyHandler: KeyHandler | null = null;

/**
 * Register a keyboard handler for an applet
 * Only receives events when this applet is active
 * 
 * @param appletSlug - The applet's slug identifier
 * @param handler - Keyboard event handler function
 */
export function registerKeyHandler(appletSlug: string, handler: KeyHandler): void {
  keyHandlers.set(appletSlug, handler);
}

/**
 * Unregister a keyboard handler for an applet
 * Called when applet is destroyed/unloaded
 * 
 * @param appletSlug - The applet's slug identifier
 */
export function unregisterKeyHandler(appletSlug: string): void {
  keyHandlers.delete(appletSlug);
}

/**
 * Register keyboard handler for chat view
 * Receives events when in 'chatting' or 'newChat' view
 * 
 * @param handler - Keyboard event handler function
 */
export function registerChatKeyHandler(handler: KeyHandler): void {
  chatKeyHandler = handler;
}

/**
 * Initialize the global input router
 * Call once at app startup (after view-controller is ready)
 */
export function initInputRouter(): void {
  // Single global keyboard listener - routes to active handler
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    // Let native inputs handle their own events
    const target = e.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target.isContentEditable) {
      return;
    }
    
    const viewState = getViewState();
    
    switch (viewState) {
      case 'applet': {
        const slug = getActiveAppletSlug();
        if (slug && keyHandlers.has(slug)) {
          keyHandlers.get(slug)!(e);
        }
        break;
      }
      
      case 'chatting':
      case 'newChat': {
        if (chatKeyHandler) {
          chatKeyHandler(e);
        }
        break;
      }
      
      case 'sessions':
        // Session list view - could add handlers here if needed
        break;
    }
  });
  
}

/**
 * Check if a handler is registered for an applet
 * Useful for debugging
 */
export function hasKeyHandler(appletSlug: string): boolean {
  return keyHandlers.has(appletSlug);
}

/**
 * Get list of registered applet slugs (for debugging)
 */
export function getRegisteredApplets(): string[] {
  return Array.from(keyHandlers.keys());
}
