/**
 * View State Controller
 * 
 * SINGLE SOURCE OF TRUTH for which view is active (sessions/newChat/chatting/applet).
 * All view transitions must go through setViewState() to prevent invalid states.
 * 
 * This manages VIEW state only. For session/model/UI flags, see app-state.ts.
 */

import { scrollToBottom } from './ui-utils.js';
import { clearActiveSession, getCurrentCwd } from './app-state.js';
import { getActiveAppletSlug, getActiveAppletLabel } from './applet-runtime.js';
import { getServerHostname } from './hostname-hash.js';

/** Valid application view states */
export type ViewState = 'sessions' | 'newChat' | 'chatting' | 'applet';

/** Current view state */
let currentState: ViewState = 'sessions';

/** Cached DOM element references */
interface ViewElements {
  chatView: HTMLElement | null;
  sessionView: HTMLElement | null;
  appletPanel: HTMLElement | null;  // New: container for applet split
  appletView: HTMLElement | null;
  chat: HTMLElement | null;
  newChat: HTMLElement | null;
  footer: HTMLElement | null;
  menuBtn: HTMLElement | null;
  appletBtn: HTMLElement | null;
}

let cachedElements: ViewElements | null = null;

/**
 * Get DOM elements (cached after first call)
 */
function getElements(): ViewElements {
  if (!cachedElements) {
    cachedElements = {
      chatView: document.getElementById('chatScroll'),
      sessionView: document.getElementById('sessionView'),
      appletPanel: document.getElementById('appletPanel'),
      appletView: document.getElementById('appletView'),
      chat: document.getElementById('chat'),
      newChat: document.getElementById('newChat'),
      footer: document.getElementById('chatFooter'),
      menuBtn: document.getElementById('menuBtn'),
      appletBtn: document.getElementById('appletBtn'),
    };
  }
  return cachedElements;
}

/**
 * Get current view state
 */
export function getViewState(): ViewState {
  return currentState;
}

/**
 * Set the application view state
 * 
 * This atomically updates ALL relevant DOM elements to match the target state.
 * Invalid states are impossible - you can only set valid ViewState values.
 */
export function setViewState(state: ViewState): void {
  const els = getElements();
  
  // Skip if already in this state
  if (state === currentState) return;
  
  currentState = state;

  // Reset main panel elements (sessions overlay, newChat/chat toggle)
  els.sessionView?.classList.remove('active');
  els.chat?.classList.add('hidden');
  els.newChat?.classList.add('hidden');
  els.footer?.classList.add('hidden');
  els.menuBtn?.classList.remove('active');
  
  // Note: applet panel visibility is independent of view state
  // It persists across sessions/newChat/chatting transitions
  // Only explicitly toggled via toggleApplet or loadApplet

  // Apply state-specific classes
  switch (state) {
    case 'sessions':
      els.sessionView?.classList.add('active');
      els.menuBtn?.classList.add('active');
      break;
      
    case 'newChat':
      els.newChat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      // Clear session so messages don't go to old session
      clearActiveSession();
      break;
      
    case 'chatting':
      els.chat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      // Scroll to bottom after view is painted
      requestAnimationFrame(() => scrollToBottom());
      break;
      
    case 'applet':
      // Show applet panel (make it visible)
      els.appletPanel?.classList.remove('hidden');
      els.appletBtn?.classList.add('active');
      break;
  }
  
  // Applet button visibility: show when applet is loaded
  const hasApplet = !els.appletPanel?.classList.contains('hidden');
  if (hasApplet) {
    els.appletBtn?.classList.remove('hidden');
    if (state === 'applet') {
      els.appletBtn?.classList.add('active');
    } else {
      els.appletBtn?.classList.remove('active');
    }
  } else {
    els.appletBtn?.classList.add('hidden');
    els.appletBtn?.classList.remove('active');
  }
  
  // Update browser tab title
  updateTitle();
}

/**
 * Update browser tab title based on current view
 * Format: hostname context
 */
export function updateTitle(): void {
  const baseTitle = getServerHostname();
  let title = baseTitle;
  
  switch (currentState) {
    case 'sessions':
      title = `${baseTitle} Sessions`;
      break;
    case 'newChat':
      title = `${baseTitle} New Chat`;
      break;
    case 'chatting': {
      const cwd = getCurrentCwd();
      if (cwd) {
        // Show just the last directory name
        const dirName = cwd.split('/').pop() || cwd;
        title = `${baseTitle} ${dirName}`;
      }
      break;
    }
    case 'applet': {
      const label = getActiveAppletLabel();
      if (label) {
        title = `${baseTitle} ${label}`;
      }
      break;
    }
  }
  
  document.title = title;
}

/**
 * Check if we're in a specific state
 */
export function isViewState(state: ViewState): boolean {
  return currentState === state;
}

/**
 * Initialize view state from DOM (for page load)
 * Call this once during app initialization
 */
export function initViewState(): void {
  const els = getElements();
  
  // Detect initial state from DOM
  let detectedState: ViewState;
  if (els.sessionView?.classList.contains('active')) {
    detectedState = 'sessions';
  } else if (els.newChat && !els.newChat.classList.contains('hidden')) {
    detectedState = 'newChat';
  } else if (!els.appletPanel?.classList.contains('hidden')) {
    detectedState = 'applet';
  } else {
    detectedState = 'chatting';
  }
  
  // Force proper state by calling setViewState to clean up any inconsistencies
  currentState = detectedState === 'sessions' ? 'chatting' : 'sessions'; // Set to different state first
  setViewState(detectedState); // Now properly transition to detected state
}
