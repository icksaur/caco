/**
 * View State Controller
 * 
 * SINGLE SOURCE OF TRUTH for which view is active.
 * Main panel: sessions | newChat | chatting (mutually exclusive)
 * Applet panel: shown/hidden (orthogonal, toggled separately)
 * 
 * All view transitions must go through setViewState() to prevent invalid states.
 * This manages VIEW state only. For session/model/UI flags, see app-state.ts.
 */

import { scrollToBottom } from './ui-utils.js';
import { clearActiveSession, getCurrentCwd } from './app-state.js';
import { getActiveAppletLabel } from './applet-runtime.js';
import { getServerHostname } from './hostname-hash.js';

/** Valid main panel states */
export type ViewState = 'sessions' | 'newChat' | 'chatting';

/** Current main panel state */
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
 * Get a cached DOM element by key
 * Use this instead of document.getElementById for commonly accessed elements
 */
export function getCachedElement(key: keyof ViewElements): HTMLElement | null {
  return getElements()[key];
}

/**
 * Get current view state
 */
export function getViewState(): ViewState {
  return currentState;
}

/**
 * Set the main panel view state
 * 
 * This atomically updates main panel DOM elements.
 * Applet panel visibility is managed separately via showAppletPanel/hideAppletPanel.
 */
export function setViewState(state: ViewState): void {
  const els = getElements();
  
  // Skip if already in this state
  if (state === currentState) return;
  
  currentState = state;

  // Reset main panel elements
  els.sessionView?.classList.remove('active');
  els.chat?.classList.add('hidden');
  els.newChat?.classList.add('hidden');
  els.footer?.classList.add('hidden');
  els.menuBtn?.classList.remove('active');

  // Apply state-specific classes
  switch (state) {
    case 'sessions':
      els.sessionView?.classList.add('active');
      els.menuBtn?.classList.add('active');
      // Hide applet button when sessions overlay is up
      els.appletBtn?.classList.add('hidden');
      break;
      
    case 'newChat':
      els.newChat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      // Clear session so messages don't go to old session
      clearActiveSession();
      // Show applet button
      els.appletBtn?.classList.remove('hidden');
      break;
      
    case 'chatting':
      els.chat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      // Scroll to bottom after view is painted
      requestAnimationFrame(() => scrollToBottom());
      // Show applet button
      els.appletBtn?.classList.remove('hidden');
      break;
  }
  
  // Update browser tab title
  updateTitle();
}

/**
 * Show the applet panel (orthogonal to main panel state)
 */
export function showAppletPanel(): void {
  const els = getElements();
  els.appletPanel?.classList.remove('hidden');
  els.appletBtn?.classList.remove('hidden');
  els.appletBtn?.classList.add('active');
  updateTitle();
}

/**
 * Hide the applet panel (but preserve its content)
 * Button stays visible so user can re-show the panel
 */
export function hideAppletPanel(): void {
  const els = getElements();
  els.appletPanel?.classList.add('hidden');
  els.appletBtn?.classList.remove('active');
  // Note: button stays visible - user can toggle panel back
  updateTitle();
}

/**
 * Check if applet panel is visible
 */
export function isAppletPanelVisible(): boolean {
  const els = getElements();
  return !els.appletPanel?.classList.contains('hidden');
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
  }
  
  // If applet is visible, show its label
  if (isAppletPanelVisible()) {
    const label = getActiveAppletLabel();
    if (label) {
      title = `${baseTitle} ${label}`;
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
  
  // Detect initial main panel state from DOM
  let detectedState: ViewState;
  if (els.sessionView?.classList.contains('active')) {
    detectedState = 'sessions';
  } else if (els.newChat && !els.newChat.classList.contains('hidden')) {
    detectedState = 'newChat';
  } else {
    detectedState = 'chatting';
  }
  
  // Force proper state by calling setViewState to clean up any inconsistencies
  currentState = detectedState === 'sessions' ? 'chatting' : 'sessions'; // Set to different state first
  setViewState(detectedState); // Now properly transition to detected state
}
