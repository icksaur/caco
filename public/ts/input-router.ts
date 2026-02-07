/**
 * Input Router
 * 
 * Centralized keyboard input routing to active view/applet.
 * Applets register handlers instead of using global document listeners.
 * The router dispatches only to the currently active applet.
 */

import { getViewState, isAppletPanelVisible, toggleAppletExpanded } from './view-controller.js';
import { toggleSessions, toggleApplet } from './router.js';

export type KeyHandler = (e: KeyboardEvent) => void;

/** Handler for chat view keyboard shortcuts */
let chatKeyHandler: KeyHandler | null = null;

/** Leader key state for ESC sequences */
let escapeTime: number | null = null;
const LEADER_TIMEOUT = 500;

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
    // Leader key follow-ups (checked first, works from anywhere)
    if (escapeTime && Date.now() - escapeTime < LEADER_TIMEOUT) {
      escapeTime = null;
      if (e.key === 'l') { toggleSessions(); e.preventDefault(); return; }
      if (e.key === '.') { toggleApplet(); e.preventDefault(); return; }
      if (e.key === ',') {
        if (isAppletPanelVisible()) toggleAppletExpanded();
        e.preventDefault();
        return;
      }
      // Invalid follow-up key - fall through to normal handling
    }
    
    // Escape - blur any input, start leader
    if (e.key === 'Escape') {
      const active = document.activeElement as HTMLElement;
      if (active && active !== document.body) {
        active.blur();
      }
      escapeTime = Date.now();
      e.preventDefault();
      return;
    }
    
    // Let native inputs handle their own events (for non-ESC keys)
    const target = e.target as HTMLElement;
    const tag = target.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || target.isContentEditable) {
      return;
    }
    
    const viewState = getViewState();
    
    switch (viewState) {
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
