/**
 * Input Router
 * 
 * Centralized keyboard input routing to active view/applet.
 * Applets register handlers instead of using global document listeners.
 * The router dispatches only to the currently active applet.
 */

import { getViewState, isAppletPanelVisible, toggleAppletExpanded } from './view-controller.js';
import { toggleSessions, toggleApplet } from './router.js';
import { getCurrentCwd, getNewChatCwd } from './app-state.js';
import { getPanelState } from './panel-state.js';

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
    
    // Global Ctrl+P: open file finder. V3.y.2 — for active
    // sessions, route to file-edits applet (the unified files
    // applet). For newChat (no session, no cwd), fall back to
    // the standalone file-finder. See docs/files-applet-v3.y.md
    // §4.2.A.
    if ((e.ctrlKey || e.metaKey) && e.key === 'p' && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      if (getViewState() === 'newChat') {
        const cwd = getNewChatCwd() || getCurrentCwd() || '~';
        window.location.href = '/?applet=file-finder&root=' + encodeURIComponent(cwd);
        return;
      }
      // SPA navigate so panel + applet state survive.
      getPanelState().set({ applet: true }, 'deep-link');
      const nav = window.navigation;
      let navigated = false;
      if (nav && typeof nav.navigate === 'function') {
        try {
          nav.navigate('?applet=file-edits&openFinder=1');
          navigated = true;
        } catch {
          // Navigation API can throw (e.g. during a prior
          // navigation). Fall through to full-page nav.
        }
      }
      if (!navigated) {
        window.location.href = '/?applet=file-edits&openFinder=1';
      }
      return;
    }
    
    // Global Ctrl+Shift+F: open session search
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
      e.preventDefault();
      window.location.href = '/?applet=session-search';
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
    }
  });
  
}
