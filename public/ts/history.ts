/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { applyModelPreference, loadModels } from './model-selector.js';
import { initFromPreferences } from './app-state.js';
import { setLoadingHistory } from './response-streaming.js';
import { onHistoryComplete } from './websocket.js';

/**
 * Wait for history to stream via WebSocket
 * Sets loadingHistory=true and clears chat.
 * All post-history work (renderMarkdown, restoreOutputs, scroll) 
 * is done in response-streaming.ts onHistoryComplete handler.
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
      // If no messages loaded, show model selector
      const chat = document.getElementById('chat');
      if (!chat || chat.children.length === 0) {
        loadModels();
      }
      resolve();
    });
  });
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
