/**
 * History and preferences loading
 */

import type { Preferences } from './types.js';
import { applyModelPreference, loadModels } from './model-selector.js';
import { initFromPreferences } from './app-state.js';
import { setLoadingHistory } from './message-streaming.js';
import { setFormEnabled } from './view-controller.js';
import { onHistoryComplete } from './websocket.js';
import { clearContextFooter } from './context-footer.js';
import { regions } from './dom-regions.js';

/**
 * Wait for history to stream via WebSocket
 * Sets loadingHistory=true and clears chat.
 * 
 * During history loading, terminal events (session.idle) are guarded
 * from changing form state (see message-streaming.ts). The authoritative
 * busy state comes from the historyComplete message's isBusy flag.
 */
export function waitForHistoryComplete(): Promise<void> {
  setLoadingHistory(true);
  
  // Clear existing chat and context footer before loading new history
  regions.chat.clear();
  clearContextFooter();
  
  return new Promise<void>((resolve) => {
    const unsubscribe = onHistoryComplete((data) => {
      unsubscribe();
      setLoadingHistory(false);
      
      // Sync form/cursor state with session's actual busy status.
      // This is the authoritative state after history replay — overrides
      // any stale state from history terminal events or prior setFormEnabled calls.
      const isBusy = data?.isBusy ?? false;
      setFormEnabled(!isBusy);
      
      // If no messages loaded, show model selector
      if (regions.chat.el.children.length === 0) {
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
