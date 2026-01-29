/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { scrollToBottom } from './ui-utils.js';
import { applyModelPreference, loadModels } from './model-selector.js';
import { initFromPreferences } from './app-state.js';
import { restoreOutputsFromHistory } from './display-output.js';
import { setLoadingHistory } from './response-streaming.js';
import { onHistoryComplete } from './websocket.js';

// Declare renderMarkdown as a global function from markdown-renderer.js
declare global {
  interface Window {
    renderMarkdown?: () => void;
  }
}

/**
 * Wait for history to stream via WebSocket
 * Assumes WS is already connected and streaming has started
 * The actual handling is done by registerWsHandlers() in response-streaming.ts
 */
export function waitForHistoryComplete(): Promise<void> {
  setLoadingHistory(true);
  
  // Clear existing chat before loading new history
  const chat = document.getElementById('chat');
  if (chat) {
    chat.innerHTML = '';
  }
  
  return new Promise<void>((resolve) => {
    const unsubscribe = onHistoryComplete(() => {
      unsubscribe();
      // Don't call setLoadingHistory(false) here - response-streaming handler does it
      // Just finish local tasks
      finishHistoryLoad();
      resolve();
    });
    
    // Timeout fallback (5 seconds)
    setTimeout(() => {
      unsubscribe();
      // Ensure we're not stuck in loading state on timeout
      setLoadingHistory(false);
      finishHistoryLoad();
      resolve();
    }, 5000);
  });
}

/**
 * Finish history loading (after WS streaming completes)
 * Does NOT change view state - that's handled by main.ts on page load
 * and by user actions (session clicks, applet links)
 */
function finishHistoryLoad(): void {
  const chat = document.getElementById('chat');
  
  if (chat && chat.children.length > 0) {
    if (typeof window.renderMarkdown === 'function') {
      window.renderMarkdown();
    }
    restoreOutputsFromHistory().catch(err => 
      console.error('Failed to restore outputs:', err)
    );
    scrollToBottom(true);
  } else {
    loadModels();
  }
}

/**
 * Load and apply user preferences
 * Returns the preferences (no side effects beyond initializing state)
 */
export async function loadPreferences(): Promise<Preferences | null> {
  try {
    const response = await fetch('/api/preferences');
    if (response.ok) {
      const prefs: Preferences = await response.json();
      
      // Initialize state from preferences
      initFromPreferences(prefs);
      
      // Apply model to UI (placeholder text)
      applyModelPreference(prefs);
      
      return prefs;
    }
  } catch (error) {
    console.error('Failed to load preferences:', error);
  }
  return null;
}
