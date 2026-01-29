/**
 * Centralized view state management
 * 
 * This module is the SINGLE SOURCE OF TRUTH for which view is active.
 * All view transitions must go through setViewState() to prevent invalid states.
 */

import { scrollToBottom } from './ui-utils.js';
import { clearActiveSession } from './app-state.js';

/** Valid application view states */
export type ViewState = 'sessions' | 'newChat' | 'chatting' | 'applet';

/** Current view state */
let currentState: ViewState = 'sessions';

/** Cached DOM element references */
interface ViewElements {
  chatView: HTMLElement | null;
  sessionView: HTMLElement | null;
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
      chatView: document.getElementById('chatView'),
      sessionView: document.getElementById('sessionView'),
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

  // Reset all elements to default (hidden/inactive)
  els.chatView?.classList.remove('active');
  els.sessionView?.classList.remove('active');
  els.appletView?.classList.remove('active');
  els.chat?.classList.add('hidden');
  els.newChat?.classList.add('hidden');
  els.footer?.classList.add('hidden');
  els.menuBtn?.classList.remove('active');
  els.appletBtn?.classList.add('hidden');
  els.appletBtn?.classList.remove('active');

  // Apply state-specific classes
  switch (state) {
    case 'sessions':
      els.sessionView?.classList.add('active');
      els.menuBtn?.classList.add('active');
      break;
      
    case 'newChat':
      els.chatView?.classList.add('active');
      els.newChat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      // Clear session so messages don't go to old session
      clearActiveSession();
      break;
      
    case 'chatting':
      els.chatView?.classList.add('active');
      els.chat?.classList.remove('hidden');
      els.footer?.classList.remove('hidden');
      els.appletBtn?.classList.remove('hidden');
      // Scroll to bottom after view is painted
      requestAnimationFrame(() => scrollToBottom());
      break;
      
    case 'applet':
      els.appletView?.classList.add('active');
      els.appletBtn?.classList.remove('hidden');
      els.appletBtn?.classList.add('active');
      break;
  }
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
  if (els.sessionView?.classList.contains('active')) {
    currentState = 'sessions';
  } else if (els.newChat && !els.newChat.classList.contains('hidden')) {
    currentState = 'newChat';
  } else {
    currentState = 'chatting';
  }
}
